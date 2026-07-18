import { maskToNames } from './mask.js'
import type { FamilyKind, SolveResult } from './solve.js'
import type { Mask } from './types.js'
import { costCodeValue, printExpression } from './cost.js'

export function interestScore(cost: number, subsetSize: number, universeSize: number): number {
    const entropy = entropyBits(subsetSize, universeSize)

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
        '## Family Coverage',
        formatMarkdownTable(['family', 'kind', 'candidates', 'masks', 'new', 'improvements', 'winners'], familyRows),
        '',
        '## Stage Coverage',
        formatMarkdownTable(['stage', 'masks', 'coverage'], stageRows),
        '',
        `composition passes: ${result.compositionPasses}`,
    ].join('\n')
}

export function interestReport(domain: readonly string[], result: SolveResult, limit = 10): string {
    const entries = [...result.best.entries()]
        .map(([mask, expr]) => {
            const names = maskToNames(domain, mask)
            const cost = costCodeValue(expr)
            const entropy = entropyBits(names.length, domain.length)
            return {
                mask,
                names,
                entropy,
                score: interestScore(cost, names.length, domain.length),
                code: printExpression(expr, 's'),
            }
        })

    const notable = entries
        .toSorted((a, b) => a.score - b.score || popcount(b.mask) - popcount(a.mask) || a.code.localeCompare(b.code))
        .slice(0, limit)

    const leastEntropy = entries
        .toSorted((a, b) => a.entropy - b.entropy || a.score - b.score || a.code.localeCompare(b.code))
        .slice(0, limit)

    if (entries.length === 0) return '## Interesting Expressions\n\nnone'

    return [
        '## Interesting Expressions',
        formatExpressionTable(notable),
        '',
        '## Least Entropy Expressions',
        formatExpressionTable(leastEntropy),
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
        entropy: number
        names: readonly string[]
        code: string
    }[],
): string {
    return formatMarkdownTable(
        ['entropy', 'partition', 'expression'],
        rows.map(row => [formatNumber(row.entropy), row.names.join(', '), code(row.code)]),
    )
}

function formatMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        markdownRow(headers),
        markdownRow(headers.map(() => '---')),
        ...rows.map(markdownRow),
    ].join('\n')
}

function markdownRow(cells: readonly string[]): string {
    return `| ${cells.map(escapeMarkdownCell).join(' | ')} |`
}

function escapeMarkdownCell(cell: string): string {
    return cell.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function code(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``
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
