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

## Why it is a plugin

YAML ships as the default because it is readable by people who do not program
— which is most of the people who write the tests. That is a reasonable
default and a terrible constraint.

A TypeScript loader, a Gherkin loader, or a loader that reads test cases out of
your issue tracker is an ordinary plugin someone can publish tomorrow. It
registers `defineLoader` with the extensions it claims and returns `TestDef[]`.
Nothing in the kernel has to learn about it, and nothing here has to be forked.

MIT.
