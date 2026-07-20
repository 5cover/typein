export type SourceEdit = {
    start: number
    end: number
    replacement: string
}

export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
    let cursor = source.length
    let output = ''

    for (const edit of sorted) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
            throw new Error(`invalid source edit span ${edit.start}:${edit.end}`)
        }
        if (edit.end > cursor) throw new Error(`overlapping source edit span ${edit.start}:${edit.end}`)

        output = source.slice(edit.end, cursor) + output
        output = edit.replacement + output
        cursor = edit.start
    }

    return source.slice(0, cursor) + output
}

export function selectNonOverlappingEdits(edits: readonly SourceEdit[]): SourceEdit[] {
    const selected: SourceEdit[] = []
    const byLargestFirst = [...edits].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)

    for (const edit of byLargestFirst) {
        if (selected.some(existing => overlaps(edit, existing))) continue
        selected.push(edit)
    }

    return selected.sort((a, b) => a.start - b.start)
}

function overlaps(left: SourceEdit, right: SourceEdit): boolean {
    return left.start < right.end && right.start < left.end
}
