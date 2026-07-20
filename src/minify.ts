import { jsTypeofMinifier, type JsTypeofMinifierOptions } from './minify-js-typeof.js'

export type MinifierOptions = JsTypeofMinifierOptions

export type MinifierResult = {
    code: string
    report?: unknown
}

export type Minifier = {
    name: string
    run(source: string, opts: MinifierOptions): MinifierResult
}

const minifiers = {
    'js.typeof': jsTypeofMinifier,
} as const satisfies Record<string, Minifier>

export type MinifierName = keyof typeof minifiers

export const minifierNames = Object.keys(minifiers) as MinifierName[]

export function getMinifier(name: string): Minifier | undefined {
    return minifiers[name as MinifierName]
}

export function minifyReport(
    index: number,
    name: string,
    inputLength: number,
    outputLength: number,
    extra: Record<string, unknown> = {},
) {
    const saved = inputLength - outputLength
    const percentage = inputLength === 0 ? 0 : (saved / inputLength) * 100
    return {
        index,
        name,
        inputBytes: inputLength,
        outputBytes: outputLength,
        savedBytes: saved,
        savedPercent: percentage,
        ...extra,
    }
}
