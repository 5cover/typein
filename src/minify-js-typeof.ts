import tsc, { EmitHint } from 'typescript'
import { builtinDomains } from './domains.js'
import { solveQuery, type QueryFeatures, type QueryLimits } from './solve.js'
import { costComparators } from './cost.js'
import * as compile from './compile.js'
import * as emit from './emit.js'
import { applySourceEdits, selectNonOverlappingEdits, type SourceEdit } from './source-edit.js'
import type { Expr } from './ir.js'

const f = tsc.factory
const typeofDomain = builtinDomains.typeof
const rootPlaceholder = '__typein_root__'
type TypeofValue = (typeof typeofDomain)[number]

export type JsTypeofMinifierOptions = {
    cost: keyof typeof costComparators
    queryLimits: QueryLimits
    queryFeatures: QueryFeatures
    report?: boolean
}

type TypeofAnalysis = {
    target: Set<TypeofValue>
    root: tsc.TypeOfExpression
    rootText: string
    pure: boolean
    typeofCount: number
}

type Replacement = SourceEdit & {
    partition: string
    expression: string
    original: string
    pure: boolean
    typeofCount: number
}

type CacheEntry = {
    partition: string
    expression: string
    uses: number
    originalBytes: number
    replacementBytes: number
    saved: number
}

type Stats = {
    typeofUsages: number
    candidateExpressions: number
    pureCandidates: number
    impureCandidates: number
    unsafeSkipped: number
    notShorterSkipped: number
    replacementsMade: number
    cacheHits: number
    cacheMisses: number
}

export const jsTypeofMinifier = {
    name: 'js.typeof',
    run(source: string, opts: JsTypeofMinifierOptions) {
        return minifyJsTypeof(source, opts)
    },
}

