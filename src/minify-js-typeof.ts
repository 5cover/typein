import tsc, { EmitHint } from 'typescript'
import { builtinDomains } from './domains.js'
import { solveQuery, type QueryFeatures, type QueryLimits } from './solve.js'
import { costComparators } from './cost.js'
import * as compile from './compile.js'
import * as emit from './emit.js'
import { applySourceEdits, selectNonOverlappingEdits, type SourceEdit } from './source-edit.js'
import type { Expr } from './ir.js'
import type { Mask } from './types.js'
import { computeMask, maskToNames } from './mask.js'
import { counted } from './report.js'

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
    kind: 'atom' | 'merged-logical'
}

type SourceLocation = {
    line: number
    column: number
}

type SourceSpan = SourceLocation & {
    start: number
    end: number
    text: string
}

type RewriteCandidate = SourceEdit & {
    source: SourceSpan
    kind: TypeofAnalysis['kind']
    partition: string
}

type CacheEntry = {
    mask: Mask
    expression: string
    uses: number
    originalBytes: number
    replacementBytes: number
    saved: number
}

type Stats = {
    typeofUsages: number
    comparisonAtoms: number
    pureAtoms: number
    notProvenPureAtoms: number
    logicalExpressions: number
    pureLogicalMerged: number
    notProvenPureLogicalSplit: number
    mixedOperandLogicalSplit: number
    partialLogicalSkipped: number
    candidateExpressions: number
    individualCandidates: number
    mergedCandidates: number
    notShorterSkipped: number
    replacementsMade: number
    cacheHits: number
    cacheMisses: number
}

