#!/usr/bin/env node

import { Command, Option } from '@commander-js/extra-typings'
import * as emit from './emit.js'
import { solve } from './solve.js'
import { costComparators } from './cost.js'
import { coverageReport, interestReport } from './report.js'
import { verifyResult } from './eval.js'

const typestrings = ['bigint', 'boolean', 'function', 'number', 'object', 'string', 'symbol', 'undefined'] as const
const supportedLanguages = ['ts'] as const
const supportedCosts = ['source'] as const

const program = new Command()
    .name('typein')
    .argument('[DOMAIN...]', 'strings to analyze')
    .addOption(
        new Option('-l, --language <language>', 'output language')
            .choices(supportedLanguages)
            .default('ts' as const),
    )
    .addOption(new Option('--cost <name>', 'cost comparison function').choices(supportedCosts).default('source' as const))
    .option('--report', 'write coverage and interest reports to stderr')
    .option('--test', 'verify generated expressions against their masks')
    .option('--type-name <name>', 'generated TypeScript union name', 'Typestring')
    .option('--parameter-name <name>', 'generated predicate parameter name', 's')
    .parse()

const opts = program.opts()
const domain = program.args.length === 0 ? typestrings : program.args
validateDomain(domain)
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
        process.stdout.write(emit.tsModule(domain, result.best, opts.typeName, opts.parameterName))
        break
}

function validateDomain(domain: readonly string[]) {
    if (new Set(domain).size !== domain.length) {
        program.error('domain values must be unique')
    }

    if (domain.length > 30) {
        program.error('domains larger than 30 values are not supported by the current numeric mask representation')
    }
}
