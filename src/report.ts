import { maskToNames } from './mask.js'
import type { FamilyKind, QueryResult, SolveResult } from './solve.js'
import type { Mask } from './types.js'
import { costCodeValue, printExpression } from './cost.js'
import { markdownCode, markdownTable } from './markdown.js'

export type CliProfile = {
    totalMs: number
    solveMs: number
    reportMs: number
    verifyMs: number
    emitMs: number
}

export function coverageReport(domain: readonly string[], result: SolveResult): string {
    const familyRows = [...result.familyStats.values()]
        .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.family.localeCompare(b.family))
        .map(stats => [
            stats.family,
            stats.kind,
            stats.candidates.toString(),
            stats.masks.size.toString(),
            stats.firstMasks.size.toString(),
            stats.improvements.toString(),
            stats.winners.size.toString(),
        ])

    const stageRows = [
        [
            'primitive unique',
            result.stageMasks.primitives.size.toString(),
            formatPercent(result.stageMasks.primitives.size / result.targetMaskCount),
        ],
        [
            'with complements',
            result.stageMasks.complements.size.toString(),
            formatPercent(result.stageMasks.complements.size / result.targetMaskCount),
        ],
        [
            'after composition',
            result.stageMasks.composition.size.toString(),
            formatPercent(result.stageMasks.composition.size / result.targetMaskCount),
        ],
        ['target', result.targetMaskCount.toString(), formatPercent(1)],
    ]

    return [
        '## Family Coverage',
        markdownTable(['family', 'kind', 'candidates', 'masks', 'new', 'improvements', 'winners'], familyRows),
        '## Stage Coverage',
        markdownTable(['stage', 'masks', 'coverage'], stageRows),
        `Composition passes: ${result.compositionPasses}`,
    ].join('\n')
}

export function interestReport(domain: readonly string[], result: SolveResult, limit = 10): string {
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
                code: printExpression(expr, 's'),
            }
        })
        .toArray()
        .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))

    const best = entries.slice(0, limit)
    const worst = entries.slice(-limit)

    return ['## Notable Expressions', formatExpressionTable([...best, ...worst])].join('\n')
}

export function profileReport(result: SolveResult, cli: CliProfile): string {
    const solve = result.profile
    return [
        '## Profile',
        markdownTable(
            ['phase', 'ms'],
            [
                ['solve primitives+complements', formatNumber(solve.primitiveMs)],
                ['solve composition', formatNumber(solve.compositionMs)],
                ['solve finalization', formatNumber(solve.finalizeMs)],
                ['solve total', formatNumber(cli.solveMs)],
                ['report', formatNumber(cli.reportMs)],
                ['verify', formatNumber(cli.verifyMs)],
                ['emit', formatNumber(cli.emitMs)],
                ['total', formatNumber(cli.totalMs)],
            ],
        ),
        '## Composition Counters',
        markdownTable(
            ['counter', 'count'],
            [
                ['target candidates', solve.compositionAttempts.toString()],
                ['lower-bound skips', solve.compositionPruned.toString()],
                ['materialized', solve.compositionConsidered.toString()],
                ['improvements', solve.compositionImprovements.toString()],
                ['queued pairs', solve.compositionQueuedPairs.toString()],
            ],
        ),
    ].join('\n')
}

export function queryReport(domain: readonly string[], result: QueryResult): string {
    return [
        '## Query',
        markdownTable(
            ['field', 'value'],
            [
                ['domain values', domain.length.toString()],
                ['target values', result.targetValues.length.toString()],
                ['target found', result.profile.targetFound ? 'yes' : 'no'],
                ['allow regex', result.profile.allowRegex ? 'yes' : 'no'],
                ['proof', result.profile.proof],
                ['expression', markdownCode(printExpression(result.expr, 's'))],
            ],
        ),
        queryFamilyTable(result),
    ].join('\n')
}

