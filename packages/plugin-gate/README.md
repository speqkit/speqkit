# @speqkit/plugin-gate

Which tests answer for the work in hand, and whose fault it is when they are
red.

```yaml
# speq.yaml
plugins:
  - gate

gate:
  pattern: "^[A-Z][A-Z0-9]*-[0-9]+$"   # what a work tag looks like. This is the default
  key: PAY-114                          # pins the work, where the branch does not name it
  branch: true                          # read the key out of the branch name. On by default
  base: origin/main                     # what `gate diff` compares against
```

```bash
speq gate plan      # what would run, and why
speq gate           # run it, and exit on the verdict
speq gate diff      # what this branch did to the acceptance tests
```

It defines no step type and no assertion. What a test *does* belongs to `http`,
`playwright` or whatever somebody publishes next; what this adds is the layer
above a run — "is this ticket done" rather than "did the suite pass", and
"where does this failure go" rather than "which line was red".

**It reads no specification, in any format.** Not a Jira ticket, not a Spec-Kit
or OpenSpec repository, not a page in a wiki. A requirement and a test are
joined by a tag somebody wrote, and that is the only join there is: what to
cover is your decision, and a plugin that read a tracker would be wrong about
it monthly.

## Where the key comes from

`--key`, then `gate.key`, then the branch — the outer one is always the one
somebody typed on purpose. The branch is last and answers nearly every time,
because it is already named after the work:

```bash
git checkout -b feature/PAY-114-partial-refunds
speq gate plan
# key: PAY-114 (from the branch 'feature/PAY-114-partial-refunds')
```

The pattern is anchored, because it is matched against one tag at a time and a
tag that merely *contains* a key is a different label. Against a branch the
anchors come off, since `PAY-114`, `feature/PAY-114` and
`pay/PAY-114-refunds` all name the same work.

On a detached HEAD there is no branch to read — which is how several CI systems
check out a pull request — and `gate` says so rather than guessing. Pass
`--key`, or turn the branch off entirely with `branch: false`.

## `speq gate plan`

The selection and the reason for it, without running anything.

```
key: PAY-114 (from the branch 'feature/PAY-114-partial-refunds')
3 of 47 test(s) selected
  payments.refund.partial   suites/payments/refund-partial.yaml
  payments.refund.whole     suites/payments/refund-whole.yaml
  payments.refund.twice     suites/payments/refund-twice.yaml
41 test(s) carry another key
3 test(s) no gate would run:
  orders.list               suites/orders/list.yaml
  ...
```

Turning `--tags PAY-114` into a selection is a line of shell and does not earn
a plugin. The half that does is *and why*: which key was taken, where it came
from, how many tests it found — and which tests in the project it did not.
**A selection nobody can inspect is how a gate comes to run nothing and pass.**

The last block is the tests carrying no work tag at all. That is news rather
than an error — most projects have some, and a regression suite written the
ordinary way has nothing but — so it is reported by name and changes no exit
code. `--strict` makes it exit `2`, for a team that has decided every test
answers for something.

## `speq gate`

Discovers this work's tests, validates them, runs them, and exits `0` or `1`.
`--reporter` chooses what runs beside the gate reporter, `--workers N` is
passed through, `--json` puts the document on stdout instead of the console
output.

A key that selects nothing exits `2` and says so, rather than passing an empty
run. That failure mode is the reason `plan` exists.

## What it writes

`reports/<runId>/gate.json`, built out of the event stream and nothing else —
so `speq report --reporter gate` renders a recorded run into the same document,
and `--workers 4` produces what `--workers 1` produces.

```json
{
  "runId": "0f1c…",
  "status": "failed",
  "key": "PAY-114",
  "counts": { "passed": 2, "failed": 1, "errored": 0, "skipped": 0 },
  "work": [
    { "key": "PAY-114", "passed": 2, "failed": 1, "errored": 0, "skipped": 0, "status": "failed" }
  ],
  "unclaimed": [],
  "blame": { "code": 1, "test": 0, "environment": 0 },
  "tests": [
    {
      "name": "payments.refund.partial",
      "source": "suites/payments/refund-partial.yaml",
      "tags": ["PAY-114"],
      "status": "failed",
      "fix": "code",
      "why": "the system answered and the answer was wrong",
      "failures": [
        {
          "kind": "assertion",
          "step": "refund",
          "type": "equals",
          "message": "expected 600, got 1000",
          "expected": 600,
          "actual": 1000
        },
        {
          "kind": "step",
          "step": "refund",
          "type": "http",
          "status": "failed",
          "message": "expected 600, got 1000",
          "detail": {
            "request": { "method": "POST", "url": "…/refunds", "headers": { "authorization": "(redacted)" } },
            "response": { "status": 200, "body": "…", "attempts": 1 }
          }
        }
      ]
    }
  ]
}
```

Only the tests that did not pass are in `tests`; a green run's document is the
counts and nothing else. `detail` is there when the step recorded one — for
`plugin-http` that is the request beside the response, which is in no other
place at all, since no step returns what it sent.

## Whose fault it is

Every red test is routed to one of three places, and the routing is the reason
this document exists rather than a `jq` expression over `run --json`.

| `fix` | What it means | What to do |
| --- | --- | --- |
| `code` | The system answered and the answer was wrong | Fix the implementation |
| `environment` | The same step broke the same way in more than one test | Fix what is under the run — nothing was listening, the fixture data is gone |
| `test` | The question was never asked, and nothing else hit the same wall | Fix the test |

**Half of that is not a guess.** `failed` and `error` have meant "the answer was
wrong" and "the question was never asked" since the kernel's first commit;
nothing had ever told a caller that this is the line between fixing the code
and fixing the test.

The other half — telling the environment from the test — is a heuristic, and it
is written here so nobody has to read the source to find out what it does:

> Two tests that broke identically did not both break for their own reasons. A
> cause shared by more than one test is by definition not inside either of
> them.

It never reads the message. It does not know what `ECONNREFUSED` means; it asks
only whether the same step type broke with the same words somewhere else in the
same run. **What it gets wrong, said plainly:** a run of one test cannot have a
shared anything, so a lone test brought down by a service that was never up is
reported as `test` — the run holds no evidence to say otherwise. And two tests
carrying the same bug are reported as `environment`. Both are the price of not
parsing messages, which is the approach that would rot the first time somebody
reworded one.

## `speq gate diff`

What this branch did to the acceptance tests, against `--base` (default
`origin/main`).

```
3 test file(s) changed against origin/main
  added   suites/payments/refund-partial.yaml
          payments.refund.partial
  changed suites/payments/refund-whole.yaml
          payments.refund.whole
  removed suites/payments/refund-legacy.yaml
```

**Not a lock, and not a refusal.** Somebody who believes an acceptance test is
wrong is sometimes right, and a gate that forbids the amendment moves the
argument into a chat window where no reviewer will ever find it. Tests here are
data, so the amendment is already in the diff — what is missing is that nobody
reads a YAML diff as a change to the acceptance criteria. Naming them makes it
loud without making it forbidden.

Files that still exist are named by the tests inside them, because a reviewer
reads names rather than paths. `A...B` is used deliberately: the comparison is
against where this branch left the base, so somebody else's merge does not
appear in your diff.

## What it needs

`gate plan`, `gate` and `gate diff` are commands, so `@speqkit/plugin-cli` (or
another surface publishing the `cli` service) has to be loaded — without one
the reporter still works and the commands simply are not there, which is what
`ctx.inject` is for.

`git` is used for the branch name and for `diff`, and is never required: a
machine without it, or a directory that is no repository, gets a command that
says so rather than a stack trace out of a child process.
