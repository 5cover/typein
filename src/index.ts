#!/usr/bin/env node

import { Command, InvalidArgumentError, Option, type OptionValues } from '@commander-js/extra-typings'
import * as emit from './emit.js'
import {
    defaultQueryFeatures,
    defaultQueryLimits,
    solve,
    solveQuery,
    type QueryFeatures,
    type QueryLimits,
} from './solve.js'
import { costComparators, printExpression, sourceLength } from './cost.js'
import { coverageReport, interestReport, profileReport, queryProfileReport, queryReport } from './report.js'
import { verifyQuery, verifyResult } from './eval.js'
import { builtinDomainNames, builtinDomains, type BuiltinDomainName } from './domains.js'
import { performance } from 'node:perf_hooks'
import { readFileSync, writeFileSync } from 'node:fs'
import { getMinifier, minifierNames, minifyReport } from './minify.js'

const supportedLanguages = ['ts'] as const
const supportedCosts = ['source'] as const

const program = new Command('typein')
    .description('Generate TypeScript type guards for string domains')
    .addOption(
        new Option('-b, --builtin <name>', 'add strings from a builtin domain')
            .choices(builtinDomainNames)
            .argParser((name, previous: BuiltinDomainName[] = []) => [...previous, name as BuiltinDomainName]),
    )
    .option('-d, --domain <value>', 'add one string to the input domain', collect)
    .addOption(
        new Option('-l, --language <language>', 'output language').choices(supportedLanguages).default('ts' as const),
    )
    .addOption(
        new Option('--cost <name>', 'cost comparison function').choices(supportedCosts).default('source' as const),
    )
    .option('--report', 'write search reporting to stderr')
    .option('--profile', 'write timing and search profile to stderr')
    .option('--test', 'verify generated expressions against their promised partition')
    .option('--type-name <name>', 'generated TypeScript union name', 'Domain')
    .option('--define-type', 'Also define the domain type in input')
    .option('--parameter-name <name>', 'generated predicate parameter name', 's')

program
    .command('list-builtins')
    .description('list builtin domain names')
    .action(() => {
        for (const name of builtinDomainNames) console.log(name)
    })

program
    .command('domain')
    .description('output domain values')
    .action((_, c) => {
        const domain = resolveDomain(c.optsWithGlobals())
        console.log(domain.join('\n'))
        console.error('size:', domain.length)
    })

program
    .command('all')
    .description('emit guards for every non-empty, non-full partition')
    .option('--guard-key <name>', 'registry leaf key for type guards', 'is')
    .action((_, c) => runAll(c.optsWithGlobals()))

queryCommand('for')
    .description('emit a guard for one target partition')
    .argument('<targetValues...>')
    .action((targetValues, _, c) => runFor(targetValues, c.optsWithGlobals() as CommonOptions & QueryOptionValues))

queryCommand('bench-css-query')
    .description('run the CSS query benchmark ladder')
    .action((_, c) => runBenchCssQuery(c.optsWithGlobals()))

queryCommand('test')
    .description('transient test')
    .action((_, c) => {
        const domain = builtinDomains['css-properties']
        runFor(
            domain.filter(
                s =>
                    (s.startsWith('margin-') || s.startsWith('padding-') || s.startsWith('inset-')) &&
                    (s.endsWith('-start') || s.endsWith('-end')),
            ),
            { ...(c.optsWithGlobals() as CommonOptions & QueryOptionValues), domain },
        )
    })

addQueryOptions(program.command('minify'))
    .description('run source minifiers')
    .argument('<input>')
    .argument('<minifiers...>')
    .option('-i, --in-place', 'rewrite the input file in place')
    .action((input, minifiers, opts, c) =>
        runMinify(input, minifiers, c.optsWithGlobals() as MinifyOptions & QueryOptionValues),
    )

function queryCommand(name: string) {
    return addQueryOptions(program.command(name))
}