export function queryProfileReport(result: QueryResult, cli: CliProfile): string {
    const solve = result.profile
    return [
        '## Profile',
        markdownTable(
            ['phase', 'ms'],
            [
                ['solve primitives+complements', formatNumber(solve.primitiveMs)],
                ['solve composition', formatNumber(solve.compositionMs)],
                ['solve finalization', formatNumber(solve.finalizeMs)],
                ['solve total', formatNumber(cli.solveMs)],
                ['report', formatNumber(cli.reportMs)],
                ['verify', formatNumber(cli.verifyMs)],
                ['emit', formatNumber(cli.emitMs)],
                ['total', formatNumber(cli.totalMs)],
            ],
        ),
        '## Composition Counters',
        markdownTable(
            ['counter', 'count'],
            [
                ['primitive candidates', solve.primitiveCandidates.toString()],
                ['primitive discarded', solve.primitiveDiscarded.toString()],
                ['exact candidates', solve.exactCandidates.toString()],
                ['subset candidates', solve.subsetCandidates.toString()],
                ['superset candidates', solve.supersetCandidates.toString()],
                ['overlap candidates', solve.overlapCandidates.toString()],
                ['retained overlap', solve.retainedOverlap.toString()],
                ['OR states', solve.orStates.toString()],
                ['AND states', solve.andStates.toString()],
                ['DNF states', solve.dnfStates.toString()],
                ['OR state limit', solve.limits.orStates.toString()],
                ['AND state limit', solve.limits.andStates.toString()],
                ['OR state limit hit', solve.orStateLimitHit ? 'yes' : 'no'],
                ['AND state limit hit', solve.andStateLimitHit ? 'yes' : 'no'],
                ['superset pre-frontier limit', solve.limits.supersetPreFrontier.toString()],
                ['superset frontier limit', solve.limits.supersetFrontier.toString()],
                ['DNF frontier limit', solve.limits.dnfFrontier.toString()],
                ['allow regex', solve.allowRegex ? 'yes' : 'no'],
                ['frontier truncations', solve.frontierTruncations.toString()],
                ['frontier input', solve.frontierInput.toString()],
                ['frontier kept', solve.frontierKept.toString()],
                ['DNF terms attempted', solve.dnfTermsAttempted.toString()],
                ['target candidates', solve.compositionAttempts.toString()],
                ['lower-bound skips', solve.compositionPruned.toString()],
                ['materialized', solve.compositionConsidered.toString()],
                ['improvements', solve.compositionImprovements.toString()],
                ['queued pairs', solve.compositionQueuedPairs.toString()],
                ['target found', solve.targetFound ? 'yes' : 'no'],
                ['proof', solve.proof],
            ],
        ),
        queryFamilyTable(result),
    ].join('\n')
}

function queryFamilyTable(result: QueryResult): string {
    const rows = [...result.familyStats.values()]
        .sort((a, b) => a.family.localeCompare(b.family))
        .map(stats => [
            stats.family,
            stats.candidates.toString(),
            stats.costPruned.toString(),
            stats.exact.toString(),
            stats.subset.toString(),
            stats.superset.toString(),
            stats.overlap.toString(),
            stats.unrelated.toString(),
            stats.retainedSubset.toString(),
            stats.retainedSuperset.toString(),
            stats.retainedOverlap.toString(),
            stats.improvements.toString(),
        ])

    return [
        '## Query Families',
        markdownTable(
            [
                'family',
                'candidates',
                'cost-pruned',
                'exact',
                'subset',
                'superset',
                'overlap',
                'unrelated',
                'kept subset',
                'kept superset',
                'kept overlap',
                'improvements',
            ],
            rows,
        ),
    ].join('\n')
}

function entropyBits(subsetSize: number, universeSize: number): number {
    const p = subsetSize / universeSize
    return p === 0 || p === 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p)
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

function formatExpressionTable(
    rows: readonly {
        cost: number
        score: number
        entropy: number
        names: readonly string[]
        code: string
    }[],
): string {
    return markdownTable(
        ['score', 'cost', 'entropy', 'partition', 'expression'],
        rows.map(row => [
            formatNumber(row.score),
            formatNumber(row.cost),
            formatNumber(row.entropy),
            row.names.join(' '),
            markdownCode(row.code),
        ]),
    )
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toFixed(3) : 'Infinity'
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

function popcount(mask: Mask): number {
    let count = 0
    for (let n = mask; n; n >>>= 1) count += n & 1
    return count
}
