import * as emit from './emit.js'
import type { Expr } from './ir.js'
import { solve } from './solve.js'

const S = ['bigint', 'boolean', 'function', 'number', 'object', 'string', 'symbol', 'undefined'] as const
const best = solve(S, cost)

console.log(emit.tsModule(S, best, 'Typestring'))

export function cost(code: Expr): number {
    return 0
}