function addQueryOptions(command: Command) {
    return command
        .option(
            '--query-or-states <count>',
            'maximum OR-cover states to visit',
            parsePositiveInteger,
            defaultQueryLimits.orStates,
        )
        .option(
            '--query-and-states <count>',
            'maximum AND-filter states to visit',
            parsePositiveInteger,
            defaultQueryLimits.andStates,
        )
        .option(
            '--query-superset-pre-frontier <count>',
            'maximum superset atoms before dominance reduction',
            parsePositiveInteger,
            defaultQueryLimits.supersetPreFrontier,
        )
        .option(
            '--query-superset-frontier <count>',
            'maximum superset atoms after dominance reduction',
            parsePositiveInteger,
            defaultQueryLimits.supersetFrontier,
        )
        .option(
            '--query-dnf-frontier <count>',
            'maximum superset atoms used for pairwise DNF terms',
            parsePositiveInteger,
            defaultQueryLimits.dnfFrontier,
        )
        .option('--query-multiplier <n>', 'multiply all limit by this', parsePositiveInteger, 1)
        .option('--query-regex', 'allow regex-backed query candidates', defaultQueryFeatures.allowRegex)
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value]
}

function parsePositiveInteger(value: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new InvalidArgumentError(`expected a positive integer, got "${value}"`)
    return parsed
}

function runAll(opts: CommonOptions & { guardKey: string }) {
    const domain = resolveDomain(opts)
    validateEnumeratedDomain(domain, opts.guardKey)

    const totalStart = performance.now()
    const solveStart = performance.now()
    const result = solve(domain, costComparators[opts.cost])
    const solveMs = performance.now() - solveStart

    let reportMs = 0
    let verifyMs = 0
    let emitMs = 0

    if (opts.report) {
        const reportStart = performance.now()
        console.error(`${coverageReport(domain, result)}\n\n${interestReport(domain, result)}`)
        reportMs = performance.now() - reportStart
    }

    if (opts.test) {
        const verifyStart = performance.now()
        const failures = verifyResult(domain, result)
        verifyMs = performance.now() - verifyStart
        if (failures.length > 0) {
            for (const failure of failures) {
                console.error(
                    [
                        `mask ${failure.mask} verified as ${failure.actualMask}`,
                        `  expected: ${failure.expected.join(', ')}`,
                        `  actual:   ${failure.actual.join(', ')}`,
                    ].join('\n'),
                )
            }
            process.exitCode = 1
        } else {
            console.error(`verified ${result.best.size} expressions against ${domain.length} inputs`)
        }
    }

    switch (opts.language) {
        case 'ts': {
            const emitStart = performance.now()
            console.log(emit.tsModule(domain, result.best, opts))
            emitMs = performance.now() - emitStart
            break
        }
    }

    if (opts.profile) {
        console.error(
            `${profileReport(result, {
                totalMs: performance.now() - totalStart,
                solveMs,
                reportMs,
                verifyMs,
                emitMs,
            })}\n`,
        )
    }
}

function runFor(targetValues: readonly string[], opts: CommonOptions & QueryOptionValues) {
    const domain = resolveDomain(opts)
    const targets = unique(targetValues)
    validateQuery(domain, targets)

    const totalStart = performance.now()
    const solveStart = performance.now()
    const result = solveQuery(
        domain,
        targets,
        costComparators[opts.cost],
        queryLimitsFromOptions(opts),
        queryFeaturesFromOptions(opts),
    )
    const solveMs = performance.now() - solveStart

    let reportMs = 0
    let verifyMs = 0
    let emitMs = 0

    if (opts.report) {
        const reportStart = performance.now()
        console.error(queryReport(domain, result))
        reportMs = performance.now() - reportStart
    }

    if (opts.test) {
        const verifyStart = performance.now()
        const failure = verifyQuery(domain, targets, result.expr)
        verifyMs = performance.now() - verifyStart
        if (failure !== undefined) {
            console.error(
                [
                    `query verified incorrectly`,
                    `  expected: ${failure.expected.join(', ')}`,
                    `  actual:   ${failure.actual.join(', ')}`,
                ].join('\n'),
            )
            process.exitCode = 1
        } else {
            console.error(`verified query expression against ${domain.length} inputs`)
        }
    }

    switch (opts.language) {
        case 'ts': {
            const emitStart = performance.now()
            console.log(emit.tsGuardModule(domain, targets, result.expr, opts))
            emitMs = performance.now() - emitStart
            break
        }
    }

    if (opts.profile) {
        console.error(
            queryProfileReport(result, {
                totalMs: performance.now() - totalStart,
                solveMs,
                reportMs,
                verifyMs,
                emitMs,
            }),
        )
    }
}

