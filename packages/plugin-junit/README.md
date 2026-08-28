# @speqkit/plugin-junit

JUnit XML, folded out of the run's event stream.

```yaml
# speq.yaml
plugins:
  - junit

junit:
  output: junit.xml     # relative to reports/, or an absolute path
  suiteName: payments   # the name attribute on <testsuites>
```

```bash
speq run --reporter console,junit
```

Reporters are opt-in per run. `--reporter` names them; the default is
`console` alone, so adding this plugin costs a registration and nothing else
until a run asks for it.

## Where it writes, and why there

`reports/junit.xml` — the stable directory, not `reports/<runId>/`.

A CI workflow names one fixed path and cannot interpolate a run id it will not
learn until the step has already finished:

```yaml
- run: speq install --frozen
- run: speq run --env ci --reporter console,junit
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: speq-report
    path: .speq/reports/
```

The per-run directory is right for artifacts, which are addressed from inside
the report. It is wrong for the report itself.

## `failure` and `error` are not the same thing

JUnit distinguishes them and so does the spine. `failed` is the system under
test saying no; `error` is the test never getting an answer at all. Collapsing
both into failures is what makes a flaky environment look like a broken build,
so a step that threw lands in `<error>` and an assertion that returned false
lands in `<failure>`.

Attachments are listed as `[[ATTACHMENT|path]]` in `<system-out>`, the
convention several CI viewers already understand.

## Nothing here reads the runner

Every number in the file is built from `RunEvent`s alone — no access to the
runner's result object, no hooks, no privileged channel. That is deliberate,
and `packages/core/test/reporting.test.ts` pins it: replaying a recorded run
through `speq report` has to produce a byte-identical file to the live run.

If that test ever fails, the event stream has stopped being sufficient to
describe a run, and every consumer resting on it — this plugin, a TUI, the VS
Code panel — inherits the gap. The fix would belong in the event contract, not
here.

## Control characters

Assertion messages routinely carry terminal colour codes; the console reporter
emits them by design. XML 1.0 cannot represent them at all, and one is enough
to make the file unparseable by the CI that has to read it — which shows up as
a broken build rather than a broken report. They are stripped on the way out.
