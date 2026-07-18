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

export function tsModule<S extends string>(
    S: readonly S[],
    best: Map<Mask, Expr>,
    typeName: string,
    parameterName = 's',
): string {
    const sortedDomain = [...S].sort()
    const statements: tsc.Statement[] = []

    if (S.includes('is' as S)) throw new Error('domain value "is" conflicts with the registry guard key')

    statements.push(createExportedTypeAlias(typeName, sortedDomain))
    statements.push(createRegistryTypeAlias(typeName))
    statements.push(createRegistryDeclaration(S, best, typeName, parameterName))
    statements.push(f.createExportDefault(f.createIdentifier('registry')))

    return printStatements(statements)
}

function createRegistryDeclaration<S extends string>(
    S: readonly S[],
    best: Map<Mask, Expr>,
    typeName: string,
    parameterName: string,
): tsc.VariableStatement {
    const root = registryTree(S, best)

    return f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
            [
                f.createVariableDeclaration(
                    'registry',
                    undefined,
                    undefined,
                    f.createSatisfiesExpression(
                        registryNodeExpression(root, typeName, parameterName),
                        f.createTypeReferenceNode('Registry'),
                    ),
                ),
            ],
            tsc.NodeFlags.Const,
        ),
    )
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

function registryNodeExpression(node: RegistryNode, typeName: string, parameterName: string): tsc.Expression {
    const properties: tsc.ObjectLiteralElementLike[] = []

    if (node.guard !== undefined) {
        properties.push(
            f.createPropertyAssignment(
                'is',
                createTypeGuard({
                    typeName,
                    parameterName,
                    narrowedValues: node.guard.names,
                    body: compile.expr2ts(node.guard.expr, parameterName),
                }),
            ),
        )
    }

    for (const [key, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
        properties.push(f.createPropertyAssignment(f.createStringLiteral(key), registryNodeExpression(child, typeName, parameterName)))
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

function createRegistryTypeAlias(typeName: string): tsc.TypeAliasDeclaration {
    const parameter = f.createParameterDeclaration(
        undefined,
        undefined,
        's',
        undefined,
        f.createTypeReferenceNode(typeName),
    )

    const guard = f.createFunctionTypeNode(
        undefined,
        [parameter],
        f.createTypePredicateNode(undefined, 's', f.createTypeReferenceNode(typeName)),
    )

    const recursive = f.createTypeLiteralNode([
        f.createPropertySignature(
            [f.createModifier(tsc.SyntaxKind.ReadonlyKeyword)],
            'is',
            f.createToken(tsc.SyntaxKind.QuestionToken),
            guard,
        ),
        f.createIndexSignature(
            [f.createModifier(tsc.SyntaxKind.ReadonlyKeyword)],
            [f.createParameterDeclaration(undefined, undefined, 'value', undefined, f.createKeywordTypeNode(tsc.SyntaxKind.StringKeyword))],
            f.createUnionTypeNode([f.createTypeReferenceNode('Registry'), guard, f.createKeywordTypeNode(tsc.SyntaxKind.UndefinedKeyword)]),
        ),
    ])

    return f.createTypeAliasDeclaration([f.createModifier(tsc.SyntaxKind.ExportKeyword)], 'Registry', undefined, recursive)
}

function createTypeGuard(args: {
    typeName: string
    parameterName: string
    narrowedValues: readonly string[]
    body: tsc.Expression
}): tsc.ArrowFunction {
    const parameter = f.createParameterDeclaration(
        undefined,
        undefined,
        args.parameterName,
        undefined,
        f.createTypeReferenceNode(args.typeName),
    )

    const returnType = f.createTypePredicateNode(
        undefined,
        args.parameterName,
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
})

export const sourceFile = tsc.createSourceFile('generated.ts', '', tsc.ScriptTarget.Latest, false, tsc.ScriptKind.TS)
function printStatements(statements: readonly tsc.Statement[]): string {
    const file = f.updateSourceFile(sourceFile, [...statements])
    return printer.printFile(file)
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const c = left[i]!.localeCompare(right[i]!)
        if (c) return c
    }

    return left.length - right.length
}
