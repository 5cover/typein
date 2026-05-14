import tsc from 'typescript'
import type { Expr, Op } from './ir.js'
const f = tsc.factory
export function ts(expr: Expr, variable = 's'): tsc.Expression {
    const left = featureToExpression(expr, variable)
    const right = literalToExpression(expr.value)
    return f.createBinaryExpression(left, opToToken(expr.op), right)
}
function featureToExpression(expr: Expr, variable: string): tsc.Expression {
    const s = f.createIdentifier(variable)
    switch (expr.feature.t) {
        case 'self':
            return s
        case 'length':
            return f.createPropertyAccessExpression(s, 'length')
        case 'charAt':
            return f.createElementAccessExpression(s, f.createNumericLiteral(expr.feature.index))
        case 'charCodeAt':
            return f.createCallExpression(f.createPropertyAccessExpression(s, 'charCodeAt'), undefined, [
                f.createNumericLiteral(expr.feature.index),
            ])
        case 'startsWith':
            return f.createCallExpression(f.createPropertyAccessExpression(s, 'startsWith'), undefined, [
                f.createStringLiteral(expr.feature.value),
            ])
        case 'endsWith':
            return f.createCallExpression(f.createPropertyAccessExpression(s, 'endsWith'), undefined, [
                f.createStringLiteral(expr.feature.value),
            ])
        case 'includes':
            return f.createCallExpression(f.createPropertyAccessExpression(s, 'includes'), undefined, [
                f.createStringLiteral(expr.feature.value),
            ])
    }
}
function literalToExpression(value: string | number | boolean): tsc.Expression {
    switch (typeof value) {
        case 'string':
            return f.createStringLiteral(value)
        case 'number':
            return f.createNumericLiteral(value)
        case 'boolean':
            return value ? f.createTrue() : f.createFalse()
    }
}
function opToToken(op: Op): tsc.BinaryOperatorToken {
    switch (op) {
        case '===':
            return f.createToken(tsc.SyntaxKind.EqualsEqualsEqualsToken)
        case '!==':
            return f.createToken(tsc.SyntaxKind.ExclamationEqualsEqualsToken)
        // case '<':
        //     return f.createToken(tsc.SyntaxKind.LessThanToken)
        // case '>':
        //     return f.createToken(tsc.SyntaxKind.GreaterThanToken)
        // case '<=':
        //     return f.createToken(tsc.SyntaxKind.LessThanEqualsToken)
        // case '>=':
        //     return f.createToken(tsc.SyntaxKind.GreaterThanEqualsToken)
    }
}
