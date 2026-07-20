export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        `| ${headers.map(escapeMarkdownCell).join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    ].join('\n')
}

export function markdownCode(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``
}

function escapeMarkdownCell(value: string): string {
    return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}
