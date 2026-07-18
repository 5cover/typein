#!/usr/bin/env node

import { Command, Option } from '@commander-js/extra-typings'
import { EmitHint } from 'typescript'
import { expr2ts } from './compile.js'
import * as emit from './emit.js'
import type { Expr } from './ir.js'
import { solve } from './solve.js'

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
    .option('--type-name <name>', 'generated TypeScript union name', 'Typestring')
    .option('--parameter-name <name>', 'generated predicate parameter name', 's')
    .parse()

const opts = program.opts()
const domain = program.args.length === 0 ? typestrings : program.args
const best = solve(domain, costCode)

switch (opts.language) {
    case 'ts':
        process.stdout.write(emit.tsModule(domain, best, opts.typeName, opts.parameterName))
        break
}

/// Source length, then token count, then alphabetical fallback.
export function costCode(a: Expr, b: Expr): number {
    const aN = expr2ts(a),
        bN = expr2ts(b),
        aS = emit.printer.printNode(EmitHint.Expression, aN, emit.sourceFile),
        bS = emit.printer.printNode(EmitHint.Expression, bN, emit.sourceFile)
    const c1 = aS.length - bS.length
    if (c1) return c1
    let aTokenCount = 0,
        bTokenCount = 0
    aN.forEachChild(
        () => aTokenCount++,
        n => (aTokenCount += n.length),
    )
    bN.forEachChild(
        () => bTokenCount++,
        n => (bTokenCount += n.length),
    )
    return (
        aTokenCount - bTokenCount ||
        (aS < bS ? -1
        : aS > bS ? 1
        : 0)
    )
}
