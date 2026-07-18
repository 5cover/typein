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
    const aCost = sourceCost(a)
    const bCost = sourceCost(b)
    const c1 = aCost.code.length - bCost.code.length
    if (c1) return c1
    return (
        aCost.tokenCount - bCost.tokenCount ||
        (aCost.code < bCost.code ? -1
        : aCost.code > bCost.code ? 1
        : 0)
    )
}

export function costCodeValue(expr: Expr): number {
    return sourceCost(expr).code.length
}

export function sourceLength(expr: Expr): number {
    return sourceCost(expr).code.length
}

export function printExpression(expr: Expr, variable = 'x'): string {
    if (variable === 'x') return sourceCost(expr).code
    return emit.printer.printNode(EmitHint.Expression, expr2ts(expr, variable), emit.sourceFile)
}

type SourceCost = {
    code: string
    tokenCount: number
}

const sourceCostCache = new WeakMap<Expr, SourceCost>()

function sourceCost(expr: Expr): SourceCost {
    const cached = sourceCostCache.get(expr)
    if (cached !== undefined) return cached

    const node = expr2ts(expr)
    const code = emit.printer.printNode(EmitHint.Expression, node, emit.sourceFile)
    let tokenCount = 0
    node.forEachChild(
        () => tokenCount++,
        n => (tokenCount += n.length),
    )

    const cost = { code, tokenCount }
    sourceCostCache.set(expr, cost)
    return cost
}
