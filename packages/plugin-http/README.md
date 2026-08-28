# @speqkit/plugin-http

HTTP steps and the smoke assertions most teams need on day one.

```yaml
# speq.yaml
plugins:
  - http

http:
  baseUrl: https://api.example.com
  headers:
    authorization: Bearer ${env:API_TOKEN}
```

```yaml
# suites/orders.yaml
name: an order can be placed

steps:
  - id: create
    type: http
    method: POST
    url: /orders
    body: { sku: "ABC-1", qty: 2 }

  - id: fetch
    type: http
    url: /orders/${create.body.id}
    query: { expand: items }

assert:
  - type: status
    expected: 200
  - type: jsonpath
    path: items[0].sku
    expected: ABC-1
  - type: duration_under
    ms: 800
```

## What it registers

| | |
| --- | --- |
| step `http` | `method`, `url`, `headers`, `body`, `query`. A `url` starting with `http://` or `https://` ignores `baseUrl`. |
| assertion `status` | `expected` — exact match on the status code. |
| assertion `jsonpath` | `path`, `expected`. Dotted path with `[n]` indexing, compared structurally. |
| assertion `body_contains` | `expected` — substring of the raw response text. |
| assertion `duration_under` | `ms` — the budget for the step that just ran. |
| provider `env` | resolves `${env:NAME}` anywhere in the config or a test. |

`${env:API_TOKEN}` in `speq.yaml` is expanded when the config is read, and an
unset variable with no `${env:NAME:-fallback}` is an error rather than an empty
string. A token that silently becomes `Bearer ` produces a suite that fails for
the wrong reason, or worse, passes against nothing.

The step returns `{ status, ok, headers, body, text, url, durationMs }`, all of
it addressable from later steps as `${id.field}` once the step has an `id`.

## Nothing about it is privileged

The kernel contains no mention of HTTP. This plugin registers a step type and
four assertions through the same public API a plugin you write would use, and
if it ever needed a kernel change, that would mean the spine is wrong — not
that HTTP is special.

`fetch` is Node's own, and the step honours `exec.signal`, so a timeout budget
aborts the request in flight rather than waiting for it to come back.

MIT.
