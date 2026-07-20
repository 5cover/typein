import tsc from 'typescript'
import type { Expr, Feature } from './ir.js'
const f = tsc.factory

export type ExprEmitOptions = {
    variable?: string
    root?: tsc.Expression
    language?: 'ts' | 'js'
    equality?: 'strict' | 'loose'
    createNonNullExpressions?: boolean
}

export function expr2ts(expr: Expr, variableOrOptions: string | ExprEmitOptions = 'x'): tsc.Expression {
    const opts = typeof variableOrOptions === 'string' ? { variable: variableOrOptions } : variableOrOptions
    const context: Required<Omit<ExprEmitOptions, 'root'>> & { root: tsc.Expression } = {
        variable: opts.variable ?? 'x',
        root: opts.root ?? f.createIdentifier(opts.variable ?? 'x'),
        language: opts.language ?? 'ts',
        equality: opts.equality ?? 'strict',
        createNonNullExpressions: opts.createNonNullExpressions ?? opts.language === 'ts',
    }

    if ('type' in expr) return exprToExpression(expr, context)
    return featureToExpression(context.root, expr.feature, context)
}

function exprToExpression(
    expr: Exclude<Expr, { feature: Feature<'string'> }>,
    context: Required<Omit<ExprEmitOptions, 'root'>> & { root: tsc.Expression },
): tsc.Expression {
    switch (expr.type) {
        case 'not':
            return f.createLogicalNot(expr2ts(expr.expr, context))
        case 'and':
            return f.createLogicalAnd(expr2ts(expr.left, context), expr2ts(expr.right, context))
        case 'or':
            return f.createLogicalOr(expr2ts(expr.left, context), expr2ts(expr.right, context))
        case 'xor':
            return f.createStrictInequality(expr2ts(expr.left, context), expr2ts(expr.right, context))
    }
}

function featureToExpression(
    parent: tsc.Expression,
    feat: Feature,
    context: Required<Omit<ExprEmitOptions, 'root'>> & { root: tsc.Expression },
): tsc.Expression {
    if (feat.type === 'at' && feat.child !== undefined && isRelationalFeature(feat.child)) {
        const at = atExpression(parent, feat.args['-n'])
        return featureToExpression(context.createNonNullExpressions ? f.createNonNullExpression(at) : at, feat.child, context)
    }

    parent = featureLevelToExpression(parent, feat, context)
    return feat.child ? featureToExpression(parent, feat.child, context) : parent
}

function featureLevelToExpression(
    parent: tsc.Expression,
    feat: Feature,
    context: Required<Omit<ExprEmitOptions, 'root'>> & { root: tsc.Expression },
): tsc.Expression {
    switch (feat.type) {
        case 'self':
            return parent
        case 'oneOf':
            return f.createCallExpression(
                f.createPropertyAccessExpression(
                    f.createArrayLiteralExpression(feat.args.values.map(value => f.createStringLiteral(value))),
                    'includes',
                ),
                undefined,
                [
                    context.language === 'ts'
                        ? f.createAsExpression(parent, f.createKeywordTypeNode(tsc.SyntaxKind.StringKeyword))
                        : parent,
                ],
            )
        case 'length':
            return f.createPropertyAccessExpression(parent, 'length')
        case 'splitLength':
            return f.createPropertyAccessExpression(
                f.createCallExpression(f.createPropertyAccessExpression(parent, 'split'), undefined, [
                    f.createStringLiteral(feat.args.sep),
                ]),
                'length',
            )
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
        case 'startsWithAt':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'startsWith'), undefined, [
                f.createStringLiteral(feat.args.s),
                f.createNumericLiteral(feat.args.n),
            ])
        case 'endsWith':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'endsWith'), undefined, [
                f.createStringLiteral(feat.args.s),
            ])
        case 'includes':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'includes'), undefined, [
                f.createStringLiteral(feat.args.value),
            ])
        case 'indexOf':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'indexOf'), undefined, [
                f.createStringLiteral(feat.args.value),
            ])
        case 'lastIndexOf':
            return f.createCallExpression(f.createPropertyAccessExpression(parent, 'lastIndexOf'), undefined, [
                f.createStringLiteral(feat.args.value),
            ])
        case 'regexTest':
            return f.createCallExpression(
                f.createPropertyAccessExpression(f.createRegularExpressionLiteral(`/${feat.args.source.replaceAll('/', '\\/')}/`), 'test'),
                undefined,
                [parent],
            )
        case '<':
            return f.createLessThan(parent, featureToExpression(parent, feat.args, context))
        case '<=':
            return f.createLessThanEquals(parent, featureToExpression(parent, feat.args, context))
        case '<>':
            return context.equality === 'loose'
                ? f.createInequality(parent, featureToExpression(parent, feat.args, context))
                : f.createStrictInequality(parent, featureToExpression(parent, feat.args, context))
        case '=':
            return context.equality === 'loose'
                ? f.createEquality(parent, featureToExpression(parent, feat.args, context))
                : f.createStrictEquality(parent, featureToExpression(parent, feat.args, context))
        case '>':
            return f.createGreaterThan(parent, featureToExpression(parent, feat.args, context))
        case '>=':
            return f.createGreaterThanEquals(parent, featureToExpression(parent, feat.args, context))
        case 'and':
            return f.createLogicalAnd(parent, featureToExpression(parent, feat.args, context))
        case 'if':
            return f.createConditionalExpression(
                parent,
                undefined,
                featureToExpression(parent, feat.args.then, context),
                undefined,
                featureToExpression(parent, feat.args.else, context),
            )
        case 'not':
            return f.createLogicalNot(parent)
        case 'or':
            return f.createLogicalOr(parent, featureToExpression(parent, feat.args, context))
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
            return value < 0
                ? f.createPrefixUnaryExpression(tsc.SyntaxKind.MinusToken, f.createNumericLiteral(Math.abs(value)))
                : f.createNumericLiteral(value)
        case 'boolean':
            return value ? f.createTrue() : f.createFalse()
        case 'undefined':
            return f.createVoidZero()
    }
}
