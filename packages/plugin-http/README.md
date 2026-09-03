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
  - type: equals                # @speqkit/plugin-assert
    path: body.items[0].sku
    expected: ABC-1
  - type: duration_under
    ms: 800
```

## What it registers

| | |
| --- | --- |
| step `http` | `method`, `url`, `headers`, `body`, `multipart`, `query`, `retry`. A `url` starting with `http://` or `https://` ignores `baseUrl`. |
| assertion `status` | `expected` — exact match on the status code. |
| assertion `duration_under` | `ms` — the budget for the step that just ran. |

Two checks, not five. `jsonpath` and `body_contains` moved to
[`@speqkit/plugin-assert`](../plugin-assert), which is where the whole
vocabulary lives — they were checking a *value*, and a value does not care that
it arrived over HTTP. Both names still work from there, so nothing breaks, and
`speq migrate` rewrites them to `equals` and `contains`.

`${env:API_TOKEN}` in `speq.yaml` is expanded when the config is read, and an
unset variable with no `${env:NAME:-fallback}` is an error rather than an empty
string. A token that silently becomes `Bearer ` produces a suite that fails for
the wrong reason, or worse, passes against nothing.

Inside a *test*, `${env:NAME}` is answered by
[`@speqkit/plugin-data`](../plugin-data). It used to live here, for no better
reason than HTTP being the first plugin that wanted a token out of CI; reading
the environment has nothing to do with the protocol under test. Load `data`
alongside `http` — the presets do.

The step returns `{ status, ok, headers, body, text, url, attempts, durationMs }`,
all of it addressable from later steps as `${id.field}` once the step has an
`id`.

## What a failed request leaves behind

A step that did not pass records the exchange — the request beside the response
— and the kernel puts it on `step.finished`, into `events.jsonl` and into
`speq run --json`. `speq run --verbose` prints it. A step that passed records
nothing, so a green run's log is the size it always was.

The request is worth having because it is in nothing else: the result carries
the response, and no step returns what it sent. It is written down *before* the
socket is opened, which is what makes a connection that never answers legible
— there is no response to describe, and what the step was attempting is the
whole of what can be said.

Two things are done to it on the way out. `authorization`, `cookie`,
`x-api-key` and their neighbours keep their names and lose their values: a run
log is a CI artifact, read by people and programs that had no part in the run,
and the name is what tells a missing token from a rejected one. And a body over
8 KB is cut, with the number of characters dropped said out loud, so nobody
debugs against a payload they think is complete.

## Sending a file

```yaml
steps:
  - type: http
    method: POST
    url: /restaurants/${restaurant.id}/uploads
    multipart:
      kind: variant_image                 # a plain field
      file:
        file: fixtures/tiny.png           # from disk, relative to the project root
        filename: logo.png                # optional, defaults to the basename
        contentType: image/png            # optional, taken from the extension
```

A part is a plain field when it is written as a scalar and a file when it is
written as a block. `content:` takes the place of `file:` for a body the run
produced rather than one on disk. `body` and `multipart` exclude each other,
and `speq validate` says so — a request has one body; multipart is how it is
encoded.

The content type is deliberately not yours to set. `fetch` writes it, and it
has to: the boundary is generated with the body, so a hand-written
`Content-Type: multipart/form-data` names a boundary that is not in the
request. Servers report that as a malformed body, several layers away from the
line that caused it. A `Content-Type` header on a multipart step is dropped.

**Why this is worth a section.** The suite this plugin was written against
carries a note saying its upload endpoints have no test for a successful
upload, and that `multipart`, `formData`, `form`, `files`, `bodyFile` and
`bodyRaw` were all *silently ignored* by the tool it used: the request went out
with an empty body and no content type, and the test reported **passed**. Three
paths went untested for months behind a green tick, and the note ends "watch
for this generally: unknown step keys do not fail validation."

Here they do. Every step type closes its schema, so an unknown key is a
diagnostic before a single request goes out; a `multipart` part naming a file
that is not on disk is found the same way, in milliseconds, with the path
inside the step.

## Retrying

Off by default. A project that wants it says so:

```yaml
# speq.yaml
http:
  retry:
    attempts: 3           # including the first
    delayMs: 300
    backoff: exponential  # or fixed
    network: true         # the request never got an answer at all
    status: [502, 503, 504]
    methods: [GET, HEAD, OPTIONS, PUT, DELETE]
```

A step overrides any of it with a `retry:` block of its own.

Two defaults are decisions rather than conveniences.

**429 is not in the list.** A rate limiter is behaviour a suite tests, and a
policy that quietly repeats through a 429 makes the test that proves the
limiter works pass whether the limiter exists or not — which is worse than not
having the test. Adding it is possible and should be a decision somebody makes
in writing.

**Only idempotent methods repeat.** A 502 means a gateway answered; it does not
mean the origin never saw the request. Repeating a POST that timed out on the
way back creates the row twice, and the suite then fails on a duplicate key
somewhere else entirely. Name the method under `methods` where an endpoint is
known to be safe to repeat.

Waiting happens under the step's own timeout, so five attempts against a
service that is never coming back is still a step that times out rather than a
run that stops reporting. The result carries `attempts`, so a suite can assert
that a request went out once.

## Nothing about it is privileged

The kernel contains no mention of HTTP. This plugin registers a step type and
two assertions through the same public API a plugin you write would use, and
if it ever needed a kernel change, that would mean the spine is wrong — not
that HTTP is special.

`fetch` is Node's own, and the step honours `exec.signal`, so a timeout budget
aborts the request in flight rather than waiting for it to come back.

MIT.
