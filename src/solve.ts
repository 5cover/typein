import { negateInPlace, type Expr } from './ir.js'
import { computeMask } from './mask.js'
import type { Mask } from './types.js'

type Candidate = { expr: Expr; mask: Mask; family: string }
type RelationalOp = '<' | '<=' | '>' | '>='
type ComparisonOp = RelationalOp | '='

export type SolveResult = {
    best: Map<Mask, Expr>
    primitiveFamilyMasks: Map<string, Set<Mask>>
    primitiveMasks: Set<Mask>
    withComplements: Set<Mask>
    targetMaskCount: number
    fullMask: Mask
}

export function solve<const Domain extends string>(
    domain: readonly Domain[],
    exprCostCompare: (a: Expr, b: Expr) => number,
): SolveResult {
    const best = new Map<Mask, Expr>()
    const fullMask = (1 << domain.length) - 1
    const primitiveFamilyMasks = new Map<string, Set<Mask>>()
    const primitiveMasks = new Set<Mask>()
    const withComplements = new Set<Mask>()

    for (const { expr, mask, family } of candidates()) {
        if (mask === 0 || mask === fullMask) continue
        primitiveMasks.add(mask)
        addFamilyMask(family, mask)
        save(expr, mask)
        withComplements.add(mask)

        const complement = fullMask ^ mask
        save(negateInPlace(structuredClone(expr)), complement)
        withComplements.add(complement)
    }

    return { best, primitiveFamilyMasks, primitiveMasks, withComplements, targetMaskCount: fullMask - 1, fullMask }

    function save(expr: Expr, mask: Mask) {
        const current = best.get(mask)
        if (current === undefined || exprCostCompare(expr, current) < 0) best.set(mask, expr)
    }

    function addFamilyMask(family: string, mask: Mask) {
        const masks = primitiveFamilyMasks.get(family)
        if (masks) masks.add(mask)
        else primitiveFamilyMasks.set(family, new Set([mask]))
    }

    function* candidates(): Generator<Candidate> {
        const m = metrics()
        yield* lengthCandidates(m.lengths)
        yield* charAtCandidates(m.maxLength)
    }

    function* lengthCandidates(lengths: readonly number[]): Generator<Candidate> {
        for (const length of lengths) {
            for (const op of ['<', '<=', '>', '>=', '='] as const) {
                yield {
                    family: 'length relations',
                    mask: computeMask(domain, s => compare(s.length, op, length)),
                    expr: {
                        feature: {
                            type: 'length',
                            child: {
                                type: op,
                                args: { type: 'lit', args: length },
                            },
                        },
                    },
                }
            }
        }
    }

    function* charAtCandidates(maxLength: number): Generator<Candidate> {
        for (let i = 0; i < maxLength; ++i) {
            const charsHere = groupBy(domain, s => s[i])
            for (const [char, subdomain] of charsHere) {
                yield {
                    family: 'char equality',
                    mask: computeMask(domain, s => subdomain.includes(s)),
                    expr: {
                        feature: {
                            type: 'charAt',
                            args: { n: i },
                            child: {
                                type: '=',
                                args: { type: 'lit', args: char },
                            },
                        },
                    },
                }
            }

            const sortedChars = [...charsHere.keys()]
                .filter((char): char is string => char !== undefined)
                .sort()

            for (const char of sortedChars) {
                for (const op of ['<', '<=', '>', '>='] as const) {
                    yield {
                        family: 'char relations',
                        mask: computeMask(domain, s => compare(s[i], op, char)),
                        expr: {
                            feature: {
                                type: 'charAt',
                                args: { n: i },
                                child: {
                                    type: op,
                                    args: { type: 'lit', args: char },
                                },
                            },
                        },
                    }
                }
            }
        }
    }

    function metrics() {
        let maxLength = 0
        const lengths = new Set<number>()
        for (const s of domain) {
            lengths.add(s.length)
            if (s.length > maxLength) maxLength = s.length
        }
        return { lengths: [...lengths].sort((a, b) => a - b), maxLength }
    }
}

function compare(left: number, op: ComparisonOp, right: number): boolean
function compare(left: string | undefined, op: ComparisonOp, right: string): boolean
function compare(left: number | string | undefined, op: ComparisonOp, right: number | string): boolean {
    if (left === undefined) return false
    switch (op) {
        case '<':
            return left < right
        case '<=':
            return left <= right
        case '>':
            return left > right
        case '>=':
            return left >= right
        case '=':
            return left === right
    }
}

function groupBy<T, K>(list: readonly T[], getKey: (item: T) => K) {
    return list.reduce((previous, currentItem) => {
        const group = getKey(currentItem)
        const g = previous.get(group)
        if (g) g.push(currentItem)
        else previous.set(group, [currentItem])
        return previous
    }, new Map<K, T[]>())
}
