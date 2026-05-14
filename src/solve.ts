import type { Mask } from './types.js'
import { computeMask } from './mask.js'
import { negate, type Expr } from './ir.js'

export type Best = {
    expr: Expr
    cost: number
}

type Candidate = { expr: Expr; mask: Mask }

export function solve<const S extends string>(S: readonly S[], exprCost: (expr: Expr) => number) {
    const best = new Map<Mask, Best>()
    const fullMask = (1 << S.length) - 1

    for (const { expr, mask } of candidates()) {
        if (mask === 0 || mask === fullMask) continue
        save(expr, mask)
        save(negate(expr), fullMask ^ mask) // also register complement via negation
    }

    return best

    function save(expr: Expr, complement: number) {
        const cost = exprCost(expr)
        const costPrev = best.get(complement)
        if (costPrev === undefined || cost < costPrev.cost) {
            best.set(complement, { expr, cost: cost })
        }
    }
}

function* candidates(): Generator<Candidate> {}
