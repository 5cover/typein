# Repository Guidelines

## Project Structure & Module Organization

Source lives in `src/`. The CLI entry point is `src/index.ts`. Core search and synthesis logic is in `src/solve.ts`, IR definitions in `src/ir.ts`, AST construction in `src/compile.ts`, output printing in `src/emit.ts`, cost models in `src/cost.ts`, reporting in `src/report.ts`, and finite-domain verification in `src/eval.ts`. Builtin domains are defined in `src/domains.ts`. Minification infrastructure is split between `src/minify.ts` and minifier implementations such as `src/minify-js-typeof.ts`.

Compiled output goes to `dist/`. There is no separate assets directory and no committed test fixture directory at present.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies using the pinned pnpm version.
- `pnpm run build`: compile TypeScript into `dist/` using `tsconfig.build.json`.
- `pnpm test`: run `tsc --noEmit` for typechecking.
- `pnpm exec tsx src/index.ts for string number --test`: run the CLI directly from source and verify the emitted expression.
- `node dist/index.js minify <file> js.typeof --report /tmp/typein.yml`: run the built CLI on JavaScript source.

## Coding Style & Naming Conventions

Use strict TypeScript ESM and keep imports explicit with `.js` suffixes for local modules. Follow the existing style: 4-space indentation, no semicolons, single quotes, concise types, and small focused functions. Prefer structured domain primitives (`Mask`, `Expr`, `Feature`) over ad hoc strings. Keep canonical output and minified output as explicit emit options rather than hidden formatting behavior.

## Testing Guidelines

There is no traditional test runner yet. Use `pnpm test` as the required baseline. For behavioral checks, run CLI commands with `--test`; this verifies generated expressions against the finite input domain. For reporting changes, use `--report /tmp/name.yml` and inspect the YAML. For JavaScript minifier changes, also run `node --check` on transformed output.

## Commit & Pull Request Guidelines

Use short imperative messages, for example `Search smaller query complements` and `Move compact expression printing into emit`. Keep commits scoped to one conceptual change.

## Agent-Specific Instructions

Before editing, check `git status --short` and avoid reverting unrelated local changes. Use `rg` for searching. Prefer `apply_patch` for manual edits. When adding dependencies, update both `package.json` and `pnpm-lock.yaml` through pnpm.
