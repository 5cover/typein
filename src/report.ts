import { maskToNames } from './mask.js'
import type { SolveResult } from './solve.js'
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
    const familyRows = [...result.primitiveFamilyMasks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, masks]) => [family, `${masks.size} masks`] as const)

    const rows: readonly (readonly [string, string])[] = [
        ...familyRows,
        ['combined unique', `${result.primitiveMasks.size} masks`],
        ['with complements', `${result.withComplements.size} masks`],
        ['after composition', `${result.best.size} masks`],
        ['total target', `${result.targetMaskCount} masks`],
        ['coverage', `${formatPercent(result.best.size / result.targetMaskCount)}`],
    ]

    return formatRows(rows)
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

function formatRows(rows: readonly (readonly [string, string])[]): string {
    const labelWidth = Math.max(...rows.map(([label]) => label.length))
    const valueWidth = Math.max(...rows.map(([, value]) => value.length))
    return rows.map(([label, value]) => `${`${label}:`.padEnd(labelWidth + 1)} ${value.padStart(valueWidth)}`).join('\n')
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

function popcount(mask: Mask): number {
    let count = 0
    for (let n = mask; n; n >>>= 1) count += n & 1
    return count
}
