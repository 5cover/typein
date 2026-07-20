import YAML from 'yaml'
import { maskToNames } from './mask.js'
import type { FamilyKind, QueryResult, SolveResult } from './solve.js'
import type { Mask } from './types.js'
import { costCodeValue, printExpression } from './cost.js'

export type CliProfile = {
    totalMs: number
    solveMs: number
    reportMs: number
    verifyMs: number
    emitMs: number
}

export type Counted<T> = {
    count: number
    values: readonly T[]
}

class ReportCollection<T> {
    count: number

    constructor(readonly values: readonly T[]) {
        this.count = values.length
    }
}

export function counted<T>(values: Iterable<T>): Counted<T> {
    return new ReportCollection([...values])
}

export function reportYaml(value: unknown): string {
    return YAML.stringify(reportValue(value), {
        lineWidth: 0,
        sortMapEntries: false,
    })
}

export function reportValue(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString()
    if (value instanceof ReportCollection) return countedValue(value.values)
    if (value instanceof Map) {
        return countedValue([...value.entries()].map(([key, entryValue]) => ({ key, value: entryValue })))
    }
    if (value instanceof Set) return countedValue(value.values())
    if (Array.isArray(value)) return countedValue(value)
    if (value === null || typeof value !== 'object') return value

    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, reportValue(entryValue)]))
}

export function reportJsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString()
    if (value instanceof ReportCollection) return countedValue(value.values)
    if (value instanceof Map) {
        return countedValue([...value.entries()].map(([key, entryValue]) => ({ key, value: entryValue })))
    }
    if (value instanceof Set) return countedValue(value.values())
    if (Array.isArray(value)) return countedValue(value)
    return value
}

function countedValue(values: Iterable<unknown>): Counted<unknown> {
    const normalized = [...values].map(reportValue)
    return { count: normalized.length, values: normalized }
}

export function coverageReport(domain: readonly string[], result: SolveResult) {
    return {
        familyCoverage: counted(
            [...result.familyStats.values()]
                .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.family.localeCompare(b.family))
                .map(stats => ({
                    family: stats.family,
                    kind: stats.kind,
                    candidates: stats.candidates,
                    masks: counted(stats.masks),
                    newMasks: counted(stats.firstMasks),
                    improvements: stats.improvements,
                    winners: counted(stats.winners),
                })),
        ),
        stageCoverage: {
            primitiveUnique: coverageStage(result.stageMasks.primitives.size, result.targetMaskCount),
            withComplements: coverageStage(result.stageMasks.complements.size, result.targetMaskCount),
            afterComposition: coverageStage(result.stageMasks.composition.size, result.targetMaskCount),
            target: coverageStage(result.targetMaskCount, result.targetMaskCount),
        },
        compositionPasses: result.compositionPasses,
    }
}

export function interestReport(domain: readonly string[], result: SolveResult, limit = 10) {
    const entries = result.best
        .entries()
        .map(([mask, expr]) => {
            const names = maskToNames(domain, mask)
            const cost = costCodeValue(expr)
            const entropy = entropyBits(names.length, domain.length)
            return {
                mask,
                cost,
                names,
                entropy,
                score: entropy / cost,
                expression: printExpression(expr, 's'),
            }
        })
        .toArray()
        .sort((a, b) => b.score - a.score || a.expression.localeCompare(b.expression))

    return {
        notableExpressions: counted(entries.slice(0, limit)),
        leastEntropyExpressions: counted(entries.slice(-limit)),
    }
}

export function profileReport(result: SolveResult, cli: CliProfile) {
    const solve = result.profile
    return {
        profile: {
            phasesMs: {
                solvePrimitivesAndComplements: solve.primitiveMs,
                solveComposition: solve.compositionMs,
                solveFinalization: solve.finalizeMs,
                solveTotal: cli.solveMs,
                report: cli.reportMs,
                verify: cli.verifyMs,
                emit: cli.emitMs,
                total: cli.totalMs,
            },
            compositionCounters: {
                targetCandidates: solve.compositionAttempts,
                lowerBoundSkips: solve.compositionPruned,
                materialized: solve.compositionConsidered,
                improvements: solve.compositionImprovements,
                queuedPairs: solve.compositionQueuedPairs,
            },
        },
    }
}

