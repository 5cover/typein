import { maskToNames } from './mask.js'
import type { FamilyKind, SolveResult } from './solve.js'
import type { Mask } from './types.js'
import { costCodeValue, printExpression } from './cost.js'

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
            code(row.code),
        ]),
    )
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return ['', markdownRow(headers), markdownRow(headers.map(() => '---')), ...rows.map(markdownRow), ''].join('\n')
}

function markdownRow(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`
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
