# typein

Compare `typeof` against multiple types in a single expression.

Useful for code minimization and hotpath optimization.

More generally, this tool accepts, conceptually:

- S (Domain): a set of strings
- L: a target language/expression IR system to derive characteristics from these strings (conceptually a set of valid programs)
- c: a cost function to score an IR expression. Semantics are user-provided : maximizing performance, minimizing cyclomatic complexity...

And outputs

- a map from non-empty subsets to an *L* program that checks a string *s* in *S* is in that subset:
  S' &sub; S &rarr; l &in; L and² l(s) = s &in; S' and c(l) is minimal

## Abstract

It is a common pattern in JavaScript/TypeScript to narrow a value to a particular type by comparing typestrings: `typeof x === 'string'`. TypeScript supports this and narrows *x* to string.

However: checking if a value is in one of multiple types is a pain. `typeof x === 'string' || typeof x === 'number'`.

Maybe analysis could reveal that by some substrings can only be found at a position by the values for certain sets of types.

Example : `(typeof x)[0] === 's'` is equivalent to `typeof x === 'string || typeof x === 'symbol'` because both `'string'` and `'symbol'` start with `'s'` and no other possible value of typeof does.

It doesn't have to be equality. Any comparison operator (OP) can be used.

The goal is this: create a TypeScript module exporting functions like this for every typestrings subset (ordered lexicographically) that have a unique characteristic in common and are therefore able to be compared for together.

```typescript
export const string_symbol = (t: Typestring) => t[0] === 's';
```

## Typestrings

JS typeof operator produces a hardcoded string value representing the type. One of:

1. bigint
2. boolean
3. function
4. number
5. object
6. string
7. symbol
8. undefined

These string values will be refered to as "typestrings" from now on.

## CLI

```sh
typein for <TARGET_VALUE...> [common options]
typein all [common options] [--guard-key <name>]
typein minify <input> <MINIFIER...> [common options] [--in-place]
```

When no domain source is provided, `typein` uses the JavaScript `typeof` strings. Generated TypeScript is written to stdout.

`typein for` is the default operating style: provide the desired subset as command arguments and it emits one default-exported type guard for that partition.

```sh
typein for string number
typein for color display -b css-properties
typein for urgent -d debug -d info -d urgent
```

```ts
export type Domain = "bigint" | "boolean" | "function" | "number" | "object" | "string" | "symbol" | "undefined"
export default (s: Domain): s is "number" | "string" => s[0] > "m" && s[0] < "t"
```

`typein all` opts into exhaustive enumeration. The generated module default-exports a nested registry object. Each path is an alphabetically sorted subset of domain strings, and each node's `is` property is the type guard for that subset.

```ts
import is from './generated.js'

is.number.string.is(value)
```

Conceptually, consumers can treat the default export like this:

```ts
type GuardKey = 'is'
type Guard<T extends Domain = Domain> = (s: Domain) => s is T
type Registry = { [S in Domain]?: Registry, [K in GuardKey]?: Guard }
```

Useful options:

- `--report [file]`: write structured YAML reporting to stderr, or to `file` when provided.
- `--profile`: include timing and composition-search counters in reporting. Without `--report`, profile YAML is written to stderr.
- `--test`: verify every generated expression against its promised mask for the input domain.
- `-b, --builtin name`: add strings from a builtin domain. Can be repeated and can be combined with `--domain`.
- `-d, --domain value`: add one string to the input domain. Can be repeated and can be combined with builtins.
- `--list-builtins`: list builtin domain names.
- `--language ts`: select TypeScript output. This is the only output language for now.
- `--cost source`: select the source-size comparator. This is the only cost comparator for now.
- `--type-name Name`: change the generated union type name.
- `--parameter-name name`: change the generated predicate parameter name.
- `--guard-key name`: change the registry leaf key for `typein all`. Defaults to `is`.

`typein all` uses numeric bit operations for exhaustive enumeration, so domains must contain at most 30 strings. `typein for` uses a large-domain-safe query solver and does not have that numeric mask limit.

`typein minify` runs source minifiers as an ordered pipeline. Without `--in-place`, transformed source is written to stdout; with `--in-place`, the input file is rewritten. The first minifier is `js.typeof`, which parses JavaScript with TypeScript's JavaScript parser, replaces only eligible `typeof` expressions by source spans, and leaves unrelated source bytes unchanged.

```sh
typein minify dist/jquery-4.0.0.module.js js.typeof --report /tmp/jquery-typein.yml > /tmp/jquery-typein.js
```

`js.typeof` only reasons about direct `typeof` comparisons against JavaScript typestrings. It may merge logical `&&`/`||` groups for pure-enough operands, but impure operands such as calls are simplified only one comparison at a time so their evaluation count is preserved.

