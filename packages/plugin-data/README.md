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

## What is deliberately not here

A clock. `${gen:date}` makes up a date; "today", "in three days" and "an hour
ago" are a different question, and answering it with a generator would make
every one of those values change under a seed that was supposed to hold them
still.

## Migrating from speq v1

| v1 | here |
| --- | --- |
| `tenantSlug: { gen: { type: uuid } }` | `tenantSlug: "${gen:uuid}"` |
| `{ gen: { type: int, min: 100, max: 999999 } }` | a generator in `data.generators`, called as `${gen:price}` |
| `gen` expands only inside a test's `variables` | `${gen:…}` resolves anywhere; `variables` is what gives it a name and a lifetime |
| `environments/local.yaml: adminApi: /api/admin/v1` | `data.vars.adminApi`, read as `${vars:adminApi}` |
| `{{adminApi}}` | `${vars:adminApi}` |
