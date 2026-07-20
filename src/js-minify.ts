import tsc from 'typescript'
import { minify_sync } from 'terser'

export function compactJsExpression(expression: string): string {
    const result = minify_sync(`${expression};`, {
        compress: false,
        mangle: false,
        format: {
            comments: false,
        },
    })

    if (result.code === undefined) {
        throw new Error('Terser did not return generated code')
    }

    return expressionStatementText(result.code)
}

function expressionStatementText(source: string): string {
    const sourceFile = tsc.createSourceFile('typein-expression.js', source, tsc.ScriptTarget.Latest, true, tsc.ScriptKind.JS)
    const statement = sourceFile.statements[0]
    if (!statement || !tsc.isExpressionStatement(statement)) throw new Error('failed to read compacted expression')

    return statement.expression.getText(sourceFile)
}
