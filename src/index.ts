#!/usr/bin/env node

import { Command, InvalidArgumentError, Option, type OptionValues } from '@commander-js/extra-typings'
import * as emit from './emit.js'
import { defaultQueryLimits, solve, solveQuery, type QueryLimits } from './solve.js'
import { costComparators, printExpression, sourceLength } from './cost.js'
import { coverageReport, interestReport, profileReport, queryProfileReport, queryReport } from './report.js'
import { verifyQuery, verifyResult } from './eval.js'
import { builtinDomainNames, builtinDomains, type BuiltinDomainName } from './domains.js'
import { performance } from 'node:perf_hooks'

const supportedLanguages = ['ts'] as const
const supportedCosts = ['source'] as const

const program = new Command()
    .name('typein')
    .description('Generate TypeScript type guards for string domains')
    .option('--list-builtins', 'list builtin domain names')
    .action(opts => {
        if (opts.listBuiltins) listBuiltins()
        program.help()
    })

const allCommand = addCommonOptions(
    new Command('all')
        .description('emit guards for every non-empty, non-full partition')
        .option('--guard-key <name>', 'registry leaf key for type guards', 'is'),
).action(opts => {
    runAll(opts as unknown as CommonOptions & { guardKey: string })
})

const forCommand = addQueryOptions(
    addCommonOptions(new Command('for').description('emit a guard for one target partition').argument('<targetValues...>')),
).action((targetValues, opts) => {
    runFor(targetValues, opts as unknown as CommonOptions & QueryOptionValues)
})

const benchCssQueryCommand = addQueryOptions(
    new Command('bench-css-query')
        .description('run the CSS query benchmark ladder')
        .option('--report', 'write per-run query family reporting to stderr')
        .option('--profile', 'write per-run timing and search profile to stderr')
        .option('--test', 'verify each synthesized expression against the CSS property domain'),
).action(opts => {
    runBenchCssQuery(opts as unknown as BenchOptions & QueryOptionValues)
})

program.addCommand(allCommand)
program.addCommand(forCommand)
program.addCommand(benchCssQueryCommand)

program.parse()

function addCommonOptions<Args extends any[], Opts extends OptionValues, GlobalOpts extends OptionValues>(
    command: Command<Args, Opts, GlobalOpts>,
) {
    return command
        .addOption(builtinOption())
        .option('-d, --domain <value>', 'add one string to the input domain', collect)
        .option('--list-builtins', 'list builtin domain names')
        .addOption(
            new Option('-l, --language <language>', 'output language')
                .choices(supportedLanguages)
                .default('ts' as const),
        )
        .addOption(new Option('--cost <name>', 'cost comparison function').choices(supportedCosts).default('source' as const))
        .option('--report', 'write search reporting to stderr')
        .option('--profile', 'write timing and search profile to stderr')
        .option('--test', 'verify generated expressions against their promised partition')
        .option('--type-name <name>', 'generated TypeScript union name', 'Domain')
        .option('--parameter-name <name>', 'generated predicate parameter name', 's')
}

function builtinOption(): Option {
    return new Option('-b, --builtin <name>', 'add strings from a builtin domain')
        .choices(builtinDomainNames)
        .argParser((name, previous: BuiltinDomainName[] = []) => [...previous, name as BuiltinDomainName])
}

function addQueryOptions<Args extends any[], Opts extends OptionValues, GlobalOpts extends OptionValues>(
    command: Command<Args, Opts, GlobalOpts>,
) {
    return command
        .option('--query-or-states <count>', 'maximum OR-cover states to visit', parsePositiveInteger, defaultQueryLimits.orStates)
        .option('--query-and-states <count>', 'maximum AND-filter states to visit', parsePositiveInteger, defaultQueryLimits.andStates)
        .option(
            '--query-superset-pre-frontier <count>',
            'maximum superset atoms before dominance reduction',
            parsePositiveInteger,
            defaultQueryLimits.supersetPreFrontier,
        )
        .option('--query-superset-frontier <count>', 'maximum superset atoms after dominance reduction', parsePositiveInteger, defaultQueryLimits.supersetFrontier)
        .option('--query-dnf-frontier <count>', 'maximum superset atoms used for pairwise DNF terms', parsePositiveInteger, defaultQueryLimits.dnfFrontier)
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value]
}

function parsePositiveInteger(value: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InvalidArgumentError(`expected a positive integer, got "${value}"`)
    return parsed
}

function listBuiltins(): never {
    for (const name of builtinDomainNames) process.stdout.write(`${name}\n`)
    process.exit(0)
}

