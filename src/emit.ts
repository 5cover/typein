import tsc from 'typescript'
import { maskToNames } from './mask.js'
import type { Mask } from './types.js'
import * as compile from './compile.js'
import type { Expr } from './ir.js';

const f = tsc.factory

export function tsModule<S extends string>(
    S: readonly S[],
    best: Map<Mask, Expr>,
    typeName: string,
    parameterName = 's',
): string {
    const statements: tsc.Statement[] = []

    statements.push(createExportedTypeAlias(typeName, S))

    const entries = [...best.entries()]
        .map(([mask, best]) => ({
            mask,
            best,
            names: maskToNames(S, mask).sort(),
        }))
        .sort((a, b) => {
            const sa = subsetFunctionName(a.names)
            const sb = subsetFunctionName(b.names)
            return (
                sa.length - sb.length ||
                (sa < sb ? -1
                : sa > sb ? 1
                : 0)
            )
        })

    for (const { best, names } of entries) {
        const fnName = subsetFunctionName(names)

        statements.push(
            createExportedTypeGuard({
                fnName,
                parameterName,
                parameterTypeName: typeName,
                narrowedValues: names,
                body: compile.expr2ts(best, parameterName),
            }),
        )
    }

    return printStatements(statements)
}

function createExportedTypeAlias(name: string, values: readonly string[]): tsc.TypeAliasDeclaration {
    return f.createTypeAliasDeclaration(
        [f.createModifier(tsc.SyntaxKind.ExportKeyword)],
        name,
        undefined,
        unionOfStringLiterals(values),
    )
}

function createExportedTypeGuard(args: {
    fnName: string
    parameterName: string
    parameterTypeName: string
    narrowedValues: readonly string[]
    body: tsc.Expression
}): tsc.VariableStatement {
    const parameter = f.createParameterDeclaration(
        undefined,
        undefined,
        args.parameterName,
        undefined,
        f.createTypeReferenceNode(args.parameterTypeName),
    )

    const returnType = f.createTypePredicateNode(
        undefined,
        args.parameterName,
        unionOfStringLiterals(args.narrowedValues),
    )

    const arrow = f.createArrowFunction(
        undefined,
        undefined,
        [parameter],
        returnType,
        f.createToken(tsc.SyntaxKind.EqualsGreaterThanToken),
        args.body,
    )

    return f.createVariableStatement(
        [f.createModifier(tsc.SyntaxKind.ExportKeyword)],
        f.createVariableDeclarationList(
            [f.createVariableDeclaration(args.fnName, undefined, undefined, arrow)],
            tsc.NodeFlags.Const,
        ),
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

function subsetFunctionName(values: readonly string[]): string {
    return 'is_' + values.map(identifierPart).join('_')
}

function identifierPart(value: string): string {
    const cleaned = value
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}_$]+/gu, '_')
        .replace(/^(\p{N})/u, '_$1')
        .replace(/^$/, '_')

    return cleaned
}