function minifyJsTypeof(source: string, opts: JsTypeofMinifierOptions) {
    const sourceFile = tsc.createSourceFile('input.js', source, tsc.ScriptTarget.Latest, true, tsc.ScriptKind.JS)
    const stats: Stats = {
        typeofUsages: 0,
        candidateExpressions: 0,
        pureCandidates: 0,
        impureCandidates: 0,
        unsafeSkipped: 0,
        notShorterSkipped: 0,
        replacementsMade: 0,
        cacheHits: 0,
        cacheMisses: 0,
    }
    const cache = new Map<string, CacheEntry>()
    const solved = new Map<string, Expr>()
    const candidates: Replacement[] = []

    visit(sourceFile)

    const edits = selectNonOverlappingEdits(candidates)
    stats.replacementsMade = edits.length
    const code = applySourceEdits(source, edits)

    return {
        code,
        report: opts.report ? jsTypeofReport(stats, [...cache.values()]) : undefined,
    }

    function visit(node: tsc.Node): void {
        if (tsc.isTypeOfExpression(node)) stats.typeofUsages++

        if (tsc.isExpression(node)) {
            const replacement = replacementFor(node)
            if (replacement !== undefined) candidates.push(replacement)
        }

        tsc.forEachChild(node, visit)
    }

    function replacementFor(node: tsc.Expression): Replacement | undefined {
        const analysis = analyzeExpression(node)
        if (analysis === undefined) return undefined

        stats.candidateExpressions++
        if (analysis.pure) stats.pureCandidates++
        else stats.impureCandidates++

        const start = node.getStart(sourceFile)
        const end = node.getEnd()
        const original = source.slice(start, end)
        const partition = partitionKey(analysis.target)
        const expressionNode = expressionFor(analysis, partition)
        const emittedExpression = printExpressionNode(expressionNode).replaceAll(rootPlaceholder, `(${analysis.root.getText(sourceFile)})`)
        const replacement = parenthesizeForContext(
            emittedExpression,
            node,
            expressionNode,
        )

        const entry = cache.get(partition) ?? {
            partition,
            expression: genericExpressionFor(analysis.target, partition),
            uses: 0,
            originalBytes: 0,
            replacementBytes: 0,
            saved: 0,
        }
        if (!cache.has(partition)) cache.set(partition, entry)

        entry.uses++
        entry.originalBytes += original.length
        entry.replacementBytes += replacement.length
        entry.saved += original.length - replacement.length

        if (replacement.length >= original.length) {
            stats.notShorterSkipped++
            return undefined
        }

        return {
            start,
            end,
            replacement,
            partition,
            expression: replacement,
            original,
            pure: analysis.pure,
            typeofCount: analysis.typeofCount,
        }
    }

    function expressionFor(analysis: TypeofAnalysis, partition: string): tsc.Expression {
        if (analysis.target.size === 0) return f.createFalse()
        if (analysis.target.size === typeofDomain.length) return f.createTrue()

        const expr = solveExpr(analysis.target, partition, true)

        return compile.expr2ts(expr, {
            root: f.createIdentifier(rootPlaceholder),
            language: 'js',
            equality: 'loose',
            createNonNullExpressions: false,
        })
    }

    function genericExpressionFor(target: ReadonlySet<TypeofValue>, partition: string): string {
        if (target.size === 0) return 'false'
        if (target.size === typeofDomain.length) return 'true'

        const expr = solved.get(partition) ?? solveExpr(target, partition, false)
        return printExpressionNode(
            compile.expr2ts(expr, {
                root: f.createIdentifier('t'),
                language: 'js',
                equality: 'loose',
                createNonNullExpressions: false,
            }),
        )
    }

    function solveExpr(target: ReadonlySet<TypeofValue>, partition: string, countCacheAccess: boolean): Expr {
        const cached = solved.get(partition)
        if (cached !== undefined) {
            if (countCacheAccess) stats.cacheHits++
            return cached
        }

        if (countCacheAccess) stats.cacheMisses++
        const targets = typeofDomain.filter(value => target.has(value))
        const result = solveQuery(
            typeofDomain,
            targets,
            costComparators[opts.cost],
            opts.queryLimits,
            opts.queryFeatures,
        )
        solved.set(partition, result.expr)
        return result.expr
    }

    function analyzeExpression(node: tsc.Expression): TypeofAnalysis | undefined {
        node = skipParens(node)

        if (tsc.isBinaryExpression(node) && isLogicalOperator(node.operatorToken.kind)) {
            const left = analyzeExpression(node.left)
            const right = analyzeExpression(node.right)
            if (left === undefined || right === undefined) {
                if (left !== undefined || right !== undefined) stats.unsafeSkipped++
                return undefined
            }
            if (!left.pure || !right.pure || left.rootText !== right.rootText) return undefined

            return {
                target:
                    node.operatorToken.kind === tsc.SyntaxKind.BarBarToken
                        ? union(left.target, right.target)
                        : intersection(left.target, right.target),
                root: left.root,
                rootText: left.rootText,
                pure: true,
                typeofCount: left.typeofCount + right.typeofCount,
            }
        }

        const comparison = typeofComparison(node)
        if (comparison === undefined) return undefined

        return {
            target: comparisonTarget(comparison.value, comparison.operator),
            root: comparison.root,
            rootText: comparison.root.expression.getText(sourceFile),
            pure: isPureExpression(skipParens(comparison.root.expression)),
            typeofCount: 1,
        }
    }

    function typeofComparison(node: tsc.Expression):
        | {
            root: tsc.TypeOfExpression
            value: TypeofValue
            operator: tsc.SyntaxKind.EqualsEqualsEqualsToken | tsc.SyntaxKind.EqualsEqualsToken | tsc.SyntaxKind.ExclamationEqualsEqualsToken | tsc.SyntaxKind.ExclamationEqualsToken
        }
        | undefined {
        node = skipParens(node)
        if (!tsc.isBinaryExpression(node) || !isEqualityOperator(node.operatorToken.kind)) return undefined

        const leftTypeof = typeOfExpression(node.left)
        const rightTypeof = typeOfExpression(node.right)
        const leftLiteral = stringLiteralValue(node.left)
        const rightLiteral = stringLiteralValue(node.right)

        if (leftTypeof !== undefined && rightLiteral !== undefined) {
            return { root: leftTypeof, value: rightLiteral, operator: node.operatorToken.kind }
        }
        if (rightTypeof !== undefined && leftLiteral !== undefined) {
            return { root: rightTypeof, value: leftLiteral, operator: node.operatorToken.kind }
        }

        return undefined
    }

    function typeOfExpression(node: tsc.Expression): tsc.TypeOfExpression | undefined {
        node = skipParens(node)
        return tsc.isTypeOfExpression(node) ? node : undefined
    }

    function stringLiteralValue(node: tsc.Expression): TypeofValue | undefined {
        node = skipParens(node)
        if (!tsc.isStringLiteral(node)) return undefined
        return isTypeofValue(node.text) ? node.text : undefined
    }

    function parenthesizeForContext(replacement: string, originalNode: tsc.Expression, replacementNode: tsc.Expression): string {
        const parent = originalNode.parent
        if (parent === undefined || tsc.isParenthesizedExpression(parent)) return replacement

        if (
            tsc.isBinaryExpression(parent) &&
            (parent.left === originalNode || parent.right === originalNode) &&
            needsBinaryOperandParens(parent, originalNode, replacementNode)
        ) {
            return `(${replacement})`
        }

        if (
            (tsc.isPrefixUnaryExpression(parent) ||
                tsc.isPostfixUnaryExpression(parent) ||
                tsc.isCallExpression(parent) ||
                tsc.isPropertyAccessExpression(parent) ||
                tsc.isElementAccessExpression(parent) ||
                tsc.isConditionalExpression(parent)) &&
            expressionPrecedence(replacementNode) < expressionPrecedence(originalNode)
        ) {
            return `(${replacement})`
        }

        return replacement
    }
}

