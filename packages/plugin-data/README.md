# @speqkit/plugin-data

Where values come from.

```yaml
# speq.yaml
plugins:
  - data

data:
  vars:
    adminApi: /api/admin/v1
    tenantPassword: ${env:TENANT_PASSWORD:-speq-tenant-password-1}
  generators:
    price: { type: int, min: 100, max: 999999 }
```

Three providers and no step types: this plugin never does anything, it only
answers.

```yaml
name: a restaurant can be created

variables:
  slug: "${gen:uuid}"
  email: "speq-${slug}@example.com"

steps:
  - id: registered
    type: http
    method: POST
    url: "${vars:adminApi}/auth/register"
    headers: { authorization: "Bearer ${env:CI_TOKEN}" }
    body:
      email: "${email}"
      password: "${vars:tenantPassword}"
      restaurant_slug: "${slug}"
    assert:
      - type: status
        expected: 201
```

| | |
| --- | --- |
| `${gen:…}` | a value made for this test: `uuid`, `string`, `int`, `email`, `date`, or a generator declared in the config |
| `${env:NAME}` | what the environment holds. `${env:NAME:-fallback}` when it is optional |
| `${vars:name}` | a project value from `data.vars`, tuned per environment file |

And three step types, which are the only things here that appear in a `steps:`
list — none of them touches the system under test:

| | |
| --- | --- |
| `set` | binds a value the test already has, under a name |
| `pick` | the element of a list that satisfies some clauses |
| `calc` | a number worked out from values the test already read |

## Variables are where generated values get their name

`variables` is the test's givens, resolved once before anything runs and
readable from setup, steps, assertions and cleanup alike. They are resolved
**one at a time, in declaration order**, which is what makes both of these
work:

```yaml
variables:
  slug: "${gen:uuid}"
  foreignSlug: "${gen:uuid}"          # a different uuid — see below
  email: "speq-${slug}@example.com"   # written in terms of the one above
```

The reason the first two differ is worth knowing, because it is the one place
`gen` is not what it looks like. speq asks a value provider **once per
resolution pass**, on purpose: two `${env:HOME}` in one step are one lookup, and
a provider is meant to be a lookup. A generator is not, so a whole `variables`
block resolved in one pass would have handed `slug` and `foreignSlug` the same
uuid — and the test that exists to prove two tenants stay apart would have been
testing one tenant against itself. Each given therefore gets its own pass.

Inside a single step, the rule still holds as written: `"${gen:uuid}/${gen:uuid}"`
in one step's input is one uuid twice. That is the corner. Two independent
values are declared in `variables`, where each has a name and a lifetime, not
inlined where they have neither.

## A run you can run again

Every generated value is derived, not drawn from the system random source:

```
value = f(seed, test name, generator, how many times this test has asked)
```

The seed defaults to the **run id** — already printed by every reporter, and
already the name of the run's report directory. So repeating a run's data means
copying a string that is on screen:

```yaml
data:
  seed: "0f9c2a7e-..."     # or SPEQ_SEED=0f9c2a7e-...
```

The test's own name is part of the derivation rather than a position in a
shared stream, which is what makes re-running one failing test out of sixty
show it what it saw the first time. Running it alone and running it inside the
suite ask for the same bytes.

Which test is asking comes from the kernel, per call, and that is the whole of
why it is right under `--workers`. It used to be a variable this plugin set
from a `test:before` hook — the last test to have started, which is correct in
every sequential run and wrong the moment two suites run at once: a value
generated for one test was keyed by another's name, and two tests could be
handed the same "unique" tenant. There is a test that runs the same two suites
sequentially and four-up and compares.

Two things follow, and both are the point. Different runs get different data,
so a suite that registers tenants never collides with yesterday's rows. And a
run replayed with the same seed produces the *same* rows — against a database
that still holds the first run's, which is exactly what replaying means.

## The generators

| | |
| --- | --- |
| `uuid` | a v4 uuid |
| `string` | lowercase alphanumerics, 16 characters. `minLength`, `maxLength` |
| `int` | `min` (0) to `max` (1,000,000), inclusive |
| `email` | `speq-<16 hex>@example.com`. `emailDomain` moves the domain |
| `date` | `YYYY-MM-DD`, in the last year. `from`, `to` fix the window |

Two of those defaults are answers to bugs a real suite hit.

`string` is lowercase alphanumerics because a mixed-case one is not a legal
slug in about half the APIs a suite points at, and a generator whose output is
sometimes rejected by validation is worse than no generator.

`email` is built from a hash rather than assembled out of a word pool. A pool
small enough to read is small enough to collide inside one run, which surfaces
as a scattering of 409s from register that look like a flaky API and are not.
Every address is also greppable as `speq-%@` in the database afterwards.

Parameters live in the config rather than in the template:

```yaml
data:
  generators:
    price: { type: int, min: 100, max: 999999 }
    shortName: { type: string, minLength: 8, maxLength: 24 }
```

`${gen:price}` then reads as what it is at every call site, and the range is
settled in one place instead of being copied into thirty fixtures. A generator
the config got wrong — `min` above `max`, a type that does not exist — is
refused when the plugin loads, not twenty minutes into a suite.

## env

`${env:NAME}` throws when the variable is unset and no `${env:NAME:-fallback}`
was written. A token that quietly becomes an empty string produces a suite that
fails for the wrong reason, or worse, passes against nothing.

This provider used to live in `plugin-http`, for no better reason than HTTP
being the first plugin that wanted a token out of CI. `${env:…}` inside
`speq.yaml` itself is a separate thing, expanded by the kernel when the config
is read — a plugin cannot be asked for a value before it has been loaded.

## `set`

The one step type here, and it acts on nothing: it binds what the test already
wrote, under the step's id.

