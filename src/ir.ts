export type Feature = | { t: 'self' } | FeatureString | FeatureNumber | FeatureBoolean

export type FeatureChar = CommonOperations<string>;

export type FeatureString = CommonOperations<string>
    | F<'length', FeatureNumber>
    | F<'at', FeatureChar, { '-n': number }>
    | F<'charAt', FeatureChar, { n: number }>
    | F<'charCodeAt', FeatureNumber, { n: number }>
    | F<'startsWith', FeatureBoolean, { s: string }>
    | F<'endsWith', FeatureBoolean, { s: string }>
    | F<'includes', FeatureBoolean, { value: string }>
    

export type FeatureNumber =
    | CommonOperations<number>

export type FeatureBoolean = never | CommonOperations<boolean>

type BooleanOperations = F<'?:', FeatureBoolean, { then: Value, else: Value},> | F<'and'|'or', FeatureBoolean>

type CommonOperations<T> = F< '='|'<>'|'<'|'>'|'<='|'>=', FeatureBoolean, { right: T }>

type Value = string | number | boolean;

type F<T extends string, C extends Feature, A extends object = never> = {
    type: T
    child: Feature
    args: A
}

export type Expr = {
    feature: FeatureString
}

export function negate(expr: Expr): Expr {
    switch (expr.feature.t) {
        case ''
    }
}
