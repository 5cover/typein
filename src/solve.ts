import type { Mask } from './types.js'
import { negateInPlace, type Expr, type Feature } from './ir.js'
import { computeMask } from './mask.js'

type Candidate = { expr: Expr; mask: Mask; family: string }

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
) {
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

    function save(expr: Expr, mask: number) {
        const current = best.get(mask)
        const newCostsLess = current === undefined || exprCostCompare(expr, current) < 0
        if (newCostsLess) best.set(mask, expr)
    }

    function addFamilyMask(family: string, mask: Mask) {
        const masks = primitiveFamilyMasks.get(family)
        if (masks) masks.add(mask)
        else primitiveFamilyMasks.set(family, new Set([mask]))
    }

    function* candidates(): Generator<Candidate> {
        const m = metrics()
        // Length
        {
            const haveLessThanThisLength: Domain[] = []
            for (let length = m.minLength; length <= m.maxLength; ++length) {
                yield {
                    family: 'length relations',
                    mask: computeMask(domain, s => haveLessThanThisLength.includes(s)),
                    expr: {
                        feature: {
                            type: 'length',
                            child: {
                                type: '<',
                                args: { type: 'lit', args: length },
                            },
                        },
                    },
                }
                const haveThisLength = domain.filter(s => s.length === length)
                yield {
                    family: 'length relations',
                    mask: computeMask(domain, s => haveThisLength.includes(s)),
                    expr: {
                        feature: {
                            type: 'length',
                            child: {
                                type: '=',
                                args: { type: 'lit', args: length },
                            },
                        },
                    },
                }
                haveLessThanThisLength.push(...haveThisLength)
                yield {
                    family: 'length relations',
                    mask: computeMask(domain, s => haveLessThanThisLength.includes(s)),
                    expr: {
                        feature: {
                            type: 'length',
                            child: {
                                type: '<=',
                                args: { type: 'lit', args: length },
                            },
                        },
                    },
                }
            }
        }
        // charAt
        {
            for (let i = 0; i < m.maxLength; ++i) {
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
            }
        }
    }

    function metrics() {
        let minLength = Infinity
        let maxLength = -Infinity
        for (const s of domain) {
            if (s.length < minLength) minLength = s.length
            if (s.length > maxLength) maxLength = s.length
        }
        return { minLength, maxLength }
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
