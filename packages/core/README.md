# speqkit

A declarative test framework where almost everything is a plugin — including
the authoring format, the CLI, control flow and the reports.

```bash
npm i -g speqkit     # the package is speqkit, the command is speq
speq init
speq install
speq run
```

The package is `speqkit`. The command is `speq`.

## What this package is

The kernel, and nothing else. It knows how to find a project, read its config,
load plugins, execute a tree of steps, evaluate assertions, manage scoped
resources and emit an event stream. It does not know what HTTP is, what a
browser is, what YAML is, or that a terminal exists.

```
speq.yaml   →  discoverRoot   find the project
            →  loadConfig     flatten `extends`, layer one environment
            →  loadPlugins    resolve from link, store or node_modules
            →  handover       everything you recognise as the framework
```

Four steps. Everything after them is contributed.

## A test

```yaml
# .speq/suites/health.yaml
name: service answers
tags: [smoke]

steps:
  - id: login
    type: http
    method: POST
    url: /session
    body: { user: "${env:USER}" }

  - id: me
    type: http
    url: /users/${login.body.id}

assert:
  - type: status
    expected: 200
  - type: jsonpath
    path: name
    expected: Ada
```

`http` is not a kernel feature. It is
[`@speqkit/plugin-http`](https://github.com/speqkit/speqkit/tree/main/packages/plugin-http),
and a step type you write yourself is registered exactly the same way.

## The commands the kernel owns

Only the ones that must work *before* plugins are loaded — otherwise there
would be no way to install the plugin that provides the rest.

```
speq init [--mode in-repo|test-repo]   scaffold a project
speq install [--frozen]                fetch what speq.yaml asks for
speq add <plugin>... | speq remove     edit speq.yaml and install
speq link <path> | speq unlink         a plugin you are writing right now
speq plugins                           what is loaded, and what it contributes
speq doctor                            environment, store, compatibility
```

`speq run`, `speq report`, `speq validate` and `speq list` come from
[`@speqkit/plugin-cli`](https://github.com/speqkit/speqkit/tree/main/packages/plugin-cli).
Remove it and the kernel still runs — from an editor, a TUI, or your own
harness.

## Installing plugins without npm

`speq install` talks to the npm registry over HTTP itself: resolves the range,
downloads the tarball, verifies its sha512, unpacks it, lays out a store and
writes `speq.lock`. It never shells out to `npm`, `pnpm` or `yarn` — requiring
the very package manager we replace would defeat the point, and a QA repository
that is not a Node project should not have to become one.

The store layout is pnpm's, for pnpm's reason: a dependency is a symlink
*inside* the depending package's own directory, so ordinary Node resolution
finds it and two plugins may want different versions of the same library.

## As a library

The kernel is a normal ES module. A custom harness, an editor extension or a
CI wrapper drives it directly:

```ts
import { bootstrap, discoverTests, runTests } from 'speqkit'

const session = await bootstrap({ root: '.speq', env: 'ci' })
const tests = await discoverTests(session.registry, { root: session.root.root, tags: ['smoke'] })
const outcome = await runTests(session.registry, tests, { reporters: ['junit'] })

process.exit(outcome.status === 'passed' ? 0 : 1)
```

A **plugin** does not do this. A plugin runs inside a kernel that is already
booted and reaches it as `ctx.host` — see
[`@speqkit/plugin-api`](https://github.com/speqkit/speqkit/tree/main/packages/plugin-api).
The distinction matters: a plugin that imports this package ships a second
kernel in its dependencies, and the installer will faithfully install it.

## Stability

**0.x — nothing is stable.** `@speqkit/plugin-api` is the contract that will be
frozen at 1.0; this package's version is free to move underneath it.

MIT.
