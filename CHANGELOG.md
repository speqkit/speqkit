# Changelog

What changed in **the thing you install** — `speqkit`, the kernel behind the
`speq` command. Its version is what names a release: when it moves, four
executables, a GitHub release and the Homebrew formula follow it, and the
plugins that went out alongside are listed under the entry.

The plugins are versioned independently and most releases move only some of
them, so the tables below are the record of what a given `speq` was published
with. A plugin's own README is where its behaviour is documented.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project is on [semantic versioning](https://semver.org/) — pre-1.0, so a
**minor** bump is where a breaking change is allowed to live, and a caret range
on `0.x` pins the minor for exactly that reason.

## [Unreleased]

Nothing yet.

## [0.2.0] — 2026-08-31

The release that made releasing not a thing anyone does. Also the first one you
can install without a JavaScript toolchain on the machine at all.

### Added

- **Standalone executables**, one per platform, each with a pinned Node runtime
  inside it — `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. A Go or
  Python repository can install a test runner without installing a JavaScript
  toolchain first.
- **`brew install speqkit/tap/speqkit`**, and
  `curl -fsSL https://speqkit.github.io/speqkit/install.sh | sh` for machines
  without Homebrew. The script verifies the archive against a published sha256
  and refuses to install one it cannot check.
- **`@speqkit/plugin-use`** — composition: shared blocks, module actions and
  fixtures, all through one `use` step.
- **`@speqkit/plugin-data`** — `${gen:…}` for data a test makes up, `${env:…}`
  moved out of `plugin-http` where it never belonged, and `${vars:…}` for the
  values an environment file sets. Generated values are derived from the run id
  rather than the system random source, so replaying a run's data means copying
  the string that already names its report directory.
- **`@speqkit/plugin-assert`** — twenty-one words for equality, order,
  membership, text, presence, size and shape, over one selector shared by all of
  them. `schema` validates through ajv rather than a subset of our own.
- **`@speqkit/plugin-json`** — `reports/results/summary.json`, folded out of the
  event stream, in the shape a workflow already reads with `jq`.
- **`@speqkit/test-kit`** — runs a plugin inside the real kernel, so an author
  can test one without a project. Not a plugin: it boots one.
- **`create-speqkit-plugin`** — `npm create speqkit-plugin <name>` scaffolds a
  plugin with its tests, its schemas and its release workflow already written.
- **Plugins from a repository**, not only a registry: `github:acme/plugin#v2`,
  `git+ssh://…#main`, or a tarball URL. A ref resolves to a commit at install
  time and only the commit is locked, so `--frozen` in CI installs what was
  reviewed rather than wherever a tag has moved since.
- **Multipart requests and retrying** in `plugin-http`. Retrying is off by
  default, and when on it leaves 429 alone and repeats only idempotent methods.
- **Contract 0.5.0 → 0.9.0**: `StepTypeDef.validate` and
  `AssertionTypeDef.validate` (a plugin checks its own inputs before the run,
  not during it); `StepDef.assert`, `TestDef.setup`, `TestDef.cleanup`;
  `TestDef.variables`, resolved one at a time in declaration order; `meta`, which
  the kernel carries and never reads; and `pending`, which takes a reason rather
  than a flag. `PLUGIN_API_VERSION` stays `1` and no ninth contribution point
  was opened.
- **A value provider may answer asynchronously** — a secret from a vault, a row
  from a database — without making resolution async for anything else.
- **The documentation site** at <https://speqkit.github.io/speqkit/>, with a
  build that fails when an internal link points at nothing.
- **Delivery, end to end.** Bump a version in a `package.json`, merge to main,
  and if the gate is green that version is on npm — with provenance — and a
  kernel bump takes the binaries, the release and the tap with it. Plugin
  authors get the same machinery as a reusable workflow they can call from their
  own repository.

### Changed

- `jsonpath` and `body_contains` moved from `plugin-http` to `plugin-assert`,
  and `env` moved to `plugin-data`. What is left in the HTTP plugin is the two
  checks that are actually about HTTP. **The old names still work** and say what
  to write instead.
- `speq migrate` and the YAML loader now carry the decided test form — `id`,
  `title`, `tags`, `variables`, `setup`, `steps`, `assert`, `cleanup` — and the
  60-test suite this framework was designed against migrates and validates
  clean. What has no successor is named by file with what to do instead, never
  silently dropped.

### Fixed

- `attach` took bytes and dropped them. The plugin-facing call is unchanged; the
  kernel now writes the file and the event carries a `path`.
- `AssertContext.results` was documented as every step result so far and was
  always empty, so `${a.value}` in an `assert:` block reported that `a` was not
  defined. The executor was discarding the test's own bindings the moment its
  last step finished — before assertions run.
- `tsconfig.json`'s `paths` map had lost three packages, which made
  `pnpm typecheck` pass for anyone who had run `pnpm build` once and fail on
  every clean clone. A test now fails when a fourth goes missing.

### Published with this release

| Package | Version |
| --- | --- |
| `speqkit` | 0.2.0 |
| `@speqkit/plugin-api` | 0.9.0 |
| `@speqkit/installer` | 0.2.0 |
| `@speqkit/plugin-yaml` | 0.2.0 |
| `@speqkit/plugin-http` | 0.2.0 |
| `@speqkit/plugin-cli` | 0.2.0 |
| `@speqkit/plugin-loop` | 0.2.0 |
| `@speqkit/plugin-junit` | 0.2.0 |
| `@speqkit/plugin-playwright` | 0.2.0 |
| `@speqkit/plugin-use` | 0.1.0 |
| `@speqkit/plugin-data` | 0.1.0 |
| `@speqkit/plugin-assert` | 0.1.0 |
| `@speqkit/plugin-json` | 0.1.0 |
| `@speqkit/test-kit` | 0.1.0 |
| `create-speqkit-plugin` | 0.1.0 |

## [0.1.0] — 2026-08-28

The first packages on npm: the kernel, the contract at 0.4.0, the installer and
six plugins — `yaml`, `http`, `cli`, `loop`, `junit`, `playwright`. Published by
hand, before the pipeline existed, which is why there is no `v0.1.0` tag and no
GitHub release to go with it. There were no executables yet: installing speq
meant having Node.

[Unreleased]: https://github.com/speqkit/speqkit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/speqkit/speqkit/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/speqkit/v/0.1.0