function runAll(opts: CommonOptions & { guardKey: string }) {
    if (opts.listBuiltins) listBuiltins()

    const domain = resolveDomain(opts.builtin ?? [], opts.domain ?? [])
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
        process.stderr.write(`${coverageReport(domain, result)}\n\n${interestReport(domain, result)}\n`)
        reportMs = performance.now() - reportStart
    }

    if (opts.test) {
        const verifyStart = performance.now()
        const failures = verifyResult(domain, result)
        verifyMs = performance.now() - verifyStart
        if (failures.length > 0) {
            for (const failure of failures) {
                process.stderr.write(
                    [
                        `mask ${failure.mask} verified as ${failure.actualMask}`,
                        `  expected: ${failure.expected.join(', ')}`,
                        `  actual:   ${failure.actual.join(', ')}`,
                    ].join('\n') + '\n',
                )
            }
            process.exitCode = 1
        } else {
            process.stderr.write(`verified ${result.best.size} expressions against ${domain.length} inputs\n`)
        }
    }

    switch (opts.language) {
        case 'ts': {
            const emitStart = performance.now()
            process.stdout.write(emit.tsModule(domain, result.best, opts.typeName, opts.parameterName, opts.guardKey))
            emitMs = performance.now() - emitStart
            break
        }
    }

    if (opts.profile) {
        process.stderr.write(
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
    if (opts.listBuiltins) listBuiltins()

    const domain = resolveDomain(opts.builtin ?? [], opts.domain ?? [])
    const targets = unique(targetValues)
    validateQuery(domain, targets)

    const totalStart = performance.now()
    const solveStart = performance.now()
    const result = solveQuery(domain, targets, costComparators[opts.cost], queryLimitsFromOptions(opts))
    const solveMs = performance.now() - solveStart

    let reportMs = 0
    let verifyMs = 0
    let emitMs = 0

    if (opts.report) {
        const reportStart = performance.now()
        process.stderr.write(`${queryReport(domain, result)}\n`)
        reportMs = performance.now() - reportStart
    }

    if (opts.test) {
        const verifyStart = performance.now()
        const failure = verifyQuery(domain, targets, result.expr)
        verifyMs = performance.now() - verifyStart
        if (failure !== undefined) {
            process.stderr.write(
                [`query verified incorrectly`, `  expected: ${failure.expected.join(', ')}`, `  actual:   ${failure.actual.join(', ')}`].join(
                    '\n',
                ) + '\n',
            )
            process.exitCode = 1
        } else {
            process.stderr.write(`verified query expression against ${domain.length} inputs\n`)
        }
    }

    switch (opts.language) {
        case 'ts': {
            const emitStart = performance.now()
            process.stdout.write(emit.tsGuardModule(domain, targets, result.expr, opts.typeName, opts.parameterName))
            emitMs = performance.now() - emitStart
            break
        }
    }

    if (opts.profile) {
        process.stderr.write(
            `${queryProfileReport(result, {
                totalMs: performance.now() - totalStart,
                solveMs,
                reportMs,
                verifyMs,
                emitMs,
            })}\n`,
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
            const result = solveQuery(domain, benchmark.targets, costComparators.source, limits)
            const solveMs = performance.now() - solveStart
            const totalMs = performance.now() - totalStart
            const fallbackCost = fallbackSourceLength(benchmark.targets)
            const resultCost = sourceLength(result.expr)
            const improved = resultCost < fallbackCost

            if (opts.report) process.stderr.write(`\n# ${benchmark.name}\n${queryReport(domain, result)}\n`)
            if (opts.profile) {
                process.stderr.write(
                    `${queryProfileReport(result, {
                        totalMs,
                        solveMs,
                        reportMs: 0,
                        verifyMs: 0,
                        emitMs: 0,
                    })}\n`,
                )
            }

            if (opts.test) {
                const failure = verifyQuery(domain, benchmark.targets, result.expr)
                if (failure !== undefined) {
                    process.stderr.write(
                        [
                            `benchmark "${benchmark.name}" verified incorrectly`,
                            `  expected: ${failure.expected.join(', ')}`,
                            `  actual:   ${failure.actual.join(', ')}`,
                        ].join('\n') + '\n',
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

    process.stderr.write(
        [
            '## CSS Query Benchmark',
            markdownTable(['query', 'targets', 'limits', 'ms', 'improved', 'proof', 'limit hit', 'expression'], rows),
            '',
        ].join('\n'),
    )
}

type CommonOptions = {
    builtin?: BuiltinDomainName[]
    domain?: string[]
    listBuiltins?: boolean
    language: 'ts'
    cost: 'source'
    report?: boolean
    profile?: boolean
    test?: boolean
    typeName: string
    parameterName: string
}

type QueryOptionValues = {
    queryOrStates: number
    queryAndStates: number
    querySupersetPreFrontier: number
    querySupersetFrontier: number
    queryDnfFrontier: number
}

function queryLimitsFromOptions(opts: QueryOptionValues): QueryLimits {
    return {
        orStates: opts.queryOrStates,
        andStates: opts.queryAndStates,
        supersetPreFrontier: opts.querySupersetPreFrontier,
        supersetFrontier: opts.querySupersetFrontier,
        dnfFrontier: opts.queryDnfFrontier,
    }
}

function resolveDomain(builtins: readonly BuiltinDomainName[], explicitValues: readonly string[]): string[] {
    const parts: string[] =
        builtins.length === 0 && explicitValues.length === 0
            ? [...builtinDomains.typeof]
            : [...builtins.flatMap(name => builtinDomains[name]), ...explicitValues]

    return unique(parts)
}

function validateEnumeratedDomain(domain: readonly string[], guardKey: string) {
    if (domain.includes(guardKey)) {
        program.error(`domain value "${guardKey}" conflicts with the generated registry guard key; use --guard-key to choose another key`)
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
        targets: ['margin-inline', 'margin-inline-start', 'margin-inline-end', 'padding-inline', 'padding-inline-start', 'padding-inline-end'],
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
    return [limits.orStates, limits.andStates, limits.supersetPreFrontier, limits.supersetFrontier, limits.dnfFrontier].join('/')
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
