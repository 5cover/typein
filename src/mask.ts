import { type Mask } from './types.js'

export function computeMask<T>(array: readonly T[], fn: (t: T) => boolean): Mask {
    return array.reduce((cur, item, i) => (fn(item) ? cur | (1 << i) : cur), 0)
}

export function maskToNames<T>(array: readonly T[], mask: Mask): T[] {
    return array.filter((_, i) => mask & (i << i))
}