type JsTypeofReport = {
    stats: Stats
    typeofUsages: ReturnType<typeof counted<SourceSpan>>
    comparisonAtoms: ReturnType<typeof counted<SourceSpan & { operand: string; pure: boolean; partition: string }>>
    notProvenPureAtoms: ReturnType<typeof counted<SourceSpan & { operand: string; reason: string; partition: string }>>
    logicalDecisions: {
        pureMerged: ReturnType<typeof counted<SourceSpan & { operand: string; partition: string; typeofCount: number }>>
        notProvenPureSplit: ReturnType<typeof counted<SourceSpan & { operand: string; reason: string }>>
        mixedOperandSplit: ReturnType<typeof counted<SourceSpan & { leftOperand: string; rightOperand: string }>>
        partialSkipped: ReturnType<typeof counted<SourceSpan>>
    }
    replacementCandidates: ReturnType<typeof counted<ReturnType<typeof replacementReport>>>
    selectedReplacements: ReturnType<typeof counted<ReturnType<typeof replacementReport>>>
    notShorter: ReturnType<typeof counted<SourceSpan & { replacement: string; partition: string; savedBytes: number }>>
    expressions: ReturnType<typeof counted<ReturnType<typeof cacheEntryReport>>>
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
        comparisonAtoms: 0,
        pureAtoms: 0,
        notProvenPureAtoms: 0,
        logicalExpressions: 0,
        pureLogicalMerged: 0,
        notProvenPureLogicalSplit: 0,
        mixedOperandLogicalSplit: 0,
        partialLogicalSkipped: 0,
        candidateExpressions: 0,
        individualCandidates: 0,
        mergedCandidates: 0,
        notShorterSkipped: 0,
        replacementsMade: 0,
        cacheHits: 0,
        cacheMisses: 0,
    }
    const cache = new Map<Mask, CacheEntry>()
    const solved = new Map<Mask, Expr>()
    const candidates: RewriteCandidate[] = []
    const typeofUsages: SourceSpan[] = []
    const comparisonAtoms: (SourceSpan & { operand: string; pure: boolean; partition: string })[] = []
    const notProvenPureAtoms: (SourceSpan & { operand: string; reason: string; partition: string })[] = []
    const pureMerged: (SourceSpan & { operand: string; partition: string; typeofCount: number })[] = []
    const notProvenPureSplit: (SourceSpan & { operand: string; reason: string })[] = []
    const mixedOperandSplit: (SourceSpan & { leftOperand: string; rightOperand: string })[] = []
    const partialSkipped: SourceSpan[] = []
    const notShorter: (SourceSpan & { replacement: string; partition: string; savedBytes: number })[] = []

    visit(sourceFile)

    const edits = selectNonOverlappingEdits(candidates)
    const selected = new Set(edits.map(editKey))
    stats.replacementsMade = edits.length
    const code = applySourceEdits(source, edits)

    return {
        code,
        report: opts.report ? jsTypeofReport() : undefined,
    }

    function visit(node: tsc.Node): void {
        if (tsc.isTypeOfExpression(node)) {
            stats.typeofUsages++
            typeofUsages.push(spanFor(node))
        }

        if (tsc.isExpression(node)) {
            const replacement = replacementFor(node)
            if (replacement !== undefined) candidates.push(replacement)
        }

        tsc.forEachChild(node, visit)
    }

    function replacementFor(node: tsc.Expression): RewriteCandidate | undefined {
        const analysis = analyzeExpression(node, true)
        if (analysis === undefined) return undefined

        stats.candidateExpressions++
        if (analysis.kind === 'atom') stats.individualCandidates++
        else stats.mergedCandidates++

        const start = node.getStart(sourceFile)
        const end = node.getEnd()
        const original = source.slice(start, end)
        const mask = maskFor(analysis.target)
        const expressionNode = expressionFor(analysis, mask)
        const emittedExpression = printExpressionNode(expressionNode).replaceAll(rootPlaceholder, `(${analysis.root.getText(sourceFile)})`)
        const replacement = parenthesizeForContext(
            emittedExpression,
            node,
            expressionNode,
        )

        const entry = cache.get(mask) ?? {
            mask,
            expression: genericExpressionFor(analysis.target, mask),
            uses: 0,
            originalBytes: 0,
            replacementBytes: 0,
            saved: 0,
        }
        if (!cache.has(mask)) cache.set(mask, entry)

        entry.uses++
        entry.originalBytes += original.length
        entry.replacementBytes += replacement.length
        entry.saved += original.length - replacement.length

        if (replacement.length >= original.length) {
            stats.notShorterSkipped++
            notShorter.push({
                ...spanFor(node),
                replacement,
                partition: partitionLabel(mask),
                savedBytes: original.length - replacement.length,
            })
            return undefined
        }

        return {
            start,
            end,
            replacement,
            source: spanFor(node),
            kind: analysis.kind,
            partition: partitionLabel(mask),
        }
    }

    function expressionFor(analysis: TypeofAnalysis, mask: Mask): tsc.Expression {
        if (analysis.target.size === 0) return f.createFalse()
        if (analysis.target.size === typeofDomain.length) return f.createTrue()

        const expr = solveExpr(analysis.target, mask, true)

        return compile.expr2ts(expr, {
            root: f.createIdentifier(rootPlaceholder),
            language: 'js',
            equality: 'loose',
            createNonNullExpressions: false,
        })
    }

    function genericExpressionFor(target: ReadonlySet<TypeofValue>, mask: Mask): string {
        if (target.size === 0) return 'false'
        if (target.size === typeofDomain.length) return 'true'

        const expr = solved.get(mask) ?? solveExpr(target, mask, false)
        return printExpressionNode(
            compile.expr2ts(expr, {
                root: f.createIdentifier('t'),
                language: 'js',
                equality: 'loose',
                createNonNullExpressions: false,
            }),
        )
    }

    function solveExpr(target: ReadonlySet<TypeofValue>, mask: Mask, countCacheAccess: boolean): Expr {
        const cached = solved.get(mask)
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
        solved.set(mask, result.expr)
        return result.expr
    }

    function analyzeExpression(node: tsc.Expression, countStats: boolean): TypeofAnalysis | undefined {
        node = skipParens(node)

        if (tsc.isBinaryExpression(node) && isLogicalOperator(node.operatorToken.kind)) {
            const left = analyzeExpression(node.left, false)
            const right = analyzeExpression(node.right, false)
            if (left === undefined && right === undefined) return undefined

            if (countStats) stats.logicalExpressions++
            if (left === undefined || right === undefined) {
                if (countStats && (left !== undefined || right !== undefined)) {
                    stats.partialLogicalSkipped++
                    partialSkipped.push(spanFor(node))
                }
                return undefined
            }
            if (left.rootText !== right.rootText) {
                if (countStats) {
                    stats.mixedOperandLogicalSplit++
                    mixedOperandSplit.push({
                        ...spanFor(node),
                        leftOperand: left.rootText,
                        rightOperand: right.rootText,
                    })
                }
                return undefined
            }
            if (!left.pure || !right.pure) {
                if (countStats) {
                    stats.notProvenPureLogicalSplit++
                    notProvenPureSplit.push({
                        ...spanFor(node),
                        operand: left.rootText,
                        reason: pureFailureReason(skipParens(left.root.expression)),
                    })
                }
                return undefined
            }

            const target =
                node.operatorToken.kind === tsc.SyntaxKind.BarBarToken
                    ? union(left.target, right.target)
                    : intersection(left.target, right.target)

            if (countStats) {
                stats.pureLogicalMerged++
                pureMerged.push({
                    ...spanFor(node),
                    operand: left.rootText,
                    partition: partitionLabel(maskFor(target)),
                    typeofCount: left.typeofCount + right.typeofCount,
                })
            }

            return {
                target,
                root: left.root,
                rootText: left.rootText,
                pure: true,
                typeofCount: left.typeofCount + right.typeofCount,
                kind: 'merged-logical',
            }
        }

        const comparison = typeofComparison(node)
        if (comparison === undefined) return undefined
        const pure = isPureExpression(skipParens(comparison.root.expression))
        if (countStats) {
            stats.comparisonAtoms++
            if (pure) stats.pureAtoms++
            else stats.notProvenPureAtoms++

            const atom = {
                ...spanFor(node),
                operand: comparison.root.expression.getText(sourceFile),
                pure,
                partition: partitionLabel(maskFor(comparisonTarget(comparison.value, comparison.operator))),
            }
            comparisonAtoms.push(atom)
            if (!pure) {
                notProvenPureAtoms.push({
                    ...atom,
                    reason: pureFailureReason(skipParens(comparison.root.expression)),
                })
            }
        }

        return {
            target: comparisonTarget(comparison.value, comparison.operator),
            root: comparison.root,
            rootText: comparison.root.expression.getText(sourceFile),
            pure,
            typeofCount: 1,
            kind: 'atom',
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

    function jsTypeofReport(): JsTypeofReport {
        return {
            stats,
            typeofUsages: counted(typeofUsages),
            comparisonAtoms: counted(comparisonAtoms),
            notProvenPureAtoms: counted(notProvenPureAtoms),
            logicalDecisions: {
                pureMerged: counted(pureMerged),
                notProvenPureSplit: counted(notProvenPureSplit),
                mixedOperandSplit: counted(mixedOperandSplit),
                partialSkipped: counted(partialSkipped),
            },
            replacementCandidates: counted(candidates.map(replacementReport)),
            selectedReplacements: counted(candidates.filter(candidate => selected.has(editKey(candidate))).map(replacementReport)),
            notShorter: counted(notShorter),
            expressions: counted([...cache.values()].sort((a, b) => a.mask - b.mask).map(cacheEntryReport)),
        }
    }

    function spanFor(node: tsc.Node): SourceSpan {
        const start = node.getStart(sourceFile)
        const position = sourceFile.getLineAndCharacterOfPosition(start)
        return {
            start,
            end: node.getEnd(),
            line: position.line + 1,
            column: position.character + 1,
            text: source.slice(start, node.getEnd()),
        }
    }
}

function replacementReport(candidate: RewriteCandidate) {
    return {
        ...candidate.source,
        replacement: candidate.replacement,
        kind: candidate.kind,
        partition: candidate.partition,
    }
}

function editKey(edit: SourceEdit): string {
    return `${edit.start}:${edit.end}:${edit.replacement}`
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

function maskFor(values: ReadonlySet<TypeofValue>): Mask {
    return computeMask(typeofDomain, value => values.has(value))
}

function partitionLabel(mask: Mask): string {
    return maskToNames(typeofDomain, mask).join(' ') || '<empty>'
}

function printExpressionNode(node: tsc.Expression): string {
    return emit.printer.printNode(EmitHint.Expression, node, emit.sourceFile)
}

function cacheEntryReport(entry: CacheEntry) {
    return {
        partition: partitionLabel(entry.mask),
        expression: entry.expression,
        uses: entry.uses,
        originalBytes: entry.originalBytes,
        replacementBytes: entry.replacementBytes,
        savedBytes: entry.saved,
    }
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

function pureFailureReason(node: tsc.Expression): string {
    node = skipParens(node)
    if (tsc.isCallExpression(node)) return 'call expression'
    if (tsc.isNewExpression(node)) return 'new expression'
    if (tsc.isDeleteExpression(node)) return 'delete expression'
    if (tsc.isAwaitExpression(node)) return 'await expression'
    if (tsc.isYieldExpression(node)) return 'yield expression'
    if (tsc.isPostfixUnaryExpression(node) || tsc.isPrefixUnaryExpression(node)) return tsc.tokenToString(node.operator) ?? 'unary expression'
    if (tsc.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) return 'assignment expression'
    if (tsc.isElementAccessExpression(node)) return pureFailureReason(node.argumentExpression)
    if (tsc.isPropertyAccessExpression(node)) return pureFailureReason(node.expression)
    if (tsc.isBinaryExpression(node)) {
        if (!isPureExpression(node.left)) return pureFailureReason(node.left)
        if (!isPureExpression(node.right)) return pureFailureReason(node.right)
    }
    return tsc.SyntaxKind[node.kind] ?? 'unknown expression'
}

function isAssignmentOperator(kind: tsc.SyntaxKind): boolean {
    return kind >= tsc.SyntaxKind.FirstAssignment && kind <= tsc.SyntaxKind.LastAssignment
}
