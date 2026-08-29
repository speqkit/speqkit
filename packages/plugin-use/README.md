# @speqkit/plugin-use

Composition: calling something declared somewhere else.

```yaml
# speq.yaml
plugins:
  - use

use:
  modulesDir: modules     # defaults, all relative to the project root
  sharedDir: shared
  fixturesDir: fixtures
```

One step type, three forms — a shared block, a module action, a fixture. They
differ only in what they hand back, which is why they are one plugin and one
keyword: a tester should not have to learn where our filing cabinet has a
divider.

```yaml
steps:
  - id: setup
    type: use
    ref: register-tenant          # shared/register-tenant.yaml

  - id: category
    type: use
    action: menu.createCategory   # modules/menu.yaml, action `createCategory`
    properties:
      accessToken: "${setup.token}"
      name: "starters"

  - id: item
    type: use
    fixture: menu-item            # fixtures/menu-item.yaml
    overrides:
      name: "speq-item"

  - type: http
    method: POST
    url: "/categories/${category.id}/items"
    body: "${item}"
    assert:
      - type: status
        expected: 201
```

## What each form hands back

A `use` step is a step: it binds by `id` like every other one, and `${id.…}`
reads what it published.

**A shared block** is a file of steps, pulled into the tests that need the same
world built. Without `returns` it publishes its own steps by id; with one, it
publishes exactly what it says and nothing else.

```yaml
# shared/register-tenant.yaml
steps:
  - id: tenant
    type: http
    method: POST
    url: /auth/register
    body: { slug: "${tenantSlug}" }
    assert:
      - type: status
        expected: 201

returns:
  token: "${tenant.body.access_token}"
  restaurantId: "${tenant.body.restaurant.id}"
```

`returns` is worth adding the moment a block is used more than twice. Without
it every caller reaches through the block's internals — `${setup.tenant.body.
access_token}` — and renaming a step inside the block breaks fifty tests that
never mentioned it.

**A module action** is the same thing with parameters. `properties` are the
variables its steps see, and they are declared so a caller that forgets one is
told before the run rather than during it.

```yaml
# modules/menu.yaml
actions:
  createCategory:
    properties: [accessToken, name]
    steps:
      - id: created
        type: http
        method: POST
        url: /categories
        headers: { authorization: "Bearer ${accessToken}" }
        body: { name: "${name}" }
    returns:
      id: "${created.body.id}"
```

An action's steps run in a child scope, so `${created…}` is invisible to the
test that called it. That is the point: what escapes an action is its
`returns`, which makes the action's insides free to change.

**A fixture** is a call whose result is data rather than an effect — a body
built somewhere else so the test can stay about what it is proving.
`overrides` merges at the top level and beats what the fixture built, so a test
pins the one field it means to assert on and leaves the rest generated.

```yaml
# fixtures/menu-item.yaml
fixture:
  build:
    name: "${gen:string}"
    description: "${gen:string}"
```

## Where files are looked up

Paths are relative to the **project root**, or bare inside the directory for
their kind: `ref: register-tenant` is `shared/register-tenant.yaml`, and
`ref: blocks/other.yaml` is `<root>/blocks/other.yaml`. The `.yaml` is
optional.

Deliberately not relative to the test file. A plugin is never told which file
the step it is running came from, so `../../../shared/x.yaml` could only be
resolved against the wrong directory — and how deep a suite tree happens to be
is not something a shared block should have an opinion about. A path written
the v1 way is refused by `speq validate`, with the fix in the hint.

## What it checks before anything runs

`speq validate` catches all of it in milliseconds, naming the file and the step:

- the block, module or fixture file is not on disk
- the module has no such action — and which ones it has
- an action was called without a property it declares
- two of `ref` / `action` / `fixture` on one step
- `as:`, which is the v1 spelling for naming a result — write `id:`

## The one thing it cannot say

A step type can return a result or throw; the contract gives it no way to
report `failed`. So when a step *inside* a block fails an assertion, the `use`
step errors rather than failing, carrying the inner step's id and message. The
difference between "the system was wrong" and "we could not ask" is lost at
that boundary. It is written down here rather than papered over — the fix
belongs in the contract, not in a workaround.

## Migrating from speq v1

| v1 | here |
| --- | --- |
| `type: use` + `ref: "../../shared/x.yaml"` | `ref: x` — root-relative or bare |
| `as: parentCategory` | `id: parentCategory` |
| `{{tenant.response.body.token}}` | `${setup.tenant.body.token}`, or a `returns` on the block |
| `bodyFromFixture: { ref, overrides }` on a step | a `use` step with `fixture:`, then `body: "${item}"` |

`speq migrate` does the mechanical part. Adding `returns` to a block that
outgrew publishing its internals is the part worth doing by hand.