function runBenchCssQuery(opts: BenchOptions & QueryOptionValues) {
    const domain = builtinDomains['css-properties']
    const baseLimits = queryLimitsFromOptions(opts)
    const rows: string[][] = []

    for (const benchmark of cssQueryBenchmarks) {
        let limits = baseLimits

        for (;;) {
            const totalStart = performance.now()
            const solveStart = performance.now()
            const result = solveQuery(
                domain,
                benchmark.targets,
                costComparators.source,
                limits,
                queryFeaturesFromOptions(opts),
            )
            const solveMs = performance.now() - solveStart
            const totalMs = performance.now() - totalStart
            const fallbackCost = fallbackSourceLength(benchmark.targets)
            const resultCost = sourceLength(result.expr)
            const improved = resultCost < fallbackCost

            if (opts.report) console.error(`\n# ${benchmark.name}\n${queryReport(domain, result)}`)
            if (opts.profile) {
                console.error(
                    queryProfileReport(result, {
                        totalMs,
                        solveMs,
                        reportMs: 0,
                        verifyMs: 0,
                        emitMs: 0,
                    }),
                )
            }

            if (opts.test) {
                const failure = verifyQuery(domain, benchmark.targets, result.expr)
                if (failure !== undefined) {
                    console.error(
                        [
                            `benchmark "${benchmark.name}" verified incorrectly`,
                            `  expected: ${failure.expected.join(', ')}`,
                            `  actual:   ${failure.actual.join(', ')}`,
                        ].join('\n'),
                    )
                    process.exitCode = 1
                }
            }

            rows.push([
                benchmark.name,
                benchmark.targets.length.toString(),
                limitsLabel(limits),
                formatMs(totalMs),
                improved ? 'yes' : 'no',
                result.profile.proof,
                result.profile.orStateLimitHit || result.profile.andStateLimitHit ? 'yes' : 'no',
                code(printExpression(result.expr, 's')),
            ])

            if (improved || totalMs > 10_000) break
            limits = doubleQueryLimits(limits)
        }
    }

    console.error(
        [
            '## CSS Query Benchmark',
            markdownTable(['query', 'targets', 'limits', 'ms', 'improved', 'proof', 'limit hit', 'expression'], rows),
            '',
        ].join('\n'),
    )
}

function runMinify(input: string, names: readonly string[], opts: MinifyOptions & QueryOptionValues) {
    let source = readFileSync(input, 'utf8')
    const reports: string[] = []

    names.forEach((name, index) => {
        const minifier = getMinifier(name)
        if (minifier === undefined) {
            program.error(`unknown minifier "${name}"; supported minifiers: ${minifierNames.join(', ')}`)
            return
        }

        const inputLength = source.length
        const start = performance.now()
        const result = minifier.run(source, {
            cost: opts.cost,
            queryLimits: queryLimitsFromOptions(opts),
            queryFeatures: queryFeaturesFromOptions(opts),
            report: opts.report,
        })
        const elapsed = performance.now() - start
        source = result.code

        if (opts.report) {
            reports.push(
                minifyReport(
                    index + 1,
                    name,
                    inputLength,
                    result.code.length,
                    [
                        opts.profile ? `| phase | ms |\n| --- | --- |\n| minifier | ${formatMs(elapsed)} |` : '',
                        result.report ?? '',
                    ]
                        .filter(Boolean)
                        .join('\n\n'),
                ),
            )
        }
    })

    if (opts.inPlace) writeFileSync(input, source)
    else console.log(source)

    if (reports.length > 0) console.error(reports.join('\n\n'))
}

type CommonOptions = {
    builtin?: BuiltinDomainName[]
    domain?: string[]
    language: 'ts'
    cost: 'source'
    report?: boolean
    profile?: boolean
    test?: boolean
    defineType?: boolean
    typeName: string
    parameterName: string
}

