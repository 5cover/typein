import { jsTypeofMinifier, type JsTypeofMinifierOptions } from './minify-js-typeof.js'

export type MinifierOptions = JsTypeofMinifierOptions

export type MinifierResult = {
    code: string
    report?: string
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
    detail?: string,
): string {
    const saved = inputLength - outputLength
    const percentage = inputLength === 0 ? 0 : (saved / inputLength) * 100
    return [
        `## ${index}. ${name}`,
        '',
        markdownTable(
            ['field', 'value'],
            [
                ['input length', inputLength.toString()],
                ['output length', outputLength.toString()],
                ['saved bytes', saved.toString()],
                ['saved percent', `${percentage.toFixed(2)}%`],
            ],
        ),
        detail ? `\n${detail}` : '',
    ].join('\n')
}

export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    ].join('\n')
}

export function code(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``
}

function escapeMarkdownCell(value: string): string {
    return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}
