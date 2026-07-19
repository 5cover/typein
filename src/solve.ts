import { invertLastPredicateInPlace, notExpr, type Expr } from './ir.js'
import { computeMask } from './mask.js'
import type { Mask } from './types.js'
import { costCode, sourceLength } from './cost.js'
import { performance } from 'node:perf_hooks'

type RelationalOp = '<' | '<=' | '>' | '>='
type ComparisonOp = RelationalOp | '='

export type FamilyKind = 'primitive' | 'complement' | 'composition'

export type FamilyId =
    | 'self.equality'
    | 'length.relation'
    | 'charAt.equality'
    | 'charAt.defined'
    | 'charAt.undefined'
    | 'charAt.relation'
    | 'at.equality'
    | 'at.defined'
    | 'at.undefined'
    | 'at.relation'
    | 'startsWith'
    | 'endsWith'
    | 'includes'
    | 'delimiter.presence'
    | 'token.count'
    | 'token.first'
    | 'token.last'
    | 'token.middle'
    | 'token.any'
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
    depth: number
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
    profile: SolveProfile
    targetMaskCount: number
    fullMask: Mask
}

export type SolveProfile = {
    primitiveMs: number
    compositionMs: number
    finalizeMs: number
    compositionAttempts: number
    compositionPruned: number
    compositionConsidered: number
    compositionImprovements: number
    compositionQueuedPairs: number
}

export type QueryProfile = SolveProfile & {
    targetFound: boolean
    primitiveCandidates: number
    primitiveDiscarded: number
    exactCandidates: number
    subsetCandidates: number
    supersetCandidates: number
    orStates: number
    andStates: number
    orStateLimitHit: boolean
    andStateLimitHit: boolean
    frontierTruncations: number
    frontierInput: number
    frontierKept: number
    dnfTermsAttempted: number
    proof: 'query-normal-forms' | 'bounded-query-normal-forms'
    limits: QueryLimits
}

export type QueryResult = {
    expr: Expr
    profile: QueryProfile
    targetValues: readonly string[]
    familyStats: Map<FamilyId, QueryFamilyStats>
}

export type QueryLimits = {
    orStates: number
    andStates: number
    supersetPreFrontier: number
    supersetFrontier: number
    dnfFrontier: number
}

export const defaultQueryLimits: QueryLimits = {
    orStates: 200,
    andStates: 200,
    supersetPreFrontier: 512,
    supersetFrontier: 64,
    dnfFrontier: 32,
}

export type QueryFamilyStats = {
    family: FamilyId
    candidates: number
    costPruned: number
    exact: number
    subset: number
    superset: number
    unrelated: number
    retainedSubset: number
    retainedSuperset: number
    improvements: number
}