Builtin domains are intended both as examples and stress inputs. Use `typein for` for larger domains; `typein all` is intentionally exhaustive and can still be expensive. The full `css-properties` builtin contains the known CSS properties list; sliced variants such as `css-properties-50`, `css-properties-100`, `css-properties-250`, `css-properties-500`, and `css-properties-1000` are available for profiling.

CSS-like hyphenated domains get extra native query primitives. Typein derives delimiter presence, token count, first/last/middle/any-token masks, offset `startsWith`, and `indexOf`/`lastIndexOf` relation masks from the requested target values. For arbitrary or scattered subsets, query mode may use a native finite-set check:

```ts
["a", "b"].includes(s as string)
```

Regex-backed token patterns are disabled by default. They can be enabled with `--query-regex`, but regex is treated as a separate embedded language with a much higher analysis ceiling than native string predicates.

The CSS query benchmark ladder can be run with:

```sh
typein bench-css-query --report --test
typein bench-css-query --report /tmp/css-query.yml --profile --test
```

The benchmark starts at the configured query limits. If a rung still emits the equality-OR fallback, it retries with doubled limits until the expression improves or one run takes more than ten seconds.

For large query domains, `--profile` distinguishes exact correctness from search proof scope. `proof: query-normal-forms` means the target normal-form searches were exhausted. `proof: bounded-query-normal-forms` means the emitted guard was verified over the full domain, but the normal-form optimality search used a bounded frontier.

`typein for` exposes query search limits when you want to spend more time trying to beat the exact-value fallback:

- `--query-or-states count`
- `--query-and-states count`
- `--query-superset-pre-frontier count`
- `--query-superset-frontier count`
- `--query-dnf-frontier count`
- `--query-regex`: allow regex-backed query candidates. Disabled by default.

Reports are structured YAML DTOs rather than preformatted tables. Collections are emitted as `{ count, values }`, so reports stay glanceable while still exposing the underlying values. Query reports include family counters such as `candidates`, `masks`, `newMasks`, `improvements`, and `winners`; `js.typeof` reports include source spans for `typeof` usages, comparison atoms, purity decisions, replacement candidates, selected replacements, and expressions cached by partition.

For v0,
*S* = typestrings
*L* = all JavaScript expressions that reference *s* once and do compare against *S* elements directly for non-singleton *S'*. Otherwise, it gets trivial to solve (union/intersection)
*c*(*s*) = 0 (for later)

Number of subsets : $2^8=256$. Remove the whole set (since it is just typeof) and &empty; (while still useful as a "never" producing expression, there are many ways to obtain it, the simplest being just `false`): that leaves us with 254 subsets.

That's 127 distinct complement-pairs, meaning 127 subsets is enough to check for every subset (since negating a check always produces its complement, though there may be better implementations for it according to *c*).

## Characteristics

types:

- t: typestring
- c: character, a string known to be of length 1
- s: string
- n: number (all characteristics produce integers, but allowing reals might uncover relational properties)
- b: boolean
- sr: string replacement. can be a replacer function or a string with non-regex replacement patterns. See [String.prototype.replace() | MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#description)

ordered by simplicity ascending (implement earlier ones first, move down if needed)

- `t OP s`
- `t.length OP n`
- `t[n] OP c`
- `t.at(-n) OP c`: terse length-n lookup
- `t.charCodeAt(n)` numeric transforms: reserved for operations such as modulo, bit masks, and arithmetic relationships. Plain equality and ordering duplicate `t[n]` and are intentionally not generated.
- `t.endsWith(s) OP b`
- `t.startsWith(s) OP b`
- `t.includes(s) OP b`
- `t.indexOf(s) OP n`
- `t.lastIndexOf(s) OP n`
- `t.slice(n,n) OP s`
- `t.replace(s,sr) OP s`
- `t.replaceAll(s,sr) OP s`

where OP is, depending on the types

- common: = &ne; &lt; &gt; &le; &ge; &and; &or; &not; ?:
- t,c,s: +
- n,b: + - * / % & | ^ ** << >> >>>

`match()`/`matchAll()` are omitted for now, arbitrary regexes would probably enable all subsets since but incur overhead and complexity though we will consider it if we lack edges.

It gets very complex very quickly. We could also interrogate number methods, toString-kind method result strings, conditional operator composition... the possibilities are endless.

This is why we apply the step 0 method.

## Relational operators truth table

Not commonly used with booleans, but could be useful. Arithmetic operators can be used too. false is 0, true is 1 under JS coercion semantics.

a|b|&lt;|&gt;|=|&le;|&ge;|&ne;|
-|-|----|----|-|----|----|----|
0|0|   0|   0|1|1   |1   |   0|
0|1|   1|   0|0|1   |0   |   1|
1|0|   0|   1|0|0   |1   |   1|
1|1|   0|   0|1|1   |1   |   0|