```yaml
steps:
  - id: created
    type: http
    method: POST
    url: /orders
  - id: order
    type: set
    value: ${created.body.id}
  - type: http
    method: GET
    url: /orders/${order.value}
```

A given that comes out of a step cannot go in `variables:` — those are resolved
once, before anything runs. Without `set` the choice was writing the same
`${created.body.id}` out in four places, or a name at the top of the file that
is nowhere near the steps that read it.

It binds under the step's id like everything else, so it is `${order.value}`
and not `${order}`. That is one character worse and one rule fewer.

## `pick`

Which element of a list a test means, said by what is in it.

```yaml
steps:
  - id: snap
    type: http
    method: GET
    url: /public/menu/demo/main

  - id: item
    type: pick
    from: ${snap.body.categories[*].items[*]}
    where:
      - type: contains
        path: optionGroups[*].required
        expected: true

  - type: http
    method: GET
    url: /items/${item.value.id}
```

It binds two things: `${item.value}`, the element, and `${item.index}`, where
it was.

The alternative is a row number, and a row number is a different test than the
one that was meant. `categories[0].items[0]` points at the item with the
required option group today, in a fixture that moves for reasons this test
knows nothing about — a category added, a menu reordered. On that day the suite
either fails with no defect behind it or, worse, quietly starts ordering a
plain item and checking a total that no longer exercises an option at all.

**The clauses are the assertion vocabulary**, not a second one. `equals`,
`contains`, `greater_than`, `exists`, `matches` — every word
`@speqkit/plugin-assert` has, and every word a plugin somebody else published
has added to it, working here the day it is installed. A clause's `path` reads
into the element. There is deliberately no list of comparison words in this
plugin, because two lists of the same words drift and the author then has to
know which of the two they are writing in.

So `pick` needs an assertion plugin loaded. Without one the step says which
clause nobody can answer and stops, rather than matching nothing — a filter
that silently selects zero is the failure this framework exists to remove.

**Narrowing is composed, not combined.** A clause reads a wildcard path as the
list it is, so `greater_than` over `optionGroups[*].options[*].priceDeltaMinor`
is comparing a list to a number and will say so. What that reads as instead is
a second `pick` over the first one's result, where the subject is a single
option and the comparison has something to compare:

```yaml
  - id: option
    type: pick
    from: ${item.value.optionGroups[*].options[*]}
    where:
      - type: greater_than
        path: priceDeltaMinor
        expected: 0
```

There is no `and` / `or` here for the same reason there is none in an `assert:`
block: the clause list already reads as "all of these hold", and a filter that
needs boolean algebra is usually two picks.

**When nothing matches**, the step says how many elements it examined and what
the closest one failed on. "No element matched" alone leaves the author diffing
four clauses against sixty elements by hand, and the element that failed fewest
is the one they wanted to look at.

## `calc`

What a number should be, worked out from what the test already read.

```yaml
steps:
  - id: expected
    type: calc
    multiply:
      - add:
          - ${item.value.priceMinor}
          - ${option.value.priceDeltaMinor}
      - 2

  - type: http
    method: POST
    url: /public/orders
    assert:
      - type: equals
        path: body.totalMinor
        expected: ${expected.value}
```

Three words — `add`, `subtract`, `multiply` — nested as mappings, each taking a
list of operands. An operand is a number, a `${…}` that resolves to one, or
another operation. `subtract` takes exactly two.

**A list operand is its elements**, which is what makes a wildcard path a sum:

```yaml
  - id: charged
    type: calc
    add:
      - ${order.body.lines[*].totalMinor}
```

The two things this replaces are both bad tests. A constant —
`expected: 108000` — turns *the server adds up correctly* into *the server adds
up the way it did last time*, pinned to a fixture that will move. Reading the
total back off the response and comparing it to itself checks nothing at all,
and is the easier of the two to write by accident.

### Why mappings and not `(a + b) * n`

An expression is a string. The kernel would have to parse it, `speq validate`
could check nothing past its syntax, and a misspelled field name inside it
would survive until the run — which is the whole class of mistake this project
exists to catch before the run. It also does not stay small: an expression
language acquires string functions, then dates, then a ternary, and at that
point the suite has control flow that no report can explain.

This is longer to read and that is the trade being made knowingly. `speq
validate` checks the shape of a `calc` the way it checks every other step
input.

### There is no `divide`

A decision rather than an omission. Money here is integer minor units; a
division that does not come out exactly is a rounding rule, rounding rules
belong to the server, and a test that invents its own agrees with the server
right up until the half-cent where it matters. A case that genuinely needs it
can ask, with the case attached.

## What is deliberately not here

A clock. `${gen:date}` makes up a date; "today", "in three days" and "an hour
ago" are a different question, and answering it with a generator would make
every one of those values change under a seed that was supposed to hold them
still.

An expression language. `set`, `pick` and `calc` are three step types with
closed schemas, and between them they answer the three questions a suite kept
running into — name this, choose that, add these up. Each is checked before the
run. A string that has to be parsed is not, and that is the whole difference.

## Migrating from speq v1

| v1 | here |
| --- | --- |
| `tenantSlug: { gen: { type: uuid } }` | `tenantSlug: "${gen:uuid}"` |
| `{ gen: { type: int, min: 100, max: 999999 } }` | a generator in `data.generators`, called as `${gen:price}` |
| `gen` expands only inside a test's `variables` | `${gen:…}` resolves anywhere; `variables` is what gives it a name and a lifetime |
| `environments/local.yaml: adminApi: /api/admin/v1` | `data.vars.adminApi`, read as `${vars:adminApi}` |
| `{{adminApi}}` | `${vars:adminApi}` |
