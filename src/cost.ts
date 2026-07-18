import { EmitHint } from 'typescript'
import { expr2ts } from './compile.js'
import * as emit from './emit.js'
import type { Expr } from './ir.js'

export type CostCompare = (a: Expr, b: Expr) => number

export const costComparators = {
    source: costCode,
} as const

export type CostName = keyof typeof costComparators

/// Source length, then token count, then alphabetical fallback.
export function costCode(a: Expr, b: Expr): number {
    const aN = expr2ts(a),
        bN = expr2ts(b),
        aS = printExpression(a),
        bS = printExpression(b)
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

export function costCodeValue(expr: Expr): number {
    return printExpression(expr).length
}

export function printExpression(expr: Expr, variable = 'x'): string {
    return emit.printer.printNode(EmitHint.Expression, expr2ts(expr, variable), emit.sourceFile)
}
