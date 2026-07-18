import ts, { EmitHint } from 'typescript'
import { expr2ts } from './compile.js'
import * as emit from './emit.js'
import type { Expr } from './ir.js'
import { solve } from './solve.js'

const typestrings = ['bigint', 'boolean', 'function', 'number', 'object', 'string', 'symbol', 'undefined'] as const
const best = solve(typestrings, costCode)
console.log(emit.tsModule(typestrings, best, 'Typestring'))

/// Source length, then token count, then alphebetical fallback.
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