export function queryReport(domain: readonly string[], result: QueryResult) {
    return {
        query: {
            domainValues: domain.length,
            targetValues: counted(result.targetValues),
            targetFound: result.profile.targetFound,
            allowRegex: result.profile.allowRegex,
            proof: result.profile.proof,
            dualAttempted: result.profile.dualAttempted,
            dualImproved: result.profile.dualImproved,
            dualSkippedReason: result.profile.dualSkippedReason,
            dualProof: result.profile.dualProof,
            expression: printExpression(result.expr, 's'),
        },
        queryFamilies: queryFamilyReport(result),
    }
}

export function queryProfileReport(result: QueryResult, cli: CliProfile) {
    const solve = result.profile
    return {
        profile: {
            phasesMs: {
                solvePrimitivesAndComplements: solve.primitiveMs,
                solveComposition: solve.compositionMs,
                solveDual: solve.dualMs,
                solveFinalization: solve.finalizeMs,
                solveTotal: cli.solveMs,
                report: cli.reportMs,
                verify: cli.verifyMs,
                emit: cli.emitMs,
                total: cli.totalMs,
            },
            compositionCounters: {
                primitiveCandidates: solve.primitiveCandidates,
                primitiveDiscarded: solve.primitiveDiscarded,
                exactCandidates: solve.exactCandidates,
                subsetCandidates: solve.subsetCandidates,
                supersetCandidates: solve.supersetCandidates,
                overlapCandidates: solve.overlapCandidates,
                retainedOverlap: solve.retainedOverlap,
                orStates: solve.orStates,
                andStates: solve.andStates,
                dnfStates: solve.dnfStates,
                limits: solve.limits,
                orStateLimitHit: solve.orStateLimitHit,
                andStateLimitHit: solve.andStateLimitHit,
                allowRegex: solve.allowRegex,
                frontierTruncations: solve.frontierTruncations,
                frontierInput: solve.frontierInput,
                frontierKept: solve.frontierKept,
                dnfTermsAttempted: solve.dnfTermsAttempted,
                targetCandidates: solve.compositionAttempts,
                lowerBoundSkips: solve.compositionPruned,
                materialized: solve.compositionConsidered,
                improvements: solve.compositionImprovements,
                queuedPairs: solve.compositionQueuedPairs,
                targetFound: solve.targetFound,
                proof: solve.proof,
                dualAttempted: solve.dualAttempted,
                dualImproved: solve.dualImproved,
                dualSkippedReason: solve.dualSkippedReason,
                dualProof: solve.dualProof,
            },
        },
        queryFamilies: queryFamilyReport(result),
    }
}

function queryFamilyReport(result: QueryResult) {
    return counted(
        [...result.familyStats.values()]
            .sort((a, b) => a.family.localeCompare(b.family))
            .map(stats => ({
                family: stats.family,
                candidates: stats.candidates,
                costPruned: stats.costPruned,
                exact: stats.exact,
                subset: stats.subset,
                superset: stats.superset,
                overlap: stats.overlap,
                unrelated: stats.unrelated,
                retainedSubset: stats.retainedSubset,
                retainedSuperset: stats.retainedSuperset,
                retainedOverlap: stats.retainedOverlap,
                improvements: stats.improvements,
            })),
    )
}

function coverageStage(count: number, target: number) {
    return {
        count,
        coverage: target === 0 ? 0 : count / target,
    }
}

function entropyBits(subsetSize: number, universeSize: number): number {
    const p = subsetSize / universeSize
    return p === 0 || p === 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p)
}

function kindOrder(kind: FamilyKind): number {
    switch (kind) {
        case 'primitive':
            return 0
        case 'complement':
            return 1
        case 'composition':
            return 2
    }
}
