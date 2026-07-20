import * as emit from './emit.js'
import { expr2ts } from './compile.js'
import type { Expr } from './ir.js'

export type CostCompare = {
    (a: Expr, b: Expr): number
    value?: (expr: Expr) => number
}

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

export function compactJsCostCode(a: Expr, b: Expr): number {
    const aCost = compactJsSourceCost(a)
    const bCost = compactJsSourceCost(b)
    const c1 = aCost.code.length - bCost.code.length
    if (c1) return c1
    return (
        aCost.tokenCount - bCost.tokenCount ||
        (aCost.code < bCost.code ? -1
        : aCost.code > bCost.code ? 1
        : 0)
    )
}

export function compactJsSourceLength(expr: Expr): number {
    return compactJsSourceCost(expr).code.length
}

costCode.value = sourceLength
compactJsCostCode.value = compactJsSourceLength

export function printExpression(expr: Expr, variable = 'x'): string {
    if (variable === 'x') return sourceCost(expr).code
    return emit.expression(expr, variable)
}

export function printCompactJsExpression(expr: Expr, variable = 'x'): string {
    return emit.expression(expr, {
        variable,
        language: 'js',
        equality: 'loose',
        createNonNullExpressions: false,
        format: 'minified',
    })
}

type SourceCost = {
    code: string
    tokenCount: number
}

const sourceCostCache = new WeakMap<Expr, SourceCost>()
const compactJsSourceCostCache = new WeakMap<Expr, SourceCost>()

function sourceCost(expr: Expr): SourceCost {
    const cached = sourceCostCache.get(expr)
    if (cached !== undefined) return cached

    const code = emit.expression(expr)
    const node = expr2ts(expr)
    let tokenCount = 0
    node.forEachChild(
        () => tokenCount++,
        n => (tokenCount += n.length),
    )

    const cost = { code, tokenCount }
    sourceCostCache.set(expr, cost)
    return cost
}

function compactJsSourceCost(expr: Expr): SourceCost {
    const cached = compactJsSourceCostCache.get(expr)
    if (cached !== undefined) return cached

    const code = emit.expression(expr, {
        language: 'js',
        equality: 'loose',
        createNonNullExpressions: false,
        format: 'minified',
    })
    const node = expr2ts(expr, {
        language: 'js',
        equality: 'loose',
        createNonNullExpressions: false,
    })
    let tokenCount = 0
    node.forEachChild(
        () => tokenCount++,
        n => (tokenCount += n.length),
    )

    const cost = { code, tokenCount }
    compactJsSourceCostCache.set(expr, cost)
    return cost
}