function comparisonTarget(
    value: TypeofValue,
    operator: tsc.SyntaxKind,
): Set<TypeofValue> {
    const positive = operator === tsc.SyntaxKind.EqualsEqualsEqualsToken || operator === tsc.SyntaxKind.EqualsEqualsToken
    return new Set(positive ? [value] : typeofDomain.filter(other => other !== value))
}

function isLogicalOperator(kind: tsc.SyntaxKind): boolean {
    return kind === tsc.SyntaxKind.BarBarToken || kind === tsc.SyntaxKind.AmpersandAmpersandToken
}

function isEqualityOperator(kind: tsc.SyntaxKind): kind is
    | tsc.SyntaxKind.EqualsEqualsEqualsToken
    | tsc.SyntaxKind.EqualsEqualsToken
    | tsc.SyntaxKind.ExclamationEqualsEqualsToken
    | tsc.SyntaxKind.ExclamationEqualsToken {
    return (
        kind === tsc.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === tsc.SyntaxKind.EqualsEqualsToken ||
        kind === tsc.SyntaxKind.ExclamationEqualsEqualsToken ||
        kind === tsc.SyntaxKind.ExclamationEqualsToken
    )
}

function isTypeofValue(value: string): value is TypeofValue {
    return (typeofDomain as readonly string[]).includes(value)
}

function skipParens<T extends tsc.Expression>(node: T): tsc.Expression {
    while (tsc.isParenthesizedExpression(node)) node = node.expression as T
    return node
}

function union(left: ReadonlySet<TypeofValue>, right: ReadonlySet<TypeofValue>): Set<TypeofValue> {
    return new Set([...left, ...right])
}

function intersection(left: ReadonlySet<TypeofValue>, right: ReadonlySet<TypeofValue>): Set<TypeofValue> {
    return new Set([...left].filter(value => right.has(value)))
}

function partitionKey(values: ReadonlySet<TypeofValue>): string {
    return typeofDomain.filter(value => values.has(value)).join(' | ') || '<empty>'
}

function printExpressionNode(node: tsc.Expression): string {
    return emit.printer.printNode(EmitHint.Expression, node, emit.sourceFile)
}

function needsBinaryOperandParens(parent: tsc.BinaryExpression, originalNode: tsc.Expression, replacementNode: tsc.Expression): boolean {
    const parentPrecedence = binaryPrecedence(parent.operatorToken.kind)
    const childPrecedence = expressionPrecedence(replacementNode)
    if (childPrecedence < parentPrecedence) return true
    if (childPrecedence > parentPrecedence) return false

    if (parent.right === originalNode) {
        return !isAssociativeBinary(parent.operatorToken.kind)
    }

    return false
}

function expressionPrecedence(node: tsc.Expression): number {
    node = skipParens(node)
    if (tsc.isBinaryExpression(node)) return binaryPrecedence(node.operatorToken.kind)
    if (tsc.isConditionalExpression(node)) return 4
    if (tsc.isArrowFunction(node)) return 2
    if (tsc.isPrefixUnaryExpression(node) || tsc.isTypeOfExpression(node)) return 15
    if (
        tsc.isCallExpression(node) ||
        tsc.isPropertyAccessExpression(node) ||
        tsc.isElementAccessExpression(node) ||
        tsc.isNonNullExpression(node)
    ) {
        return 18
    }
    return 20
}

