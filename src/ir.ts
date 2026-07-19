export type InTypeTag = 'string' | 'number' | 'boolean' | 'char' | 'undefined'

export type Feature<T extends InTypeTag = InTypeTag> =
    | { type: 'self'; child?: Feature<T> }
    | { type: 'not'; child?: FeatureBoolean }
    | (T extends 'string' ? FeatureString : never)
    | (T extends 'number' ? FeatureNumber : never)
    | (T extends 'boolean' ? FeatureBoolean : never)
    | (T extends 'char' ? FeatureChar : never)
    | (T extends 'undefined' ? FeatureUndefined : never)
    | BinaryPredicates<T>

type FeatureUndefined = FeatureLiteral<undefined>

type FeatureString =
    | FeatureLiteral<string>
    | BinaryPredicates<'string'>
    | F<'oneOf', 'boolean', { values: readonly string[] }>
    | F<'length', 'number'>
    | F<'splitLength', 'number', { sep: string }>
    | F<'at', 'char' | 'undefined', { '-n': number }>
    | F<'charAt', 'char' | 'undefined', { n: number }>
    | F<'charCodeAt', 'number', { n: number }>
    | F<'startsWith', 'boolean', { s: string }>
    | F<'startsWithAt', 'boolean', { s: string; n: number }>
    | F<'endsWith', 'boolean', { s: string }>
    | F<'includes', 'boolean', { value: string }>
    | F<'indexOf', 'number', { value: string }>
    | F<'lastIndexOf', 'number', { value: string }>
    | F<'regexTest', 'boolean', { source: string }>

type FeatureChar = FeatureLiteral<string>

type FeatureNumber = FeatureLiteral<number>

type FeatureBoolean = FeatureLiteral<boolean> | FeatueConditional

type FeatueConditional<TrueTag extends InTypeTag = InTypeTag, FalseTag extends InTypeTag = InTypeTag> = {
    type: 'if'
    args: { then: Feature<TrueTag>; else: Feature<FalseTag> }
    child?: Feature<TrueTag | FalseTag>
}

type BinaryPredicates<T extends InTypeTag> = {
    type: '<' | '>' | '<=' | '>=' | '=' | '<>' | 'and' | 'or'
    args: Feature<T>
    child?: FeatureBoolean
}

type FeatureLiteral<T> = { type: 'lit'; args: T; child?: undefined }

type F<T extends string, C extends InTypeTag, A extends object | void = void> = {
    type: T
    child?: Feature<C>
} & (A extends void ? { args?: undefined } : { args: A })

export type PrimitiveExpr = {
    feature: Feature<'string'>
}

export type Expr =
    | PrimitiveExpr
    | { type: 'not'; expr: Expr }
    | { type: 'and' | 'or' | 'xor'; left: Expr; right: Expr }

export function notExpr(expr: Expr): Expr {
    return { type: 'not', expr }
}

export function invertLastPredicateInPlace(expr: Expr): Expr {
    if (!('feature' in expr)) return { type: 'not', expr }

    let feature: Feature = expr.feature
    for (; feature.child !== undefined; feature = feature.child);
    switch (feature.type) {
        case '<':
            feature.type = '>='
            break
        case '<=':
            feature.type = '>'
            break
        case '<>':
            feature.type = '='
            break
        case '=':
            feature.type = '<>'
            break
        case '>':
            feature.type = '<='
            break
        case '>=':
            feature.type = '<'
            break
        default: {
            feature.child = { type: 'not' }
        }
    }
    return expr
}
