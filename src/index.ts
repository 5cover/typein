#!/usr/bin/env node

import { Command, Option, type OptionValues } from '@commander-js/extra-typings'
import * as emit from './emit.js'
import { solve, solveQuery } from './solve.js'
import { costComparators } from './cost.js'
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

const forCommand = addCommonOptions(
    new Command('for').description('emit a guard for one target partition').argument('<targetValues...>'),
).action((targetValues, opts) => {
    runFor(targetValues, opts as unknown as CommonOptions)
})

program.addCommand(allCommand)
program.addCommand(forCommand)

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

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value]
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

function runFor(targetValues: readonly string[], opts: CommonOptions) {
    if (opts.listBuiltins) listBuiltins()

    const domain = resolveDomain(opts.builtin ?? [], opts.domain ?? [])
    const targets = unique(targetValues)
    validateQuery(domain, targets)

    const totalStart = performance.now()
    const solveStart = performance.now()
    const result = solveQuery(domain, targets, costComparators[opts.cost])
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
