import { maskToNames } from './mask.js'
import type { FamilyKind, SolveResult } from './solve.js'
import type { Mask } from './types.js'
import { costCodeValue, printExpression } from './cost.js'

export function interestScore(cost: number, subsetSize: number, universeSize: number): number {
    const p = subsetSize / universeSize
    const entropy =
        p === 0 || p === 1
            ? 0
            : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p)

    return entropy === 0 ? Number.POSITIVE_INFINITY : cost / entropy
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
        ['primitive unique', result.stageMasks.primitives.size.toString(), formatPercent(result.stageMasks.primitives.size / result.targetMaskCount)],
        ['with complements', result.stageMasks.complements.size.toString(), formatPercent(result.stageMasks.complements.size / result.targetMaskCount)],
        ['after composition', result.stageMasks.composition.size.toString(), formatPercent(result.stageMasks.composition.size / result.targetMaskCount)],
        ['target', result.targetMaskCount.toString(), formatPercent(1)],
    ]

    return [
        'family coverage:',
        formatTable(['family', 'kind', 'candidates', 'masks', 'new', 'improvements', 'winners'], familyRows, new Set([2, 3, 4, 5, 6])),
        '',
        'stage coverage:',
        formatTable(['stage', 'masks', 'coverage'], stageRows, new Set([1, 2])),
        `composition passes: ${result.compositionPasses}`,
    ].join('\n')
}

export function interestReport(domain: readonly string[], result: SolveResult, limit = 10): string {
    const ranked = [...result.best.entries()]
        .map(([mask, expr]) => {
            const names = maskToNames(domain, mask)
            return {
                mask,
                names,
                score: interestScore(costCodeValue(expr), names.length, domain.length),
                code: printExpression(expr, 's'),
            }
        })
        .sort((a, b) => a.score - b.score || popcount(b.mask) - popcount(a.mask) || a.code.localeCompare(b.code))
        .slice(0, limit)

    if (ranked.length === 0) return 'interesting expressions: none'

    return [
        'interesting expressions:',
        ...ranked.map(item => {
            const score = Number.isFinite(item.score) ? item.score.toFixed(2) : 'Infinity'
            return `  ${score.padStart(8)}  ${item.names.join(', ')}  ${item.code}`
        }),
    ].join('\n')
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[], rightAligned: ReadonlySet<number>): string {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
    )
    const allRows = [headers, ...rows]

    return allRows
        .map((row, rowIndex) =>
            row
                .map((cell, column) => {
                    const pad = rightAligned.has(column) ? cell.padStart : cell.padEnd
                    return pad.call(cell, widths[column]!)
                })
                .join('  '),
        )
        .flatMap((line, index) => (index === 0 ? [line, widths.map(width => '-'.repeat(width)).join('  ')] : [line]))
        .join('\n')
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
