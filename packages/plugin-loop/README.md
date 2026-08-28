# @speqkit/plugin-loop

`loop` and `retry`. Control flow, contributed rather than built in.

```yaml
# speq.yaml
plugins:
  - loop
```

```yaml
steps:
  - id: seed
    type: loop
    over: ["ada", "grace", "katherine"]
    as: user
    steps:
      - type: http
        method: POST
        url: /users
        body: { name: "${user}" }

  - id: settle
    type: retry
    attempts: 5
    delayMs: 300
    steps:
      - id: status
        type: http
        url: /jobs/${seed.iterations}
```

## `loop`

`over` (a list) or `times` (a count) — one or the other. Each iteration runs
the nested steps in a **child variable scope** holding `${item}` and
`${itemIndex}`, renamed by `as`. A failing iteration stops the loop.

Returns `{ iterations, completed, results }`, where `results` is the step
records of every iteration.

## `retry`

`attempts` (default 3) and `delayMs` (default 250). Nested steps run until
none of them fails; `${attempt}` is visible inside. If every attempt fails the
step throws with the last real message, rather than reporting a bare count.

The delay honours `exec.signal`, so a test that times out mid-backoff aborts
instead of sleeping to the end.

## Why this package exists

It was the first half of the architecture gate: the test of whether a plugin
author is boxed in.

A loop is not a protocol client. It wraps *other* steps, which is the one thing
a naive "step type" contract cannot express — and if the kernel had needed a
change to allow it, then `if`, `parallel` and `try/catch` would all have been
kernel features too, and "everything is a plugin" would have been a slogan.

It works because the executor is re-entrant and handed to plugins as
`ctx.runSteps(steps, { vars, label })`. Both step types here are that call plus
a policy. The kernel was not modified once.

MIT.
