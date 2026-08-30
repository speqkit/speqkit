# @speqkit/plugin-json

The run as one JSON file.

```yaml
# speq.yaml
plugins:
  - json

json:
  output: results/summary.json    # relative to reports/, the default
  compact: false                  # one line instead of indented
```

```bash
speq run --reporter console,json
```

Writes `reports/results/summary.json` — the stable directory, not
`reports/<runId>/`. A workflow names one fixed path in `upload-artifact` and
cannot interpolate a run id it will not learn until the step has finished.

## The shape

```json
{
  "status": "failed",
  "runId": "0f1c…",
  "startedAt": "2026-08-31T09:12:44.108Z",
  "durationMs": 7412,
  "totals": { "total": 60, "passed": 58, "failed": 1, "errored": 0, "skipped": 1, "pending": 1 },
  "tests": [
    {
      "id": "menu.items-create.creates-item",
      "title": "POST /categories/{id}/items creates an item",
      "status": "failed",
      "durationMs": 214,
      "message": "expected status 201, got 422",
      "messages": ["expected status 201, got 422", "body.name is not there"],
      "suite": "suites/menu/items-create/creates-item.yaml",
      "file": "suites/menu/items-create/creates-item.yaml",
      "meta": { "owner": "mira", "epic": "menu" }
    }
  ]
}
```

`message` is the first thing that went wrong, which is what a summary table
has room for; `messages` is all of it, in the order the run found out. A
pending test carries `pending` with the reason it gives.

`failed` and `errored` are counted apart, because they are different news:
`failed` is the system under test saying no, `errored` is never getting an
answer. A report that merges them tells CI a broken environment is a broken
build.

## Why the shape does not move

`totals.pending` is the same number as `totals.skipped`. That is not a synonym
anyone would design; it is there because a `jq` expression in another
repository reads `.totals.pending // 0`, and the `// 0` means dropping the key
would make that workflow report *zero* pending tests rather than fail. The
summary would be wrong and nothing would say so.

Which is the rule for this file generally: the moment somebody parses a shape,
it stops being ours to tidy. Keys get added; they do not get renamed or
removed. There is a test in `verify-publish` that reads the file back through
the four paths that workflow names, so the contract fails here rather than in
their pipeline.

## Folded from events, not from the result

Every number comes from the event stream — no reach into the runner's outcome
object. So `speq report --run <id>` regenerates a byte-identical summary from
a recorded log without re-running anything, and a report that cannot be
regenerated is a report nobody can check.

It is also the standing proof that the stream carries enough. If a reporter
cannot be written against events alone, the events are missing something, and
that is a bug in the kernel rather than a reason to hand reporters a back
door.

## Turning it into prose

What belongs in a pull-request comment differs per team, so this plugin does
not guess:

```bash
jq -r '"**\(.status)** — \(.totals.passed) passed, \(.totals.failed) failed of \(.totals.total)"' \
  reports/results/summary.json
```

MIT.
