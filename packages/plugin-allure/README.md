# @speqkit/plugin-allure

An Allure results directory, folded out of the run's event stream.

```yaml
# speq.yaml
plugins:
  - allure

allure:
  output: allure-results        # relative to reports/, or an absolute path
```

```bash
speq run --reporter console,allure
allure serve .speq/reports/allure-results
```

Reporters are opt-in per run. `--reporter` names them; the default is
`console` alone, so adding this plugin costs a registration and nothing else
until a run asks for it.

## What it writes, and what it does not

It writes **results**, not a report: `<uuid>-result.json` per test,
`<uuid>-container.json` for setup and cleanup, the attachments beside them,
and `environment.properties` / `executor.json` / `categories.json` when you
have configured them. `allure serve` and `allure generate` turn that into the
HTML — they are the tools your CI already runs, at the version your team
already pinned.

Rendering the HTML here would mean vendoring somebody else's renderer inside a
plugin, frozen at whatever version we happened to bundle, and it still would
not be the one on your build agent. If what you want is a report that opens
with a double click and needs no second tool, that is
[`@speqkit/plugin-html`](../plugin-html#readme), which is ours.

## Where it writes, and why there

`reports/allure-results` — the stable directory, not `reports/<runId>/`.

A workflow names one fixed path and cannot interpolate a run id it will not
learn until the step has already finished:

```yaml
- run: speq run --env ci --reporter console,allure
- run: allure generate .speq/reports/allure-results -o allure-report --clean
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: allure-report
    path: allure-report
```

It also matters more here than it does for a file: `allure serve` takes a
directory as an argument, and a person typing that wants to type the same one
every time.

`clean` is on by default, because Allure reads a whole directory as one run
and a stale result from yesterday would appear in today's report as a test
that passed. The sweep is **by pattern** — `*-result.json`,
`*-container.json`, `*-attachment.*`, and the three named files. The output
directory is a path out of your config file, and `rm -rf` on one of those is
not something this plugin will do; a stray file in there survives, which is
the correct failure mode.

## How a run maps onto Allure's model

| speq | Allure | Why |
| --- | --- | --- |
| `passed` | `passed` | |
| `failed` | `failed` | The system under test answered, and the answer was wrong. |
| `error` | `broken` | It never answered at all. |
| `skipped` | `skipped` | The reason the test gives becomes the status message. |
| a step | a step, nested by `parentId` | A `loop` shows its iterations underneath it. |
| an assertion | a step under the step it names | It is the leaf somebody opens a failing test to read. |
| a suite's own setup | `befores` on the suite container | JUnit has nowhere to put this and drops it. |
| a tag | a `tag` label | The same set `--tags` selects on. |
| a `cases` row | a `subSuite` label plus parameters | What tells two rows of one table apart. |
| an artifact | an attachment, copied in | Named by extension, because that is what picks the viewer. |

`meta` is read twice over. `owner`, `severity`, `feature`, `story`, `epic`,
`package` and `layer` become the labels Allure groups and filters on;
`issue`, `tms` and `links` become links a reader can click; **everything else
becomes a parameter**, so a key this plugin was never taught about is still in
the report rather than silently dropped. Add your own promotions with
`allure.labels`:

```yaml
allure:
  labels:
    squad: parentSuite     # meta key -> Allure label
```

## Rebuilding a report you did not run

```bash
speq report --run 0f1c --reporter allure
```

Like every reporter here, it reads the event stream and nothing else — so a
`reports/` directory downloaded out of CI re-renders locally without rerunning
a thing.

One honest limit, and it is about time. Allure's timeline wants absolute
instants; the stream carries exactly one, `run.started.at`, and everything
else is a duration. So the fold anchors on that instant and adds its own
elapsed time as each event arrives. On a live run that is the truth. On a
replay the events arrive all at once, so **durations and order are exact and
the stagger is lost** — every test starts at the instant the original run did.
The alternative was stamping the replay's own wall clock, which would produce
a report claiming a run happened this afternoon when it happened in CI last
week.

An attachment can only be carried across if the run wrote it: the event says
how many bytes there were and never what they are. A run with no report
directory, or one whose `reports/` was cleaned in between, has nothing to
copy, and the reporter says how many it could not find rather than writing a
link to nothing.

## The Environment panel

The two things that tell two red runs apart:

```yaml
allure:
  environment:
    base url: ${env:BASE_URL}
    branch: ${env:GITHUB_REF_NAME}
  executor:
    name: GitHub Actions
    type: github
    buildUrl: ${env:GITHUB_SERVER_URL}/${env:GITHUB_REPOSITORY}/actions/runs/${env:GITHUB_RUN_ID}
```

The run id and the `--env` layer are written in already. Values are escaped the
way `java.util.Properties` reads them back, which matters the moment a base URL
has a port in it.

## Categories

Allure's own rules for bucketing failures, so a known flake is not read as a
new break:

```yaml
allure:
  categories:
    - name: Environment down
      matchedStatuses: [broken]
      messageRegex: '.*ECONNREFUSED.*'
```

## History

`historyId` is derived from the suite and the test name, and from nothing
else — not the run id, not the order, not a duration. Copy the previous
report's `history/` directory into the results directory before generating,
the way every Allure adapter asks you to, and the trend is there.
