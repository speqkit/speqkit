# @speqkit/installer

Resolves plugins against the npm registry, verifies them, and puts them in a
store. It never shells out to `npm`, `pnpm` or `yarn`.

That restriction is the whole point. A Go service should be able to run speq
tests without a `package.json`, a `node_modules`, or a Node toolchain — so the
one thing the installer cannot do is require the package manager it is
replacing.

## The split

**The registry is npm. The installer is ours.** Building a registry would mean
building auth, mirroring, takedowns and trust, for nothing: every plugin author
already has an npm account and `npm publish` already works. Building the
installer is what keeps a Node project's furniture out of a repository that is
not a Node project.

## The store

Plugins live once per machine, in `~/.speq` (or `$SPEQ_HOME`), never in the
project:

```
~/.speq/store/
  @speq+plugin-http@2.1.4/
    node_modules/
      @speqkit/plugin-http/          the package itself
      semver -> ../../semver@7.6.3/node_modules/semver
```

The layout is pnpm's, for pnpm's reason: a dependency is a symlink that sits
*inside* the depending package's own directory, so Node's ordinary resolution
— which follows real paths — still finds it, and two plugins wanting different
versions of the same library each get their own. Links are relative, so the
store stays movable.

The project commits one file: `speq.lock`.

```yaml
lockfileVersion: 1
presets: []
plugins:
  - spec: "@speqkit/plugin-http@^2.1.0"
    name: "@speqkit/plugin-http"
    version: 2.1.4
packages:
  "@speqkit/plugin-http@2.1.4":
    resolved: https://registry.npmjs.org/@speqkit/plugin-http/-/plugin-http-2.1.4.tgz
    integrity: sha512-…
    dependencies:
      "@speqkit/plugin-api": 1.4.0
```

## Two passes, because presets come first

A preset is an ordinary npm package that contains a `speq.yaml`, and
`extends: "@acme/speqkit-preset"` is how one platform team pins the plugin set for
thirty services at once. That creates an ordering problem: the config cannot be
read until the package it extends is on disk. So `install()` takes two
callbacks rather than two lists — it fetches the `extends` targets, and only
then asks for the flattened plugin list.

## Where a plugin can come from

```yaml
plugins:
  - http                                       # the registry, short name
  - "@acme/speqkit-plugin-legacy@^2.1.0"       # the registry, private scope
  - github:acme/speqkit-plugin-legacy#v2.1.0   # a repository
  - git+ssh://git@git.acme.internal/qa/plugin.git#main
  - https://builds.acme.dev/plugin-1.4.0.tgz   # a packed tarball
```

`github:`, `gitlab:` and `bitbucket:` are shorthands for the obvious HTTPS
URL; `git+https:`, `git+ssh:`, `git+file:` and `git:` are passed to git as
written. A `#ref` is a branch, a tag or a commit, and no `#ref` means the
default branch.

Repository sources shell out to `git`, and that is a deliberate exception to
the rule that governs the rest of this package. `speq install` speaks the npm
registry's HTTP API itself because npm is the tool being replaced — requiring
it would cancel the whole idea. Git is not being replaced by anything, it is
already on the machine of whoever owns the repository, and going through it
buys three things hand-written HTTP would not: private repositories work
through the credentials and ssh agent that are already set up, self-hosted
hosts need no per-vendor API dialect, and the commit is verified by git rather
than trusted from a vendor's JSON. Only a git spec needs git — nothing else
here does, including inside the standalone binary.

**A ref is resolved to a commit at install time, and only the commit is
locked.** `#main` in `speq.yaml` means something different next month;
`--frozen` in CI installs the commit that was reviewed. The store keys the
checkout by that commit as semver build metadata — `1.4.0+8f2c1ade9b7c` —
because two commits can carry the same `version`, and a dependent asking for
`^1.4.0` should still be satisfied.

**No build ever runs.** Not running install scripts is what makes installing
from a repository defensible at all, so a repository whose entry point is not
committed is refused at install time with the reason, rather than installing
cleanly and failing to load minutes later inside a plugin loader that cannot
say why.

A tarball URL is hashed on arrival and the hash goes in the lock, since no
registry published one to compare against. The registry token is never sent to
a host that is not the registry.

## Things it refuses to do

- **Follow a link entry in a tarball**, or write a path containing `..` or a
  leading `/`. This is the one place an installer reliably grows a security
  hole; both are refused loudly rather than sanitised quietly.
- **Install a tarball whose hash does not match** what the registry published.
- **Think for itself under `--frozen`.** It replays the lock, and fails if
  `speq.yaml` has drifted from it, which is exactly the mistake CI exists to
  catch.
- **Delete anything on `speq remove`.** The store is shared; a plugin one
  project stopped using is still cached for the next.

## Not built yet

- Reading `.npmrc`. A private registry works through `SPEQ_REGISTRY` and
  `NPM_TOKEN`.
- A repository that depends on another repository. A package's own
  `dependencies` are resolved from the registry whatever the package itself
  came from, because that is what a range in a package.json means.

The standalone binary used to be on this list. It is now built by
`scripts/build-binary.mjs` and installed with `brew install speqkit` or
`curl … | sh`, so nothing here needs a Node runtime on the machine. The store
it writes to and the lock it replays are the same either way — the binary is a
different way of shipping this code, not a different code path through it.
