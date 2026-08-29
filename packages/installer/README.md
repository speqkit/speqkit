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

- `github:`, `git+ssh:` and tarball-URL specs. They are refused with a message
  saying so, rather than turning into a confusing 404. `speq link` covers the
  local-checkout case today.
- Reading `.npmrc`. A private registry works through `SPEQ_REGISTRY` and
  `NPM_TOKEN`.

The standalone binary used to be on this list. It is now built by
`scripts/build-binary.mjs` and installed with `brew install speqkit` or
`curl … | sh`, so nothing here needs a Node runtime on the machine. The store
it writes to and the lock it replays are the same either way — the binary is a
different way of shipping this code, not a different code path through it.
