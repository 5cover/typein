import tsc from 'typescript'
import type { Expr, Feature } from './ir.js'
const f = tsc.factory
export function expr2ts(expr: Expr, variable = 'x'): tsc.Expression {
    if ('type' in expr) return exprToExpression(expr, variable)
    return featureToExpression(f.createIdentifier(variable), expr.feature)
}

function exprToExpression(expr: Exclude<Expr, { feature: Feature<'string'> }>, variable: string): tsc.Expression {
    switch (expr.type) {
        case 'not':
            return f.createLogicalNot(expr2ts(expr.expr, variable))
        case 'and':
            return f.createLogicalAnd(expr2ts(expr.left, variable), expr2ts(expr.right, variable))
        case 'or':
            return f.createLogicalOr(expr2ts(expr.left, variable), expr2ts(expr.right, variable))
        case 'xor':
            return f.createStrictInequality(expr2ts(expr.left, variable), expr2ts(expr.right, variable))
    }
}

function featureToExpression(parent: tsc.Expression, feat: Feature): tsc.Expression {
    if (feat.type === 'at' && feat.child !== undefined && isRelationalFeature(feat.child)) {
        return featureToExpression(f.createNonNullExpression(atExpression(parent, feat.args['-n'])), feat.child)
    }

    parent = featureLevelToExpression(parent, feat)
    return feat.child ? featureToExpression(parent, feat.child) : parent
}

function featureLevelToExpression(parent: tsc.Expression, feat: Feature): tsc.Expression {
    switch (feat.type) {
        case 'self':
            return parent
        case 'length':
            return f.createPropertyAccessExpression(parent, 'length')
        case 'charAt':
            return f.createElementAccessExpression(parent, f.createNumericLiteral(feat.args.n))
        case 'at':
            return atExpression(parent, feat.args['-n'])
        case 'charCodeAt':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'charCodeAt'), undefined, [
                f.createNumericLiteral(feat.args.n),
            ])
        case 'startsWith':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'startsWith'), undefined, [
                f.createStringLiteral(feat.args.s),
            ])
        case 'endsWith':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'endsWith'), undefined, [
                f.createStringLiteral(feat.args.s),
            ])
        case 'includes':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'includes'), undefined, [
                f.createStringLiteral(feat.args.value),
            ])
        case '<':
            return f.createLessThan(parent, featureToExpression(parent, feat.args))
        case '<=':
            return f.createLessThanEquals(parent, featureToExpression(parent, feat.args))
        case '<>':
            return f.createStrictInequality(parent, featureToExpression(parent, feat.args))
        case '=':
            return f.createStrictEquality(parent, featureToExpression(parent, feat.args))
        case '>':
            return f.createGreaterThan(parent, featureToExpression(parent, feat.args))
        case '>=':
            return f.createGreaterThanEquals(parent, featureToExpression(parent, feat.args))
        case 'and':
            return f.createLogicalAnd(parent, featureToExpression(parent, feat.args))
        case 'if':
            return f.createConditionalExpression(
                parent,
                undefined,
                featureToExpression(parent, feat.args.then),
                undefined,
                featureToExpression(parent, feat.args.else),
            )
        case 'not':
            return f.createLogicalNot(parent)
        case 'or':
            return f.createLogicalOr(parent, featureToExpression(parent, feat.args))
        case 'lit':
            return literalToExpression(feat.args)
    }
    //throw new Error(`unimplemented feature ${feat.type}: ${JSON.stringify(feat, null, 1)}`)
}

function atExpression(parent: tsc.Expression, negativeIndex: number): tsc.Expression {
    return f.createCallExpression(f.createPropertyAccessExpression(parent, 'at'), undefined, [
        f.createPrefixUnaryExpression(tsc.SyntaxKind.MinusToken, f.createNumericLiteral(negativeIndex)),
    ])
}

function isRelationalFeature(feat: Feature): boolean {
    return feat.type === '<' || feat.type === '<=' || feat.type === '>' || feat.type === '>='
}

export function literalToExpression(value: string | number | boolean | undefined): tsc.Expression {
    switch (typeof value) {
        case 'string':
            return f.createStringLiteral(value)
        case 'number':
            return f.createNumericLiteral(value)
        case 'boolean':
            return value ? f.createTrue() : f.createFalse()
        case 'undefined':
            return f.createVoidZero()
    }
}
