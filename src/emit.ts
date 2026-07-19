import tsc from 'typescript'
import { maskToNames } from './mask.js'
import type { Mask } from './types.js'
import * as compile from './compile.js'
import type { Expr } from './ir.js'

const f = tsc.factory

type RegistryNode = {
    guard?: {
        names: readonly string[]
        expr: Expr
    }
    children: Map<string, RegistryNode>
}

export type EmitOptions = {
    typeName: string
    parameterName: string
    defineType?: boolean
}

export type EmitModuleOptions = EmitOptions & { guardKey: string }

export function tsModule<S extends string>(S: readonly S[], best: Map<Mask, Expr>, opts: EmitModuleOptions): string {
    const sortedDomain = [...S].sort()
    const statements: tsc.Statement[] = []

    if (S.includes(opts.guardKey as S))
        throw new Error(`domain value "${opts.guardKey}" conflicts with the registry guard key`)

    if (opts.defineType) statements.push(createExportedTypeAlias(opts.typeName, sortedDomain))
    statements.push(f.createExportDefault(registryNodeExpression(opts, registryTree(S, best))))

    return printStatements(statements)
}

export function tsGuardModule<S extends string>(
    S: readonly S[],
    targetValues: readonly S[],
    expr: Expr,
    opts: EmitOptions,
): string {
    const sortedDomain = [...S].sort()
    const sortedTarget = [...targetValues].sort()
    const statements: tsc.Statement[] = opts.defineType ? [createExportedTypeAlias(opts.typeName, sortedDomain)] : []
    statements.push(
        f.createExportDefault(
            createTypeGuard({
                opts,
                narrowedValues: sortedTarget,
                body: compile.expr2ts(expr, opts.parameterName),
            }),
        ),
    )

    return printStatements(statements)
}

function registryTree<S extends string>(S: readonly S[], best: Map<Mask, Expr>): RegistryNode {
    const root: RegistryNode = { children: new Map() }
    const entries = [...best.entries()]
        .map(([mask, expr]) => ({
            expr,
            names: maskToNames(S, mask).sort(),
        }))
        .sort((a, b) => compareStringArrays(a.names, b.names))

    for (const entry of entries) {
        let node = root
        for (const name of entry.names) {
            const child = node.children.get(name) ?? { children: new Map() }
            node.children.set(name, child)
            node = child
        }
        node.guard = entry
    }

    return root
}

function registryNodeExpression(opts: EmitModuleOptions, node: RegistryNode): tsc.Expression {
    const properties: tsc.ObjectLiteralElementLike[] = []

    if (node.guard !== undefined) {
        properties.push(
            f.createPropertyAssignment(
                f.createStringLiteral(opts.guardKey),
                createTypeGuard({
                    opts,
                    narrowedValues: node.guard.names,
                    body: compile.expr2ts(node.guard.expr, opts.parameterName),
                }),
            ),
        )
    }

    for (const [key, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
        properties.push(f.createPropertyAssignment(f.createStringLiteral(key), registryNodeExpression(opts, child)))
    }

    return f.createObjectLiteralExpression(properties, true)
}

function createExportedTypeAlias(name: string, values: readonly string[]): tsc.TypeAliasDeclaration {
    return f.createTypeAliasDeclaration(
        [f.createModifier(tsc.SyntaxKind.ExportKeyword)],
        name,
        undefined,
        unionOfStringLiterals(values),
    )
}

function createTypeGuard(args: {
    opts: EmitOptions
    narrowedValues: readonly string[]
    body: tsc.Expression
}): tsc.ArrowFunction {
    const parameter = f.createParameterDeclaration(
        undefined,
        undefined,
        args.opts.parameterName,
        undefined,
        f.createTypeReferenceNode(args.opts.typeName),
    )

    const returnType = f.createTypePredicateNode(
        undefined,
        args.opts.parameterName,
        unionOfStringLiterals(args.narrowedValues),
    )

    return f.createArrowFunction(
        undefined,
        undefined,
        [parameter],
        returnType,
        f.createToken(tsc.SyntaxKind.EqualsGreaterThanToken),
        args.body,
    )
}

function unionOfStringLiterals(values: readonly string[]): tsc.TypeNode {
    const nodes = values.map(value => f.createLiteralTypeNode(f.createStringLiteral(value)))

    if (nodes.length === 1) return nodes[0]!

    return f.createUnionTypeNode(nodes)
}

export const printer = tsc.createPrinter({
    newLine: tsc.NewLineKind.LineFeed,
    omitTrailingSemicolon: true,
})

export const sourceFile = tsc.createSourceFile('generated.ts', '', tsc.ScriptTarget.Latest, false, tsc.ScriptKind.TS)
function printStatements(statements: readonly tsc.Statement[]): string {
    const file = f.updateSourceFile(sourceFile, [...statements])
    return printer.printFile(file).replaceAll(/^ +/gm, '') // remove indent
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const c = left[i]!.localeCompare(right[i]!)
        if (c) return c
    }

    return left.length - right.length
}
