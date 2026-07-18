#!/usr/bin/env node

import { Command, Option } from '@commander-js/extra-typings'
import * as emit from './emit.js'
import { solve } from './solve.js'
import { costComparators } from './cost.js'
import { coverageReport, interestReport } from './report.js'
import { verifyResult } from './eval.js'
import { builtinDomainNames, builtinDomains, type BuiltinDomainName } from './domains.js'

const supportedLanguages = ['ts'] as const
const supportedCosts = ['source'] as const

const program = new Command()
    .name('typein')
    .argument('[DOMAIN...]', 'strings to analyze')
    .addOption(
        new Option('-b, --builtin <name>', 'add strings from a builtin domain')
            .choices(builtinDomainNames)
            .argParser((name, previous: BuiltinDomainName[] = []) => [...previous, name as BuiltinDomainName]),
    )
    .option('--list-builtins', 'list builtin domain names')
    .addOption(
        new Option('-l, --language <language>', 'output language')
            .choices(supportedLanguages)
            .default('ts' as const),
    )
    .addOption(new Option('--cost <name>', 'cost comparison function').choices(supportedCosts).default('source' as const))
    .option('--report', 'write coverage and interest reports to stderr')
    .option('--test', 'verify generated expressions against their masks')
    .option('--type-name <name>', 'generated TypeScript union name', 'Domain')
    .option('--parameter-name <name>', 'generated predicate parameter name', 's')
    .option('--guard-key <name>', 'registry leaf key for type guard functions', 'is')
    .parse()

const opts = program.opts()
if (opts.listBuiltins) {
    for (const name of builtinDomainNames) process.stdout.write(`${name}\n`)
    process.exit(0)
}

const domain = resolveDomain(program.args, opts.builtin ?? [])
validateDomain(domain, opts.guardKey)
const result = solve(domain, costComparators[opts.cost])

if (opts.report) {
    process.stderr.write(`${coverageReport(domain, result)}\n\n${interestReport(domain, result)}\n`)
}

if (opts.test) {
    const failures = verifyResult(domain, result)
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
    case 'ts':
        process.stdout.write(emit.tsModule(domain, result.best, opts.typeName, opts.parameterName, opts.guardKey))
        break
}

function resolveDomain(positional: readonly string[], builtins: readonly BuiltinDomainName[]): string[] {
    const parts: string[] =
        positional.length === 0 && builtins.length === 0
            ? [...builtinDomains.typeof]
            : [...builtins.flatMap(name => builtinDomains[name]), ...positional]

    return [...new Set(parts)]
}

function validateDomain(domain: readonly string[], guardKey: string) {
    if (domain.includes(guardKey)) {
        program.error(`domain value "${guardKey}" conflicts with the generated registry guard key; use --guard-key to choose another key`)
    }

    if (domain.length > 30) {
        program.error('domains larger than 30 values are not supported by the current numeric mask representation')
    }
}
