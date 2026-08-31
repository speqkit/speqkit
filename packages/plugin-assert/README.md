# @speqkit/plugin-assert

The vocabulary a test says what it means in.

```yaml
# speq.yaml
plugins:
  - assert

assert:
  schemasDir: schemas     # where `schema` looks, relative to the project root
```

Every assertion here asks the same two questions — **what** are we looking at,
and **what must be true of it**. The first is one selector shared by all of
them; the second is the assertion's type. Learning the plugin is learning one
selector and a list of words.

```yaml
steps:
  - type: http
    method: GET
    url: /restaurants/${slug}/menu
    assert:
      - type: status              # @speqkit/plugin-http
        expected: 200
      - type: length
        path: body.categories
        at_least: 1
      - type: one_of
        path: body.categories[0].status
        expected: [active, stop_list]
      - type: not_contains
        path: text
        expected: password
      - type: schema
        path: body
        ref: menu/menu.schema.json
```

## The selector

| | |
| --- | --- |
| `path:` | a dotted path into the step's result, with `[n]` indexing |
| `value:` | an explicit value, usually a template |
| neither | the whole result |

`path` reads into the **step's whole result**, not into a body it assumes is
there. An HTTP step returns `{ status, body, text, headers, durationMs, … }`,
so a check on the payload is written `path: body.items[0].sku`. That extra word
is what the plugin is for: the same `at_least` reads a SQL row, a file's
contents and a browser's page state, because nothing here believes it is
looking at a response.

`value:` is for the checks that are not about the last step — comparing two
earlier ones, or a step result against a given:

```yaml
assert:
  - type: equals
    value: "${created.body.restaurant.slug}"
    expected: "${slug}"
```

A `path` that leads nowhere is reported as that, not as a comparison against
nothing: *`body.discount` is not there*, rather than *expected at least 10, got
undefined*, which reads like a wrong number when the field is simply missing.
The four presence checks are the exception — a missing path is the question
they are asking.

## The words

**Equality** — structural, so two objects that say the same thing are equal
however their keys happen to be ordered.

| | |
| --- | --- |
| `equals` | `expected` |
| `not_equals` | `expected` |

**Order.** Numbers compare as numbers, everything else the way the language
does — which is what makes an ISO date compare the way it reads, without a
second vocabulary for dates. Two values of different types never compare true.

| | |
| --- | --- |
| `greater_than` | `expected` |
| `at_least` | `expected` — greater than or equal |
| `less_than` | `expected` |
| `at_most` | `expected` — less than or equal |

**Membership**, from both sides. Python spells both of these `in` because at
the call site the direction is obvious; written down in YAML it is not, so it
is two words here.

| | |
| --- | --- |
| `contains` | the subject holds `expected`: a substring of a string, an element of an array (compared structurally), a key of an object |
| `not_contains` | |
| `one_of` | the subject is one of `expected`, which is a list |
| `not_one_of` | |

**Text**

| | |
| --- | --- |
| `matches` | `expected` is a regular expression; `flags` optional. Refused before the run if it does not compile |
| `starts_with` | `expected` |
| `ends_with` | `expected` |

**Presence**

| | |
| --- | --- |
| `exists` | there, and not `null` |
| `missing` | absent, or `null` |
| `empty` | `""`, `[]`, `{}`, `null`, or absent |
| `not_empty` | |

**Size and shape**

| | |
| --- | --- |
| `length` | `expected`, or `at_least` / `at_most`. Counts a string, an array or an object's keys |
| `is_type` | `expected` is one of `string`, `number`, `integer`, `boolean`, `array`, `object`, `null` |
| `schema` | `ref` — a JSON Schema file under `schemasDir` |

`length` is the one check carrying its own comparison, and that is deliberate.
A length is *derived from* the subject rather than being the subject, so
`at_least` cannot reach it — `at_least: 3` against a list of items would be
comparing an array to a number. Bounds live inside `length` instead of adding a
second selector nobody would find.

## Messages a reader can act on

A failure names the subject, what was required, and what was there:

```
expected body.price_cents to be at least 900, got 450
body.categories does not match menu/menu.schema.json: /0/status must be equal to one of the allowed values
body.discount is not there
```

A pass says what held — `body.restaurant.slug is "speq-slug"` — because a
report of thirty green assertions that all say "ok" is a report nobody reads.

## schema, by a real implementation

`schema` validates through [ajv](https://ajv.js.org), against draft-07 as
written. That is a dependency, and it is the right one: a hand-written subset
is the tempting version and the dangerous one. Schemas generated from OpenAPI
arrive with `oneOf`, `$ref` and `patternProperties`, and a validator that
quietly ignores the keywords it does not understand reports a pass it never
performed. **A gate that lies is worse than no gate.** JSON Schema is a
standard with a canonical implementation; reimplementing it is exactly the
depth that is not ours.

Schemas are compiled during `speq validate`, not at the first assertion that
uses one — so a missing file, or a schema with a typo in it, is found in
milliseconds rather than twenty minutes into a suite:

```
suites/menu/lists-items.yaml
  assert[2].ref  no such schema: /repo/schemas/menu/itmes.schema.json
```

Once compiled, a schema is kept: the same file is asserted on by fifty tests
and is parsed once.

## What is deliberately not here

No `and` / `or` / `not` combinators. A test that needs boolean algebra over its
checks is usually one test doing the work of three, and the block already reads
as "all of these hold" — every assertion in it runs, and each reports for
itself, which is the thing a combinator would take away.

No custom comparators. That is where somebody else's plugin starts, and
`defineAssertion` is a public contribution point: a check this list does not
have is twenty lines in a plugin of your own, not a pull request against ours.

## Migrating

| v1 | here |
| --- | --- |
| `type: json`, `path: "$.error"` | `type: equals`, `path: body.error` |
| `type: contains`, `expected: "x"` | `type: contains`, `path: text`, `expected: "x"` |
| `type: notcontains` | `type: not_contains` |
| `type: regex` | `type: matches` |
| `type: exists`, `path: "$.id"` | `type: exists`, `path: body.id` |
| `type: schema`, `ref: "a.schema.json"` | unchanged, plus `path: body` |

| from `plugin-http` | here |
| --- | --- |
| `type: jsonpath`, `path: items[0].sku` | `type: equals`, `path: body.items[0].sku` |
| `type: body_contains` | `type: contains`, `path: text` |

Both `plugin-http` names still work — they are registered here, do the response
assuming the general selector will not, and say what to write instead in their
own message. `speq migrate` does the rest mechanically. A path still written
`$.name` is refused by `speq validate` with the fix in the hint, rather than
resolving to nothing and reporting that `$` is not a field.
