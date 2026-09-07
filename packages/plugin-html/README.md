# @speqkit/plugin-html

One HTML file. Double-click it.

```yaml
# speq.yaml
plugins:
  - html

html:
  output: report.html      # relative to reports/, or an absolute path
  title: payments nightly
```

```bash
speq run --reporter console,html
open .speq/reports/report.html
```

Reporters are opt-in per run. `--reporter` names them; the default is
`console` alone, so adding this plugin costs a registration and nothing else
until a run asks for it.

## Why this exists next to `plugin-allure`

Allure's report is a directory of JSON that its page fetches at load. A
browser opening `file://` refuses those fetches, so reading one needs
`allure serve` — a second tool, on the reader's machine, with a JVM behind it.
That cost lands on the person least equipped to pay it: the developer who has
downloaded a CI artifact to find out why their branch is red and does not want
to install anything to read it.

This writes **one file with nothing outside it**. No fetch, no CDN, no
framework, no second command. It mails. It attaches to a pull request. It
opens on a laptop with no network, which is roughly when anybody reads one.

Both plugins exist because both answers are right for somebody:
`plugin-allure` is what you want when your team already has dashboards, a
history and a sign-off process pointed at Allure. This is what you want when
what you need is for somebody to look at a failure.

## What is on the page

- Totals, and clicking one filters the list to that status.
- Search over names, steps, tags and messages, and a chip per tag.
- Suites, in the order the run took them up; **failing tests are already
  open**, because a report is read for its failures and one that makes you
  click thirty times to find them is worse than a wall of text.
- The step tree, nested the way the run nested it — a `loop` shows its
  iterations underneath itself.
- `what it did` under any step that recorded a `detail`: the request and the
  response, not a sentence about them.
- Expected against actual, side by side, on every failing assertion — and only
  on failing ones, which is the same rule the event stream itself follows.
- Screenshots, inline.
- **Which plugin contributed each step type and each assertion**, as a badge,
  with the plugin's own one-line summary in the tooltip. This is the one thing
  on the page that is not folded out of the event stream: the stream says a
  step's type and can never say whose type it is, so it comes from
  `host.capabilities()` — which means the answer in a project with one more
  plugin installed has one more entry in it.
- Light and dark, following the reader's system setting, with a toggle.

## Artifacts, and the size of the file

A screenshot is half a megabyte and a run has thirty of them, so the rule is a
budget rather than an absolute:

```yaml
html:
  inlineLimit: 524288      # per artifact — 512 KB by default
  inlineBudget: 8388608    # in total — 8 MB by default
```

Under the limit and inside the budget, an artifact rides inside the page as a
`data:` URI and the file stays one file. Over it, the artifact stays a link
into `reports/<runId>/artifacts/`, written **relative to the HTML file** — an
absolute path is correct on the machine that produced the report and wrong on
every machine that downloads it, which is all of them. Set `inlineBudget: 0`
to keep every artifact out, and the reporter says on stdout what it did:

```
html: /repo/.speq/reports/report.html
      3 artifact(s) inside the page, 1 left as link(s) into reports/
```

## Where it writes, and why there

`reports/report.html` — the stable directory, not `reports/<runId>/`.

A workflow names one fixed path and cannot interpolate a run id it will not
learn until the step has already finished:

```yaml
- run: speq run --env ci --reporter console,html
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: speq-report
    path: .speq/reports/
```

Uploading the whole `reports/` directory rather than the single file is what
keeps the links to the large artifacts working; uploading only `report.html`
is fine when everything fit inside it.

## Rebuilding a page for a run you did not watch

```bash
speq report --run 0f1c --reporter html
```

Like every reporter here it is a function of the event stream, so a `reports/`
directory downloaded out of CI re-renders locally, offline, with the artifacts
that came down with it.

## About the markup

The page is built with `document.createElement` and `textContent`, never with
string concatenation, and the run's data is carried in an inert
`<script type="application/json">` island with `<`, `>` and `&` escaped. A
report is a page full of strings the system under test chose — a response
body, a header, an assertion message — and a report that executes whatever a
service put in an error message is a vulnerability with a nice colour scheme.
`packages/plugin-html/test/report.test.ts` feeds it a payload that tries.
