# create-speqkit-plugin

Scaffold a speq plugin.

```bash
npm create speqkit-plugin kafka
# or: pnpm create speqkit-plugin kafka
```

```
speqkit-plugin-kafka/
  package.json          the contract as a peer; nothing depends on the kernel
  tsconfig.json
  vitest.config.ts
  src/index.ts          one step type, one assertion, both with schemas
  test/plugin.test.ts   eight tests, against the real kernel
  README.md
  .gitignore
```

```bash
cd speqkit-plugin-kafka
npm install
npm test
```

## Options

```
npm create speqkit-plugin <name>

  <name>              short name: http, kafka, my-thing
                      the package becomes speqkit-plugin-<name>

  --dir <path>        where to write it (default: ./speqkit-plugin-<name>)
  --scope @acme       publish under a scope: @acme/speqkit-plugin-<name>
  --description <s>   one line, for package.json and the README
  --force             write into a directory that is not empty
```

Called with no name from a terminal, it asks for one. Called with no name from
CI, it fails — a prompt there would hang the job instead of failing it.

## What the scaffold decides for you

**The contract is a peer, never a dependency.** A plugin that shipped its own
`@speqkit/plugin-api` would be version-checked against its own copy. The
contract comes from the kernel the user installed.

**Nothing imports `speqkit`.** A plugin is contributed *into* a kernel that is
already running; everything it needs arrives as `ctx`. Naming the kernel in
`dependencies` puts a second copy of it in the user's store and boots it — we
shipped that bug once, and the scaffold is where it stops being possible to
inherit it. The kernel is there as a devDependency, because the tests run one.

**The step type and the assertion carry schemas.** They are placeholders and
you will delete them; the schemas around them are the part to keep. They are
how a typo in a test file fails in milliseconds, naming the file and the path,
instead of half-way through a run against a real environment.

**The tests use `@speqkit/test-kit`,** which runs the plugin inside the real
`Registry`, `Executor` and runner. There are no fakes to keep in sync, and a
green test means the plugin works in a project.

**The `speqkit-plugin` keyword is in `package.json`.** It is how the plugin is
found. Without it the plugin works and nobody discovers it.

## Publishing

```bash
npm publish              # or --access public, for a scoped package
```

Then anyone can install it:

```bash
speq plugins add speqkit-plugin-kafka
```

No blessing needed from us — a short name like `kafka` resolves to
`@speqkit/plugin-kafka` first, but any package named in full is installed as
written.

MIT.
