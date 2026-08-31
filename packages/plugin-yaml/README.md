# @speqkit/plugin-yaml

The default authoring format — and the proof that the format is a plugin.

```yaml
# speq.yaml
plugins:
  - yaml
```

Claims `.yaml` and `.yml` under `suites/`. Without a loader registered, no test
file can be read at all: the kernel has no idea what a test file looks like,
and says so rather than assuming.

## Several tests per file

Documents are separated by `---`, and each becomes its own test:

```yaml
name: a user can register
steps:
  - type: http
    method: POST
    url: /users
---
name: a duplicate is rejected
steps:
  - type: http
    method: POST
    url: /users
assert:
  - type: status
    expected: 409
```

A file without a `name` takes the filename. `tags`, `steps` and `assert`
default to empty rather than being required, so the smallest useful file is
two lines.

A YAML syntax error is reported with the file and the parser's own message,
before anything runs.

## The test form

| | |
| --- | --- |
| `id` | the test's identity — stable, and what every event carries |
| `title` | the sentence a person reads, when the identity is not one |
| `tags` | what `--tags` filters on |
| `variables` | the test's givens, resolved before anything runs |
| `setup` / `steps` / `cleanup` | what it does |
| `assert` | checks over the whole test |

That list is closed, and everything outside it is an annotation:

```yaml
id: menu.items-create.creates-item
title: POST /categories/{id}/items creates an item
owner: mira
epic: menu
jira: SHOP-4417
```

`owner`, `epic` and `jira` are carried to every reporter and read by none of
them unless a plugin asks. Nothing has to be declared, because the alternative
is making every team's field a contract of ours: `link`, `severity`, a ticket
number — there will be as many of these as there are teams, and no list we
write down is the right one.

The kernel carries them and never branches on them. That is the invariant, not
an implementation detail: the moment behaviour follows from an annotation
(`retries: 3`, `skip: true`) a suite has control flow that `speq validate`
cannot see and a report cannot explain. Behaviour is a step type or a config
key — something declared, and something checked.

They are readable while the test runs, too:

```yaml
steps:
  - type: http
    method: GET
    url: /orders
    headers:
      x-owner: "${meta:owner}"
```

## A directory that describes itself

`init.yaml` describes the directory it sits in and is never a test:

```yaml
# suites/menu/init.yaml
epic: menu
owner: mira
```

Every test under `suites/menu/` inherits both. The nearer file wins over the
one above it, and the test wins over both — so `epic` is written once on the
directory that *is* the menu group, rather than copied into twelve files where
the thirteenth will be forgotten.

It is read from disk rather than from whatever the run happened to walk, so
`speq run --test suites/menu/items/lists.yaml` sees exactly the annotations
that file gets in a full run. A report that depended on how the run was started
would be worse than no report.

## speq migrate

The codemod for suites written against speq 1.x. It lives here because it is
this plugin's knowledge pointed backwards: whatever decides what `${...}` means
is the only honest home for the thing that rewrites `{{...}}` into it.

```bash
speq migrate --from ../.speq --out .          # says what it would do
speq migrate --from ../.speq --out . --write  # does it
```

| v1 | here |
| --- | --- |
| `{{x}}` | `${x}` |
| `{{adminApi}}` | `${vars:adminApi}` — an environment value, not a step |
| `{{a.response.body.0.id}}` | `${a.body[0].id}` |
| `$steps.a.response.body.id` | `${a.body.id}` |
| `type: api` | `type: http` |
| `name:` on a step | `meta: { name: … }` |
| `as: x` | `id: x` |
| `bodyFromFixture:` | a `use` step, then `body: "${…}"` |
| `{ gen: { type: uuid } }` | `"${gen:uuid}"` |
| `type: json`, `path: "$.a"` | `type: equals`, `path: body.a` |
| `notcontains` / `regex` | `not_contains` / `matches` |
| `status: pending` | `pending: "<why>"` — the reason was only ever a comment, so it asks for one |
| `retry:` in the manifest | `http.retry`, with 429 dropped from the list |
| `manifest.yaml` + `environments/*` | `speq.yaml` + environment layers |

Two things it does that are worth knowing about.

**A shared block gains an owner at every call site.** In v1 a block published
its step ids straight into the calling test — `{{tenant.response.body.token}}`,
with nothing saying where `tenant` came from. A block now runs in its own scope
and hands its result back through the step that called it, so the codemod names
that step and rewrites the references through it. That is the one semantic
change in the migration, and it is the point of it: what used to leak is now
written down.

**It reports what it will not decide.** A suite-level `beforeEach` has no
successor yet; a v1 retry policy belongs to a plugin that is not written. Those
are named, by file, with what to do instead — never quietly dropped. A codemod
that drops what it does not understand is worse than one that refuses: the
suite still runs, and the check that used to guard it is simply gone.

Comments survive, because these files are documentation as much as tests — the
rewrite goes through the YAML document tree rather than parse-and-restringify.
Prose is left alone: a comment explaining what *callers* write is not something
a codemod can rewrite correctly, and it says so rather than guessing.

## Why it is a plugin

YAML ships as the default because it is readable by people who do not program
— which is most of the people who write the tests. That is a reasonable
default and a terrible constraint.

A TypeScript loader, a Gherkin loader, or a loader that reads test cases out of
your issue tracker is an ordinary plugin someone can publish tomorrow. It
registers `defineLoader` with the extensions it claims and returns `TestDef[]`.
Nothing in the kernel has to learn about it, and nothing here has to be forked.

MIT.
