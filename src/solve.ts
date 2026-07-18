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
    compositionIterations: number
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

    const compositionIterations = closeCompositions()

    return {
        best,
        primitiveFamilyMasks,
        primitiveMasks,
        withComplements,
        compositionIterations,
        targetMaskCount: fullMask - 1,
        fullMask,
    }

    function save(expr: Expr, mask: Mask): boolean {
        if (mask === 0 || mask === fullMask) return false
        const current = best.get(mask)
        if (current !== undefined && exprCostCompare(expr, current) >= 0) return false
        best.set(mask, expr)
        return true
    }

    function addFamilyMask(family: string, mask: Mask) {
        const masks = primitiveFamilyMasks.get(family)
        if (masks) masks.add(mask)
        else primitiveFamilyMasks.set(family, new Set([mask]))
    }

    function closeCompositions(): number {
        let iterations = 0
        let improved = true

        while (improved) {
            improved = false
            iterations++
            const entries = [...best.entries()]

            for (const [leftMask, left] of entries) {
                for (const [rightMask, right] of entries) {
                    const intersection = leftMask & rightMask
                    improved = save({ type: 'and', left, right }, intersection) || improved

                    const union = leftMask | rightMask
                    improved = save({ type: 'or', left, right }, union) || improved

                    const xor = leftMask ^ rightMask
                    improved = save({ type: 'xor', left, right }, xor) || improved
                }
            }
        }

        return iterations - 1
    }

    function* candidates(): Generator<Candidate> {
        const m = metrics()
        yield* lengthCandidates(m.lengths)
        yield* charAtCandidates(m.maxLength)
        yield* atCandidates(m.maxLength)
        yield* stringMembershipCandidates()
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

    function* atCandidates(maxLength: number): Generator<Candidate> {
        for (let n = 1; n <= maxLength; ++n) {
            const charsHere = groupBy(domain, s => s.at(-n))
            for (const [char, subdomain] of charsHere) {
                yield {
                    family: 'negative index equality',
                    mask: computeMask(domain, s => subdomain.includes(s)),
                    expr: {
                        feature: {
                            type: 'at',
                            args: { '-n': n },
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
                        family: 'negative index relations',
                        mask: computeMask(domain, s => compare(s.at(-n), op, char)),
                        expr: {
                            feature: {
                                type: 'at',
                                args: { '-n': n },
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

    function* stringMembershipCandidates(): Generator<Candidate> {
        const prefixes = new Set<string>()
        const suffixes = new Set<string>()
        const substrings = new Set<string>()

        for (const s of domain) {
            for (let length = 1; length < s.length; ++length) {
                prefixes.add(s.slice(0, length))
                suffixes.add(s.slice(s.length - length))
            }
            for (let start = 0; start < s.length; ++start) {
                for (let end = start + 1; end < s.length; ++end) {
                    substrings.add(s.slice(start, end))
                }
            }
        }

        for (const prefix of prefixes) {
            yield {
                family: 'prefixes',
                mask: computeMask(domain, s => s.startsWith(prefix)),
                expr: { feature: { type: 'startsWith', args: { s: prefix } } },
            }
        }

        for (const suffix of suffixes) {
            yield {
                family: 'suffixes',
                mask: computeMask(domain, s => s.endsWith(suffix)),
                expr: { feature: { type: 'endsWith', args: { s: suffix } } },
            }
        }

        for (const value of substrings) {
            yield {
                family: 'substring membership',
                mask: computeMask(domain, s => s.includes(value)),
                expr: { feature: { type: 'includes', args: { value } } },
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