type MinifyOptions = CommonOptions & {
    inPlace?: boolean
}

type QueryOptionValues = {
    queryOrStates: number
    queryAndStates: number
    querySupersetPreFrontier: number
    querySupersetFrontier: number
    queryDnfFrontier: number
    queryRegex: boolean
    queryMultiplier: number
}

function queryLimitsFromOptions(opts: QueryOptionValues): QueryLimits {
    const m = opts.queryMultiplier
    return {
        orStates: m * opts.queryOrStates,
        andStates: m * opts.queryAndStates,
        supersetPreFrontier: m * opts.querySupersetPreFrontier,
        supersetFrontier: m * opts.querySupersetFrontier,
        dnfFrontier: m * opts.queryDnfFrontier,
    }
}

function queryFeaturesFromOptions(opts: QueryOptionValues): QueryFeatures {
    return {
        allowRegex: opts.queryRegex,
    }
}

function resolveDomain(opts: CommonOptions): string[] {
    const values: string[] = [
        ...(opts.builtin?.length ? opts.builtin.flatMap(name => builtinDomains[name]) : []),
        ...(opts.domain?.length ? opts.domain : []),
    ]
    return values.length ? unique(values) : [...builtinDomains.typeof]
}

function validateEnumeratedDomain(domain: readonly string[], guardKey: string) {
    if (domain.includes(guardKey)) {
        program.error(
            `domain value "${guardKey}" conflicts with the generated registry guard key; use --guard-key to choose another key`,
        )
    }

    if (domain.length > 30) {
        program.error('domains larger than 30 values are not supported by exhaustive enumeration')
    }
}

function validateQuery(domain: readonly string[], targetValues: readonly string[]) {
    if (targetValues.length === 0) program.error('typein for requires at least one target value')

    const domainSet = new Set(domain)
    for (const value of targetValues) {
        if (!domainSet.has(value)) program.error(`target value "${value}" is not in the input domain`)
    }
}

function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)]
}

type BenchOptions = {
    report?: boolean
    profile?: boolean
    test?: boolean
}

const cssQueryBenchmarks = [
    {
        name: 'margin pair',
        targets: ['margin', 'margin-top'],
    },
    {
        name: 'margin box',
        targets: ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    },
    {
        name: 'border color',
        targets: ['border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
    },
    {
        name: 'inline margin padding',
        targets: [
            'margin-inline',
            'margin-inline-start',
            'margin-inline-end',
            'padding-inline',
            'padding-inline-start',
            'padding-inline-end',
        ],
    },
    {
        name: 'wide scatter',
        targets: [
            'accent-color',
            'align-content',
            'backdrop-filter',
            'border-image-source',
            'caret-color',
            'clip-path',
            'color-scheme',
            'column-rule-width',
            'contain-intrinsic-size',
            'counter-reset',
            'font-variation-settings',
            'grid-template-areas',
            'hyphenate-character',
            'image-rendering',
            'inset-inline-start',
            'mask-composite',
            'mix-blend-mode',
            'offset-rotate',
            'overflow-anchor',
            'perspective-origin',
            'scroll-snap-type',
            'shape-outside',
            'text-decoration-skip-ink',
            'view-transition-name',
        ],
    },
] as const

function fallbackSourceLength(targets: readonly string[]): number {
    return targets.map(target => `x === ${JSON.stringify(target)}`).join(' || ').length
}

function doubleQueryLimits(limits: QueryLimits): QueryLimits {
    return {
        orStates: limits.orStates * 2,
        andStates: limits.andStates * 2,
        supersetPreFrontier: limits.supersetPreFrontier * 2,
        supersetFrontier: limits.supersetFrontier * 2,
        dnfFrontier: limits.dnfFrontier * 2,
    }
}

function limitsLabel(limits: QueryLimits): string {
    return [
        limits.orStates,
        limits.andStates,
        limits.supersetPreFrontier,
        limits.supersetFrontier,
        limits.dnfFrontier,
    ].join('/')
}

function formatMs(value: number): string {
    return value.toFixed(1)
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    ].join('\n')
}

function escapeMarkdownCell(value: string): string {
    return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function code(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``
}

program.parse()