export function solve<const Domain extends string>(
    domain: readonly Domain[],
    exprCostCompare: (a: Expr, b: Expr) => number,
): SolveResult {
    const winners = new Map<Mask, Winner>()
    const familyStats = new Map<FamilyId, FamilyStats>()
    const discoveredMasks = new Set<Mask>()
    const fullMask = (1 << domain.length) - 1
    const profile: SolveProfile = {
        primitiveMs: 0,
        compositionMs: 0,
        finalizeMs: 0,
        compositionAttempts: 0,
        compositionPruned: 0,
        compositionConsidered: 0,
        compositionImprovements: 0,
        compositionQueuedPairs: 0,
    }
    let generation = 0

    const primitiveStart = performance.now()
    for (const candidate of candidates()) {
        consider(candidate)

        if (isTargetMask(candidate.mask)) {
            consider({
                expr: complementExpr(candidate),
                mask: fullMask ^ candidate.mask,
                source: { family: 'not', kind: 'complement', parents: [candidate.mask] },
            })
        }
    }
    profile.primitiveMs = performance.now() - primitiveStart

    const complements = new Set(winners.keys())
    const compositionStart = performance.now()
    const compositionPasses = closeCompositions()
    profile.compositionMs = performance.now() - compositionStart

    const finalizeStart = performance.now()
    recordFinalWinners()

    const result = {
        best: new Map([...winners].map(([mask, winner]) => [mask, winner.expr])),
        winners,
        familyStats,
        stageMasks: {
            primitives: masksForKind('primitive'),
            complements,
            composition: new Set(winners.keys()),
        },
        compositionPasses,
        profile,
        targetMaskCount: fullMask - 1,
        fullMask,
    }
    profile.finalizeMs = performance.now() - finalizeStart

    return result

    function complementExpr(candidate: Candidate): Expr {
        const expr = structuredClone(candidate.expr)
        return canInvertComplement(candidate) ? invertLastPredicateInPlace(expr) : notExpr(expr)
    }

    function canInvertComplement(candidate: Candidate): boolean {
        switch (candidate.source.family) {
            case 'self.equality':
            case 'length.relation':
            case 'charAt.equality':
            case 'at.equality':
                return true
            case 'charAt.defined':
            case 'charAt.undefined':
            case 'at.defined':
            case 'at.undefined':
            case 'charAt.relation':
            case 'at.relation':
            case 'startsWith':
            case 'endsWith':
            case 'includes':
            case 'delimiter.presence':
            case 'token.count':
            case 'token.first':
            case 'token.last':
            case 'token.middle':
            case 'token.any':
            case 'not':
            case 'and':
            case 'or':
            case 'xor':
                return false
        }
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
            depth: candidateDepth(candidate),
        })
        stats.improvements++
        return true
    }

    function candidateDepth(candidate: Candidate): number {
        switch (candidate.source.kind) {
            case 'primitive':
            case 'complement':
                return 0
            case 'composition':
                return Math.max(...(candidate.source.parents ?? []).map(mask => winners.get(mask)?.depth ?? 0)) + 1
        }
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
        let maxDepth = 0
        let changed = false
        let pass = 0

        do {
            changed = false
            pass++

            const snapshot = [...winners.values()].sort(compareWinnerCost)
            const queue = new PairQueue()
            let maxCurrentCost = currentMaxSourceCost()

            for (let i = 0; i < snapshot.length; ++i) {
                pushPair(queue, {
                    leftIndex: i,
                    rightIndex: 0,
                    lowerBound: compositionLowerBound('and', snapshot[i]!, snapshot[0]!),
                })
            }

            for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
                if (winners.size === fullMask - 1 && item.lowerBound > maxCurrentCost) break

                const left = snapshot[item.leftIndex]!
                const right = snapshot[item.rightIndex]!
                let itemImproved = false
                for (const family of ['and', 'or', 'xor'] as const) {
                    const winnerDepth = tryCompose(family, left, right)
                    if (winnerDepth === 0) continue

                    maxDepth = Math.max(maxDepth, winnerDepth)
                    itemImproved = true
                    changed = true
                }

                if (item.rightIndex < item.leftIndex) {
                    const nextRightIndex = item.rightIndex + 1
                    pushPair(queue, {
                        leftIndex: item.leftIndex,
                        rightIndex: nextRightIndex,
                        lowerBound: compositionLowerBound('and', left, snapshot[nextRightIndex]!),
                    })
                }

                if (itemImproved) maxCurrentCost = currentMaxSourceCost()
            }
        } while (changed)

        return maxDepth

        function tryCompose(family: 'and' | 'or' | 'xor', left: Winner, right: Winner): number {
            profile.compositionAttempts++
            const target = composeMask(family, left.mask, right.mask)
            if (!isTargetMask(target) || shouldPruneSourceComposition(family, left, right, target)) {
                profile.compositionPruned++
                return 0
            }

            profile.compositionConsidered++
            const [first, second] = orderOperands(left, right)
            const improved = consider({
                expr: { type: family, left: first.expr, right: second.expr },
                mask: target,
                source: { family, kind: 'composition', parents: [first.mask, second.mask], iteration: pass },
            })
            if (!improved) return 0

            profile.compositionImprovements++
            const winner = winners.get(target)!
            return winner.depth
        }

        function currentMaxSourceCost(): number {
            if (winners.size < fullMask - 1) return Number.POSITIVE_INFINITY

            let max = 0
            for (const winner of winners.values()) {
                max = Math.max(max, sourceLength(winner.expr))
            }
            return max
        }

        function pushPair(queue: PairQueue, item: PairQueueItem): void {
            profile.compositionQueuedPairs++
            queue.push(item)
        }
    }

    function shouldPruneSourceComposition(family: 'and' | 'or' | 'xor', left: Winner, right: Winner, mask: Mask): boolean {
        if (exprCostCompare !== costCode) return false

        const current = winners.get(mask)
        if (current === undefined) return false

        const lowerBound = compositionLowerBound(family, left, right)
        return lowerBound > sourceLength(current.expr)
    }

    function compositionLowerBound(family: 'and' | 'or' | 'xor', left: Winner, right: Winner): number {
        const operatorLength = family === 'xor' ? ' !== '.length : ' && '.length
        return sourceLength(left.expr) + operatorLength + sourceLength(right.expr)
    }

    function composeMask(family: 'and' | 'or' | 'xor', leftMask: Mask, rightMask: Mask): Mask {
        switch (family) {
            case 'and':
                return leftMask & rightMask
            case 'or':
                return leftMask | rightMask
            case 'xor':
                return leftMask ^ rightMask
        }
    }

    function compareWinnerCost(a: Winner, b: Winner): number {
        return exprCostCompare(a.expr, b.expr)
    }

    function orderOperands(left: Winner, right: Winner): readonly [Winner, Winner] {
        if (compareWinnerCost(right, left) < 0) return [right, left]
        return [left, right]
    }

    function* candidates(): Generator<Candidate> {
        const m = metrics()
        yield* selfEqualityCandidates()
        yield* lengthCandidates(m.lengths)
        yield* charAtCandidates(m.maxLength)
        yield* atCandidates(m.maxLength)
        yield* stringMembershipCandidates()
    }

    function* selfEqualityCandidates(): Generator<Candidate> {
        for (const value of domain) {
            yield {
                source: { family: 'self.equality', kind: 'primitive' },
                mask: computeMask(domain, s => s === value),
                expr: selfEqualityExpr(value),
            }
        }
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
            yield {
                source: { family: 'charAt.defined', kind: 'primitive' },
                mask: computeMask(domain, s => s[i] !== undefined),
                expr: notExpr(
                    notExpr({
                        feature: {
                            type: 'charAt',
                            args: { n: i },
                        },
                    }),
                ),
            }
            yield {
                source: { family: 'charAt.undefined', kind: 'primitive' },
                mask: computeMask(domain, s => s[i] === undefined),
                expr: {
                    feature: {
                        type: 'charAt',
                        args: { n: i },
                        child: { type: 'not' },
                    },
                },
            }
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
            yield {
                source: { family: 'at.defined', kind: 'primitive' },
                mask: computeMask(domain, s => s.at(-n) !== undefined),
                expr: notExpr(
                    notExpr({
                        feature: {
                            type: 'at',
                            args: { '-n': n },
                        },
                    }),
                ),
            }
            yield {
                source: { family: 'at.undefined', kind: 'primitive' },
                mask: computeMask(domain, s => s.at(-n) === undefined),
                expr: {
                    feature: {
                        type: 'at',
                        args: { '-n': n },
                        child: { type: 'not' },
                    },
                },
            }
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

type BigMask = bigint

type BigCandidate = {
    expr: Expr
    mask: BigMask
    source: {
        family: FamilyId
        kind: FamilyKind
        parents?: readonly BigMask[]
        iteration?: number
    }
}

type QueryWinner = {
    mask: BigMask
    expr: Expr
    generation: number
    depth: number
}

type QueryAtom = {
    mask: BigMask
    expr: Expr
    cost: number
}

type QuerySearchResult = {
    mask: BigMask
    expr: Expr | undefined
    cost: number
}

export function solveQuery<const Domain extends string>(
    domain: readonly Domain[],
    targetValues: readonly Domain[],
    exprCostCompare: (a: Expr, b: Expr) => number,
    queryLimits: QueryLimits = defaultQueryLimits,
): QueryResult {
    const limits = normalizeQueryLimits(queryLimits)
    const fullMask = (1n << BigInt(domain.length)) - 1n
    const targetValueSet = new Set(targetValues)
    const targetMask = computeBigMask(domain, s => targetValueSet.has(s))
    const profile: QueryProfile = {
        primitiveMs: 0,
        compositionMs: 0,
        finalizeMs: 0,
        compositionAttempts: 0,
        compositionPruned: 0,
        compositionConsidered: 0,
        compositionImprovements: 0,
        compositionQueuedPairs: 0,
        targetFound: true,
        primitiveCandidates: 0,
        primitiveDiscarded: 0,
        exactCandidates: 0,
        subsetCandidates: 0,
        supersetCandidates: 0,
        orStates: 0,
        andStates: 0,
        orStateLimitHit: false,
        andStateLimitHit: false,
        frontierTruncations: 0,
        frontierInput: 0,
        frontierKept: 0,
        dnfTermsAttempted: 0,
        proof: 'query-normal-forms',
        limits,
    }
    const fallback = exactSubsetExpr(targetValues)
    let best = fallback
    let bestCost = sourceLength(fallback)
    let proof: QueryProfile['proof'] = 'query-normal-forms'
    const subsetAtoms = new Map<BigMask, QueryAtom>()
    const supersetAtoms = new Map<BigMask, QueryAtom>()
    const familyStats = new Map<FamilyId, QueryFamilyStats>()

    const primitiveStart = performance.now()
    for (const candidate of targetCandidates()) considerPrimitive(candidate)
    profile.primitiveMs = performance.now() - primitiveStart

    const compositionStart = performance.now()
    const orResult = searchOrCover(reduceSubsetAtoms([...subsetAtoms.values()]), bestCost)
    if (orResult !== undefined) improve(orResult.expr)

    const reducedSupersetAtoms = queryFrontier(
        reduceSupersetAtoms(queryFrontier([...supersetAtoms.values()], limits.supersetPreFrontier)),
        limits.supersetFrontier,
    )
    const andResult = searchAndFilter(reducedSupersetAtoms, bestCost)
    if (andResult !== undefined) improve(andResult.expr)

    const dnfAtoms = pairwiseAndTerms(queryFrontier(reducedSupersetAtoms, limits.dnfFrontier), bestCost)
    if (dnfAtoms.length > 0) {
        const dnfResult = searchOrCover(reduceSubsetAtoms([...subsetAtoms.values(), ...dnfAtoms]), bestCost)
        if (dnfResult !== undefined) improve(dnfResult.expr)
    }
    profile.compositionMs = performance.now() - compositionStart
    profile.proof = proof

    const finalizeStart = performance.now()
    profile.finalizeMs = performance.now() - finalizeStart
    return { expr: best, profile, targetValues, familyStats }

    function considerPrimitive(candidate: BigCandidate): void {
        const stats = queryStatsFor(candidate.source.family)
        profile.primitiveCandidates++
        stats.candidates++
        if (sourceLength(candidate.expr) >= bestCost) {
            profile.primitiveDiscarded++
            stats.costPruned++
            return
        }

        considerAtom(candidate.mask, candidate.expr, stats)

        if (isUsefulIntermediate(candidate.mask)) {
            const complementStats = queryStatsFor('not')
            complementStats.candidates++
            const complementExpr = queryComplementExpr(candidate)
            if (sourceLength(complementExpr) < bestCost) {
                considerAtom(fullMask ^ candidate.mask, complementExpr, complementStats)
            } else {
                complementStats.costPruned++
            }
        }
    }

    function considerAtom(mask: BigMask, expr: Expr, stats: QueryFamilyStats): void {
        if (mask === targetMask) {
            profile.exactCandidates++
            stats.exact++
            if (improve(expr)) stats.improvements++
            return
        }

        let retained = false
        if (isStrictTargetSubset(mask)) {
            profile.subsetCandidates++
            stats.subset++
            retained = retainCheapest(subsetAtoms, mask, expr)
            if (retained) stats.retainedSubset++
        }

        if (isStrictTargetSuperset(mask)) {
            profile.supersetCandidates++
            stats.superset++
            retained = retainCheapest(supersetAtoms, mask, expr) || retained
            if (retained) stats.retainedSuperset++
        }

        if (!retained) {
            profile.primitiveDiscarded++
            if (!isStrictTargetSubset(mask) && !isStrictTargetSuperset(mask)) stats.unrelated++
        }
    }

    function improve(expr: Expr | undefined): boolean {
        if (expr === undefined || exprCostCompare(expr, best) >= 0) return false

        best = expr
        bestCost = sourceLength(expr)
        profile.compositionImprovements++
        return true
    }

    function retainCheapest(map: Map<BigMask, QueryAtom>, mask: BigMask, expr: Expr): boolean {
        const current = map.get(mask)
        if (current !== undefined && exprCostCompare(expr, current.expr) >= 0) return false

        map.set(mask, { mask, expr, cost: sourceLength(expr) })
        return true
    }

    function reduceSubsetAtoms(atoms: readonly QueryAtom[]): QueryAtom[] {
        const reduced: QueryAtom[] = []
        for (const atom of atoms.filter(atom => atom.cost < bestCost).sort((a, b) => a.cost - b.cost)) {
            if (reduced.some(existing => covers(existing.mask, atom.mask) && existing.cost <= atom.cost)) continue

            for (let i = reduced.length - 1; i >= 0; --i) {
                if (covers(atom.mask, reduced[i]!.mask) && atom.cost <= reduced[i]!.cost) reduced.splice(i, 1)
            }
            reduced.push(atom)
        }
        return reduced
    }

    function reduceSupersetAtoms(atoms: readonly QueryAtom[]): QueryAtom[] {
        const reduced: QueryAtom[] = []
        for (const atom of atoms.filter(atom => atom.cost < bestCost).sort((a, b) => a.cost - b.cost)) {
            if (reduced.some(existing => covers(atom.mask, existing.mask) && existing.cost <= atom.cost)) continue

            for (let i = reduced.length - 1; i >= 0; --i) {
                if (covers(reduced[i]!.mask, atom.mask) && atom.cost <= reduced[i]!.cost) reduced.splice(i, 1)
            }
            reduced.push(atom)
        }
        return reduced
    }

    function queryFrontier(atoms: readonly QueryAtom[], maxSize: number): QueryAtom[] {
        if (atoms.length <= maxSize) return [...atoms]

        proof = 'bounded-query-normal-forms'
        profile.frontierTruncations++
        profile.frontierInput += atoms.length
        profile.frontierKept += maxSize
        return [...atoms]
            .sort((a, b) => falsePositiveCount(a.mask) - falsePositiveCount(b.mask) || a.cost - b.cost || exprCostCompare(a.expr, b.expr))
            .slice(0, maxSize)
    }

    function searchOrCover(atoms: readonly QueryAtom[], bound: number): QuerySearchResult | undefined {
        const usefulAtoms = atoms
            .filter(atom => atom.cost < bound && isStrictTargetSubset(atom.mask))
            .sort((a, b) => a.cost - b.cost || exprCostCompare(a.expr, b.expr))
        const bestStates = new Map<BigMask, QuerySearchResult>()
        const queue = new QueryQueue()

        const start = { mask: 0n, expr: undefined, cost: 0 }
        bestStates.set(0n, start)
        queue.push(start)

        for (let state = queue.pop(); state !== undefined; state = queue.pop()) {
            if (bestStates.get(state.mask)?.cost !== state.cost) continue
            if (state.cost >= bound) continue

            profile.orStates++
            if (profile.orStates > limits.orStates) {
                proof = 'bounded-query-normal-forms'
                profile.orStateLimitHit = true
                return undefined
            }
            if (state.mask === targetMask && state.expr !== undefined) return state

            for (const atom of usefulAtoms) {
                const nextMask = state.mask | atom.mask
                if (nextMask === state.mask) continue

                profile.compositionAttempts++
                const lowerBound = state.expr === undefined ? atom.cost : state.cost + ' || '.length + atom.cost
                if (lowerBound >= bound) {
                    profile.compositionPruned++
                    continue
                }

                const nextExpr: Expr = state.expr === undefined ? atom.expr : { type: 'or', left: state.expr, right: atom.expr }
                const nextCost = sourceLength(nextExpr)
                profile.compositionConsidered++
                if (nextCost >= bound) continue

                const current = bestStates.get(nextMask)
                if (current !== undefined && nextCost >= current.cost) continue

                const next = { mask: nextMask, expr: nextExpr, cost: nextCost }
                bestStates.set(nextMask, next)
                queue.push(next)
            }
        }

        return undefined
    }

    function searchAndFilter(atoms: readonly QueryAtom[], bound: number): QuerySearchResult | undefined {
        const usefulAtoms = atoms
            .filter(atom => atom.cost < bound && isStrictTargetSuperset(atom.mask))
            .sort((a, b) => a.cost - b.cost || exprCostCompare(a.expr, b.expr))
        const bestStates = new Map<BigMask, QuerySearchResult>()
        const queue = new QueryQueue()

        for (const atom of usefulAtoms) {
            const current = bestStates.get(atom.mask)
            if (current !== undefined && atom.cost >= current.cost) continue
            const state = { mask: atom.mask, expr: atom.expr, cost: atom.cost }
            bestStates.set(atom.mask, state)
            queue.push(state)
        }

        for (let state = queue.pop(); state !== undefined; state = queue.pop()) {
            if (bestStates.get(state.mask)?.cost !== state.cost) continue
            if (state.cost >= bound) continue

            profile.andStates++
            if (profile.andStates > limits.andStates) {
                proof = 'bounded-query-normal-forms'
                profile.andStateLimitHit = true
                return undefined
            }
            if (state.mask === targetMask && state.expr !== undefined) return state

            for (const atom of usefulAtoms) {
                const nextMask = state.mask & atom.mask
                if (nextMask === state.mask || !containsTarget(nextMask)) continue

                profile.compositionAttempts++
                const lowerBound = state.cost + ' && '.length + atom.cost
                if (lowerBound >= bound) {
                    profile.compositionPruned++
                    continue
                }

                const nextExpr: Expr = { type: 'and', left: state.expr!, right: atom.expr }
                const nextCost = sourceLength(nextExpr)
                profile.compositionConsidered++
                if (nextCost >= bound) continue

                const current = bestStates.get(nextMask)
                if (current !== undefined && nextCost >= current.cost) continue

                const next = { mask: nextMask, expr: nextExpr, cost: nextCost }
                bestStates.set(nextMask, next)
                queue.push(next)
            }
        }

        return undefined
    }

    function pairwiseAndTerms(atoms: readonly QueryAtom[], bound: number): QueryAtom[] {
        const terms = new Map<BigMask, QueryAtom>()
        const usefulAtoms = atoms.filter(atom => atom.cost < bound && isStrictTargetSuperset(atom.mask)).sort((a, b) => a.cost - b.cost)

        for (let i = 0; i < usefulAtoms.length; ++i) {
            const left = usefulAtoms[i]!
            for (let j = i; j < usefulAtoms.length; ++j) {
                const right = usefulAtoms[j]!
                profile.dnfTermsAttempted++

                const lowerBound = left.cost + ' && '.length + right.cost
                if (lowerBound >= bound) break

                const mask = left.mask & right.mask
                if (!isStrictTargetSubset(mask)) continue

                const expr: Expr = i === j ? left.expr : { type: 'and', left: left.expr, right: right.expr }
                if (sourceLength(expr) >= bound) continue
                retainCheapest(terms, mask, expr)
            }
        }

        return [...terms.values()]
    }

    function isUsefulIntermediate(mask: BigMask): boolean {
        return mask !== 0n && mask !== fullMask
    }

    function isStrictTargetSubset(mask: BigMask): boolean {
        return mask !== 0n && mask !== targetMask && (mask & ~targetMask) === 0n
    }

    function isStrictTargetSuperset(mask: BigMask): boolean {
        return mask !== fullMask && mask !== targetMask && containsTarget(mask)
    }

    function containsTarget(mask: BigMask): boolean {
        return (targetMask & ~mask) === 0n
    }

    function covers(left: BigMask, right: BigMask): boolean {
        return (right & ~left) === 0n
    }

    function falsePositiveCount(mask: BigMask): number {
        return popcountBig(mask & ~targetMask)
    }

    function queryStatsFor(family: FamilyId): QueryFamilyStats {
        const current = familyStats.get(family)
        if (current !== undefined) return current

        const stats: QueryFamilyStats = {
            family,
            candidates: 0,
            costPruned: 0,
            exact: 0,
            subset: 0,
            superset: 0,
            unrelated: 0,
            retainedSubset: 0,
            retainedSuperset: 0,
            improvements: 0,
        }
        familyStats.set(family, stats)
        return stats
    }

    function queryComplementExpr(candidate: BigCandidate): Expr {
        const expr = structuredClone(candidate.expr)
        return canInvertQueryComplement(candidate) ? invertLastPredicateInPlace(expr) : notExpr(expr)
    }

    function canInvertQueryComplement(candidate: BigCandidate): boolean {
        switch (candidate.source.family) {
            case 'self.equality':
            case 'length.relation':
            case 'charAt.equality':
            case 'at.equality':
                return true
            case 'charAt.defined':
            case 'charAt.undefined':
            case 'at.defined':
            case 'at.undefined':
            case 'charAt.relation':
            case 'at.relation':
            case 'startsWith':
            case 'endsWith':
            case 'includes':
            case 'delimiter.presence':
            case 'token.first':
            case 'token.last':
            case 'token.middle':
            case 'token.any':
            case 'not':
            case 'and':
            case 'or':
            case 'xor':
                return false
            case 'token.count':
                return true
        }
    }

    function* targetCandidates(): Generator<BigCandidate> {
        const m = metrics()
        yield* selfEqualityCandidates()
        yield* lengthCandidates(m.lengths)
        yield* charAtCandidates(m.maxLength)
        yield* atCandidates(m.maxLength)
        yield* stringMembershipCandidates()
        yield* hyphenTokenCandidates()
    }

    function* selfEqualityCandidates(): Generator<BigCandidate> {
        for (const value of targetValues) {
            yield {
                source: { family: 'self.equality', kind: 'primitive' },
                mask: computeBigMask(domain, s => s === value),
                expr: selfEqualityExpr(value),
            }
        }
    }

    function* lengthCandidates(lengths: readonly number[]): Generator<BigCandidate> {
        for (const length of lengths) {
            for (const op of ['<', '<=', '>', '>=', '='] as const) {
                yield {
                    source: { family: 'length.relation', kind: 'primitive' },
                    mask: computeBigMask(domain, s => compare(s.length, op, length)),
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

    function* charAtCandidates(maxLength: number): Generator<BigCandidate> {
        for (let i = 0; i < maxLength; ++i) {
            const charsHere = groupBy(domain, s => s[i])
            const charsToTry = new Set(targetValues.map(s => s[i]))
            yield {
                source: { family: 'charAt.defined', kind: 'primitive' },
                mask: computeBigMask(domain, s => s[i] !== undefined),
                expr: notExpr(notExpr({ feature: { type: 'charAt', args: { n: i } } })),
            }
            yield {
                source: { family: 'charAt.undefined', kind: 'primitive' },
                mask: computeBigMask(domain, s => s[i] === undefined),
                expr: { feature: { type: 'charAt', args: { n: i }, child: { type: 'not' } } },
            }
            for (const char of charsToTry) {
                const subdomain = charsHere.get(char)
                if (subdomain === undefined) continue
                yield {
                    source: { family: 'charAt.equality', kind: 'primitive' },
                    mask: computeBigMask(domain, s => subdomain.includes(s)),
                    expr: {
                        feature: {
                            type: 'charAt',
                            args: { n: i },
                            child: { type: '=', args: { type: 'lit', args: char } },
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
                        mask: computeBigMask(domain, s => compare(s[i], op, char)),
                        expr: {
                            feature: {
                                type: 'charAt',
                                args: { n: i },
                                child: { type: op, args: { type: 'lit', args: char } },
                            },
                        },
                    }
                }
            }
        }
    }

    function* atCandidates(maxLength: number): Generator<BigCandidate> {
        for (let n = 1; n <= maxLength; ++n) {
            const charsHere = groupBy(domain, s => s.at(-n))
            const charsToTry = new Set(targetValues.map(s => s.at(-n)))
            yield {
                source: { family: 'at.defined', kind: 'primitive' },
                mask: computeBigMask(domain, s => s.at(-n) !== undefined),
                expr: notExpr(notExpr({ feature: { type: 'at', args: { '-n': n } } })),
            }
            yield {
                source: { family: 'at.undefined', kind: 'primitive' },
                mask: computeBigMask(domain, s => s.at(-n) === undefined),
                expr: { feature: { type: 'at', args: { '-n': n }, child: { type: 'not' } } },
            }
            for (const char of charsToTry) {
                const subdomain = charsHere.get(char)
                if (subdomain === undefined) continue
                yield {
                    source: { family: 'at.equality', kind: 'primitive' },
                    mask: computeBigMask(domain, s => subdomain.includes(s)),
                    expr: {
                        feature: {
                            type: 'at',
                            args: { '-n': n },
                            child: { type: '=', args: { type: 'lit', args: char } },
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
                        mask: computeBigMask(domain, s => compare(s.at(-n), op, char)),
                        expr: {
                            feature: {
                                type: 'at',
                                args: { '-n': n },
                                child: { type: op, args: { type: 'lit', args: char } },
                            },
                        },
                    }
                }
            }
        }
    }

    function* stringMembershipCandidates(): Generator<BigCandidate> {
        const prefixes = new Set<string>()
        const suffixes = new Set<string>()
        const substrings = new Set<string>()

        for (const s of targetValues) {
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
                mask: computeBigMask(domain, s => s.startsWith(prefix)),
                expr: { feature: { type: 'startsWith', args: { s: prefix } } },
            }
        }

        for (const suffix of suffixes) {
            yield {
                source: { family: 'endsWith', kind: 'primitive' },
                mask: computeBigMask(domain, s => s.endsWith(suffix)),
                expr: { feature: { type: 'endsWith', args: { s: suffix } } },
            }
        }

        for (const value of substrings) {
            yield {
                source: { family: 'includes', kind: 'primitive' },
                mask: computeBigMask(domain, s => s.includes(value)),
                expr: { feature: { type: 'includes', args: { value } } },
            }
        }
    }

    function* hyphenTokenCandidates(): Generator<BigCandidate> {
        const separator = '-'
        if (!domain.some(s => s.includes(separator)) && !targetValues.some(s => s.includes(separator))) return

        const targetTokens = new Set(targetValues.flatMap(s => splitTokens(s, separator)))
        const targetFirstTokens = new Set(targetValues.filter(s => s.includes(separator)).map(s => splitTokens(s, separator)[0]!))
        const targetLastTokens = new Set(targetValues.filter(s => s.includes(separator)).map(s => splitTokens(s, separator).at(-1)!))
        const targetMiddleTokens = new Set(targetValues.flatMap(s => splitTokens(s, separator).slice(1, -1)))
        const tokenCounts = [...new Set(domain.map(s => splitTokens(s, separator).length))].sort((a, b) => a - b)

        yield {
            source: { family: 'delimiter.presence', kind: 'primitive' },
            mask: computeBigMask(domain, s => s.includes(separator)),
            expr: { feature: { type: 'includes', args: { value: separator } } },
        }
        yield {
            source: { family: 'delimiter.presence', kind: 'primitive' },
            mask: computeBigMask(domain, s => !s.includes(separator)),
            expr: notExpr({ feature: { type: 'includes', args: { value: separator } } }),
        }

        for (const count of tokenCounts) {
            for (const op of ['<', '<=', '>', '>=', '='] as const) {
                yield {
                    source: { family: 'token.count', kind: 'primitive' },
                    mask: computeBigMask(domain, s => compare(splitTokens(s, separator).length, op, count)),
                    expr: {
                        feature: {
                            type: 'splitLength',
                            args: { sep: separator },
                            child: {
                                type: op,
                                args: { type: 'lit', args: count },
                            },
                        },
                    },
                }
            }
        }

        for (const token of targetFirstTokens) {
            yield {
                source: { family: 'token.first', kind: 'primitive' },
                mask: computeBigMask(domain, s => firstToken(s, separator) === token && s.includes(separator)),
                expr: { feature: { type: 'startsWith', args: { s: `${token}${separator}` } } },
            }
        }

        for (const token of targetLastTokens) {
            yield {
                source: { family: 'token.last', kind: 'primitive' },
                mask: computeBigMask(domain, s => lastToken(s, separator) === token && s.includes(separator)),
                expr: { feature: { type: 'endsWith', args: { s: `${separator}${token}` } } },
            }
        }

        for (const token of targetMiddleTokens) {
            yield {
                source: { family: 'token.middle', kind: 'primitive' },
                mask: computeBigMask(domain, s => splitTokens(s, separator).slice(1, -1).includes(token)),
                expr: { feature: { type: 'includes', args: { value: `${separator}${token}${separator}` } } },
            }
        }

        for (const token of targetTokens) {
            yield {
                source: { family: 'token.any', kind: 'primitive' },
                mask: computeBigMask(domain, s => splitTokens(s, separator).includes(token)),
                expr: tokenAnyExpr(token, separator),
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

function selfEqualityExpr(value: string): Expr {
    return {
        feature: {
            type: 'self',
            child: {
                type: '=',
                args: { type: 'lit', args: value },
            },
        },
    }
}

function exactSubsetExpr(values: readonly string[]): Expr {
    const [first, ...rest] = values
    if (first === undefined) throw new Error('cannot build a guard for an empty target subset')

    return rest.reduce<Expr>((expr, value) => ({ type: 'or', left: expr, right: selfEqualityExpr(value) }), selfEqualityExpr(first))
}

function tokenAnyExpr(token: string, separator: string): Expr {
    return orExpr([
        selfEqualityExpr(token),
        { feature: { type: 'startsWith', args: { s: `${token}${separator}` } } },
        { feature: { type: 'endsWith', args: { s: `${separator}${token}` } } },
        { feature: { type: 'includes', args: { value: `${separator}${token}${separator}` } } },
    ])
}

function orExpr(expressions: readonly Expr[]): Expr {
    const [first, ...rest] = expressions
    if (first === undefined) throw new Error('cannot build an OR expression with no terms')
    return rest.reduce<Expr>((left, right) => ({ type: 'or', left, right }), first)
}

function splitTokens(value: string, separator: string): string[] {
    return value.split(separator)
}

function firstToken(value: string, separator: string): string {
    return splitTokens(value, separator)[0]!
}

function lastToken(value: string, separator: string): string {
    return splitTokens(value, separator).at(-1)!
}

function computeBigMask<T>(array: readonly T[], fn: (t: T) => boolean): bigint {
    return array.reduce((cur, item, i) => (fn(item) ? cur | (1n << BigInt(i)) : cur), 0n)
}

function popcountBig(mask: bigint): number {
    let count = 0
    for (let n = mask; n !== 0n; n &= n - 1n) count++
    return count
}

function normalizeQueryLimits(limits: QueryLimits): QueryLimits {
    return {
        orStates: positiveInteger(limits.orStates, 'orStates'),
        andStates: positiveInteger(limits.andStates, 'andStates'),
        supersetPreFrontier: positiveInteger(limits.supersetPreFrontier, 'supersetPreFrontier'),
        supersetFrontier: positiveInteger(limits.supersetFrontier, 'supersetFrontier'),
        dnfFrontier: positiveInteger(limits.dnfFrontier, 'dnfFrontier'),
    }
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    return value
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

type PairQueueItem = {
    leftIndex: number
    rightIndex: number
    lowerBound: number
}

class PairQueue {
    #items: PairQueueItem[] = []

    push(item: PairQueueItem): void {
        this.#items.push(item)
        this.#bubbleUp(this.#items.length - 1)
    }

    pop(): PairQueueItem | undefined {
        const first = this.#items[0]
        const last = this.#items.pop()
        if (first === undefined || last === undefined) return undefined

        if (this.#items.length > 0) {
            this.#items[0] = last
            this.#bubbleDown(0)
        }

        return first
    }

    #bubbleUp(index: number): void {
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (this.#items[parent]!.lowerBound <= this.#items[index]!.lowerBound) break
            this.#swap(index, parent)
            index = parent
        }
    }

    #bubbleDown(index: number): void {
        for (;;) {
            const left = index * 2 + 1
            const right = left + 1
            let smallest = index

            if (left < this.#items.length && this.#items[left]!.lowerBound < this.#items[smallest]!.lowerBound) {
                smallest = left
            }
            if (right < this.#items.length && this.#items[right]!.lowerBound < this.#items[smallest]!.lowerBound) {
                smallest = right
            }
            if (smallest === index) break

            this.#swap(index, smallest)
            index = smallest
        }
    }

    #swap(left: number, right: number): void {
        const temporary = this.#items[left]!
        this.#items[left] = this.#items[right]!
        this.#items[right] = temporary
    }
}

class QueryQueue {
    #items: QuerySearchResult[] = []

    push(item: QuerySearchResult): void {
        this.#items.push(item)
        this.#bubbleUp(this.#items.length - 1)
    }

    pop(): QuerySearchResult | undefined {
        const first = this.#items[0]
        const last = this.#items.pop()
        if (first === undefined || last === undefined) return undefined

        if (this.#items.length > 0) {
            this.#items[0] = last
            this.#bubbleDown(0)
        }

        return first
    }

    #bubbleUp(index: number): void {
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (this.#items[parent]!.cost <= this.#items[index]!.cost) break
            this.#swap(index, parent)
            index = parent
        }
    }

    #bubbleDown(index: number): void {
        for (;;) {
            const left = index * 2 + 1
            const right = left + 1
            let smallest = index

            if (left < this.#items.length && this.#items[left]!.cost < this.#items[smallest]!.cost) {
                smallest = left
            }
            if (right < this.#items.length && this.#items[right]!.cost < this.#items[smallest]!.cost) {
                smallest = right
            }
            if (smallest === index) break

            this.#swap(index, smallest)
            index = smallest
        }
    }

    #swap(left: number, right: number): void {
        const temporary = this.#items[left]!
        this.#items[left] = this.#items[right]!
        this.#items[right] = temporary
    }
}
