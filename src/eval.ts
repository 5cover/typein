import type { Expr, Feature } from './ir.js'
import { computeMask, maskToNames } from './mask.js'
import type { SolveResult } from './solve.js'
import type { Mask } from './types.js'

export type VerificationFailure = {
    mask: Mask
    actualMask: Mask
    expected: string[]
    actual: string[]
}

export function evalExpr(expr: Expr, value: string): boolean {
    if ('feature' in expr) return Boolean(evalFeature(value, expr.feature))

    switch (expr.type) {
        case 'not':
            return !evalExpr(expr.expr, value)
        case 'and':
            return evalExpr(expr.left, value) && evalExpr(expr.right, value)
        case 'or':
            return evalExpr(expr.left, value) || evalExpr(expr.right, value)
        case 'xor':
            return evalExpr(expr.left, value) !== evalExpr(expr.right, value)
    }
}

export function verifyResult(domain: readonly string[], result: SolveResult): VerificationFailure[] {
    const failures: VerificationFailure[] = []

    for (const [mask, expr] of result.best) {
        const actualMask = computeMask(domain, s => evalExpr(expr, s))
        if (actualMask === mask) continue
        failures.push({
            mask,
            actualMask,
            expected: maskToNames(domain, mask),
            actual: maskToNames(domain, actualMask),
        })
    }

    return failures
}

export type QueryVerificationFailure = {
    expected: string[]
    actual: string[]
}

export function verifyQuery(domain: readonly string[], targetValues: readonly string[], expr: Expr): QueryVerificationFailure | undefined {
    const targetValueSet = new Set(targetValues)
    const expected = domain.filter(value => targetValueSet.has(value))
    const actual = domain.filter(value => evalExpr(expr, value))

    if (expected.length === actual.length && expected.every((value, i) => value === actual[i])) return undefined

    return { expected, actual }
}

function evalFeature(parent: unknown, feat: Feature): unknown {
    const current = evalFeatureLevel(parent, feat)
    return feat.child ? evalFeature(current, feat.child) : current
}

function evalFeatureLevel(parent: unknown, feat: Feature): unknown {
    switch (feat.type) {
        case 'self':
            return parent
        case 'oneOf':
            return feat.args.values.includes(String(parent))
        case 'length':
            return String(parent).length
        case 'splitLength':
            return String(parent).split(feat.args.sep).length
        case 'charAt':
            return String(parent)[feat.args.n]
        case 'at':
            return String(parent).at(-feat.args['-n'])
        case 'charCodeAt':
            return String(parent).charCodeAt(feat.args.n)
        case 'startsWith':
            return String(parent).startsWith(feat.args.s)
        case 'startsWithAt':
            return String(parent).startsWith(feat.args.s, feat.args.n)
        case 'endsWith':
            return String(parent).endsWith(feat.args.s)
        case 'includes':
            return String(parent).includes(feat.args.value)
        case 'indexOf':
            return String(parent).indexOf(feat.args.value)
        case 'lastIndexOf':
            return String(parent).lastIndexOf(feat.args.value)
        case 'regexTest':
            return new RegExp(feat.args.source).test(String(parent))
        case '<':
            return compare(parent, '<', evalFeature(parent, feat.args))
        case '<=':
            return compare(parent, '<=', evalFeature(parent, feat.args))
        case '<>':
            return parent !== evalFeature(parent, feat.args)
        case '=':
            return parent === evalFeature(parent, feat.args)
        case '>':
            return compare(parent, '>', evalFeature(parent, feat.args))
        case '>=':
            return compare(parent, '>=', evalFeature(parent, feat.args))
        case 'and':
            return Boolean(parent) && Boolean(evalFeature(parent, feat.args))
        case 'or':
            return Boolean(parent) || Boolean(evalFeature(parent, feat.args))
        case 'if':
            return Boolean(parent) ? evalFeature(parent, feat.args.then) : evalFeature(parent, feat.args.else)
        case 'not':
            return !parent
        case 'lit':
            return feat.args
    }
}

function compare(left: unknown, op: '<' | '<=' | '>' | '>=', right: unknown): boolean {
    switch (op) {
        case '<':
            return (left as string | number) < (right as string | number)
        case '<=':
            return (left as string | number) <= (right as string | number)
        case '>':
            return (left as string | number) > (right as string | number)
        case '>=':
            return (left as string | number) >= (right as string | number)
    }
}
