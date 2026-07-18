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
typein [DOMAIN...]
```

When `DOMAIN` is omitted, `typein` uses the JavaScript `typeof` strings. Generated TypeScript is written to stdout.
The generated module default-exports a nested registry object. Each path is an alphabetically sorted subset of domain strings, and each node's `is` property is the type guard for that subset.

```ts
import is from './generated.js'

is.number.string.is(value)
```

Useful options:

- `--report`: write coverage and interest-score reporting to stderr.
- `--test`: verify every generated expression against its promised mask for the input domain.
- `-b, --builtin name`: add strings from a builtin domain. Can be repeated and can be combined with positional domain strings.
- `--list-builtins`: list builtin domain names.
- `--language ts`: select TypeScript output. This is the only output language for now.
- `--cost source`: select the source-size comparator. This is the only cost comparator for now.
- `--type-name Name`: change the generated union type name.
- `--parameter-name name`: change the generated predicate parameter name.

The current mask implementation uses numeric bit operations, so CLI domains must contain unique values and at most 30 strings.

Builtin domains are intended both as examples and stress inputs. Some larger or stranger builtins can be slow with the current exhaustive composition closure.

`--report` includes two coverage tables. In the family table:

- `candidates`: candidate expressions considered for that family, including candidates for empty/full masks.
- `masks`: distinct non-empty, non-full masks produced by that family.
- `new`: masks first discovered by that family in search order.
- `improvements`: times a candidate from that family replaced the current best expression for a mask.
- `winners`: final output masks whose direct winning expression came from that family.

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
