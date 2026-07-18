import { notExpr, type Expr } from './ir.js'
import { computeMask } from './mask.js'
import type { Mask } from './types.js'

type RelationalOp = '<' | '<=' | '>' | '>='
type ComparisonOp = RelationalOp | '='

export type FamilyKind = 'primitive' | 'complement' | 'composition'

export type FamilyId =
    | 'length.relation'
    | 'charAt.equality'
    | 'charAt.relation'
    | 'at.equality'
    | 'at.relation'
    | 'startsWith'
    | 'endsWith'
    | 'includes'
    | 'not'
    | 'and'
    | 'or'
    | 'xor'

export type CandidateSource = {
    family: FamilyId
    kind: FamilyKind
    parents?: readonly Mask[]
    iteration?: number
}

type Candidate = { expr: Expr; mask: Mask; source: CandidateSource }

export type Winner = {
    mask: Mask
    expr: Expr
    source: CandidateSource
    generation: number
}

export type FamilyStats = {
    family: FamilyId
    kind: FamilyKind
    candidates: number
    masks: Set<Mask>
    firstMasks: Set<Mask>
    improvements: number
    winners: Set<Mask>
}

export type SolveResult = {
    best: Map<Mask, Expr>
    winners: Map<Mask, Winner>
    familyStats: Map<FamilyId, FamilyStats>
    stageMasks: {
        primitives: Set<Mask>
        complements: Set<Mask>
        composition: Set<Mask>
    }
    compositionPasses: number
    targetMaskCount: number
    fullMask: Mask
}

export function solve<const Domain extends string>(
    domain: readonly Domain[],
    exprCostCompare: (a: Expr, b: Expr) => number,
): SolveResult {
    const winners = new Map<Mask, Winner>()
    const familyStats = new Map<FamilyId, FamilyStats>()
    const discoveredMasks = new Set<Mask>()
    const fullMask = (1 << domain.length) - 1
    let generation = 0

    for (const candidate of candidates()) {
        consider(candidate)

        if (isTargetMask(candidate.mask)) {
            consider({
                expr: notExpr(structuredClone(candidate.expr)),
                mask: fullMask ^ candidate.mask,
                source: { family: 'not', kind: 'complement', parents: [candidate.mask] },
            })
        }
    }

    const complements = new Set(winners.keys())
    const compositionPasses = closeCompositions()
    recordFinalWinners()

    return {
        best: new Map([...winners].map(([mask, winner]) => [mask, winner.expr])),
        winners,
        familyStats,
        stageMasks: {
            primitives: masksForKind('primitive'),
            complements,
            composition: new Set(winners.keys()),
        },
        compositionPasses,
        targetMaskCount: fullMask - 1,
        fullMask,
    }

    function consider(candidate: Candidate): boolean {
        const stats = statsFor(candidate.source)
        stats.candidates++

        if (!isTargetMask(candidate.mask)) return false

        stats.masks.add(candidate.mask)
        if (!discoveredMasks.has(candidate.mask)) {
            discoveredMasks.add(candidate.mask)
            stats.firstMasks.add(candidate.mask)
        }

        const current = winners.get(candidate.mask)
        if (current !== undefined && exprCostCompare(candidate.expr, current.expr) >= 0) return false

        winners.set(candidate.mask, {
            mask: candidate.mask,
            expr: candidate.expr,
            source: candidate.source,
            generation: generation++,
        })
        stats.improvements++
        return true
    }

    function isTargetMask(mask: Mask): boolean {
        return mask !== 0 && mask !== fullMask
    }

    function statsFor(source: CandidateSource): FamilyStats {
        const current = familyStats.get(source.family)
        if (current !== undefined) return current

        const stats: FamilyStats = {
            family: source.family,
            kind: source.kind,
            candidates: 0,
            masks: new Set(),
            firstMasks: new Set(),
            improvements: 0,
            winners: new Set(),
        }
        familyStats.set(source.family, stats)
        return stats
    }

    function masksForKind(kind: FamilyKind): Set<Mask> {
        const masks = new Set<Mask>()
        for (const stats of familyStats.values()) {
            if (stats.kind !== kind) continue
            for (const mask of stats.masks) masks.add(mask)
        }
        return masks
    }

    function recordFinalWinners() {
        for (const stats of familyStats.values()) stats.winners.clear()
        for (const [mask, winner] of winners) statsFor(winner.source).winners.add(mask)
    }

    function closeCompositions(): number {
        let iterations = 0
        let improved = true

        while (improved) {
            improved = false
            iterations++
            const entries = [...winners.values()]

            for (const left of entries) {
                for (const right of entries) {
                    const leftMask = left.mask
                    const rightMask = right.mask
                    const intersection = leftMask & rightMask
                    improved =
                        consider({
                            expr: { type: 'and', left: left.expr, right: right.expr },
                            mask: intersection,
                            source: { family: 'and', kind: 'composition', parents: [leftMask, rightMask], iteration: iterations },
                        }) || improved

                    const union = leftMask | rightMask
                    improved =
                        consider({
                            expr: { type: 'or', left: left.expr, right: right.expr },
                            mask: union,
                            source: { family: 'or', kind: 'composition', parents: [leftMask, rightMask], iteration: iterations },
                        }) || improved

                    const xor = leftMask ^ rightMask
                    improved =
                        consider({
                            expr: { type: 'xor', left: left.expr, right: right.expr },
                            mask: xor,
                            source: { family: 'xor', kind: 'composition', parents: [leftMask, rightMask], iteration: iterations },
                        }) || improved
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
                    source: { family: 'length.relation', kind: 'primitive' },
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
                    source: { family: 'charAt.equality', kind: 'primitive' },
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
                        source: { family: 'charAt.relation', kind: 'primitive' },
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
                    source: { family: 'at.equality', kind: 'primitive' },
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
                        source: { family: 'at.relation', kind: 'primitive' },
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
                source: { family: 'startsWith', kind: 'primitive' },
                mask: computeMask(domain, s => s.startsWith(prefix)),
                expr: { feature: { type: 'startsWith', args: { s: prefix } } },
            }
        }

        for (const suffix of suffixes) {
            yield {
                source: { family: 'endsWith', kind: 'primitive' },
                mask: computeMask(domain, s => s.endsWith(suffix)),
                expr: { feature: { type: 'endsWith', args: { s: suffix } } },
            }
        }

        for (const value of substrings) {
            yield {
                source: { family: 'includes', kind: 'primitive' },
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