function binaryPrecedence(kind: tsc.SyntaxKind): number {
    switch (kind) {
        case tsc.SyntaxKind.AsteriskToken:
        case tsc.SyntaxKind.SlashToken:
        case tsc.SyntaxKind.PercentToken:
            return 14
        case tsc.SyntaxKind.PlusToken:
        case tsc.SyntaxKind.MinusToken:
            return 13
        case tsc.SyntaxKind.LessThanLessThanToken:
        case tsc.SyntaxKind.GreaterThanGreaterThanToken:
        case tsc.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            return 12
        case tsc.SyntaxKind.LessThanToken:
        case tsc.SyntaxKind.LessThanEqualsToken:
        case tsc.SyntaxKind.GreaterThanToken:
        case tsc.SyntaxKind.GreaterThanEqualsToken:
        case tsc.SyntaxKind.InstanceOfKeyword:
        case tsc.SyntaxKind.InKeyword:
            return 11
        case tsc.SyntaxKind.EqualsEqualsToken:
        case tsc.SyntaxKind.ExclamationEqualsToken:
        case tsc.SyntaxKind.EqualsEqualsEqualsToken:
        case tsc.SyntaxKind.ExclamationEqualsEqualsToken:
            return 10
        case tsc.SyntaxKind.AmpersandToken:
            return 9
        case tsc.SyntaxKind.CaretToken:
            return 8
        case tsc.SyntaxKind.BarToken:
            return 7
        case tsc.SyntaxKind.AmpersandAmpersandToken:
            return 6
        case tsc.SyntaxKind.BarBarToken:
            return 5
        case tsc.SyntaxKind.QuestionQuestionToken:
            return 4
        default:
            return 1
    }
}

function isAssociativeBinary(kind: tsc.SyntaxKind): boolean {
    return kind === tsc.SyntaxKind.AmpersandAmpersandToken || kind === tsc.SyntaxKind.BarBarToken
}

function isPureExpression(node: tsc.Expression): boolean {
    node = skipParens(node)

    if (
        tsc.isIdentifier(node) ||
        node.kind === tsc.SyntaxKind.ThisKeyword ||
        tsc.isStringLiteral(node) ||
        tsc.isNumericLiteral(node) ||
        node.kind === tsc.SyntaxKind.TrueKeyword ||
        node.kind === tsc.SyntaxKind.FalseKeyword ||
        node.kind === tsc.SyntaxKind.NullKeyword
    ) {
        return true
    }

    if (tsc.isPropertyAccessExpression(node)) return isPureExpression(node.expression)
    if (tsc.isElementAccessExpression(node)) return isPureExpression(node.expression) && isPureExpression(node.argumentExpression)
    if (tsc.isNonNullExpression(node)) return isPureExpression(node.expression)
    if (tsc.isTypeOfExpression(node)) return isPureExpression(node.expression)
    if (tsc.isDeleteExpression(node) || tsc.isAwaitExpression(node) || tsc.isYieldExpression(node)) return false

    if (tsc.isPrefixUnaryExpression(node)) {
        return isPureExpression(node.operand)
    }

    if (tsc.isBinaryExpression(node)) {
        if (isAssignmentOperator(node.operatorToken.kind)) return false
        return isPureExpression(node.left) && isPureExpression(node.right)
    }

    if (tsc.isConditionalExpression(node)) {
        return isPureExpression(node.condition) && isPureExpression(node.whenTrue) && isPureExpression(node.whenFalse)
    }

    return false
}

function isAssignmentOperator(kind: tsc.SyntaxKind): boolean {
    return kind >= tsc.SyntaxKind.FirstAssignment && kind <= tsc.SyntaxKind.LastAssignment
}

function jsTypeofReport(stats: Stats, cache: readonly CacheEntry[]): string {
    const rows = [
        ['typeof usages', stats.typeofUsages.toString()],
        ['candidate expressions', stats.candidateExpressions.toString()],
        ['pure candidates', stats.pureCandidates.toString()],
        ['impure candidates', stats.impureCandidates.toString()],
        ['unsafe skipped', stats.unsafeSkipped.toString()],
        ['not shorter skipped', stats.notShorterSkipped.toString()],
        ['replacements made', stats.replacementsMade.toString()],
        ['cache hits', stats.cacheHits.toString()],
        ['cache misses', stats.cacheMisses.toString()],
    ]
    const cacheRows = [...cache]
        .sort((a, b) => a.partition.localeCompare(b.partition))
        .map(entry => [
            entry.partition,
            code(entry.expression),
            entry.uses.toString(),
            entry.originalBytes.toString(),
            entry.replacementBytes.toString(),
            entry.saved.toString(),
        ])

    return [
        '### js.typeof',
        '',
        markdownTable(['field', 'value'], rows),
        '',
        'Expressions',
        '',
        markdownTable(['partition', 'expression', 'uses', 'original bytes', 'replacement bytes', 'saved'], cacheRows),
    ].join('\n')
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    ].join('\n')
}

function code(value: string): string {
    return `\`${value.replaceAll('`', '\\`')}\``
}

function escapeMarkdownCell(value: string): string {
    return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}
