# @speq/plugin-playwright

Browser steps, scoped `browser` / `context` / `page` resources, and screenshots
attached as artifacts.

```yaml
# .speq/speq.yaml
plugins: [yaml, http, cli, playwright]

playwright:
  browser: chromium      # chromium | firefox | webkit
  headless: true
  baseUrl: https://example.com
  viewport: { width: 1280, height: 720 }
```

```yaml
name: the browser reaches the page

steps:
  - id: home
    type: browser.open
    url: /

  - id: shot
    type: browser.screenshot
    name: home.png
    fullPage: true

assert:
  - type: title_is
    expected: Example Domain
  - type: visible
    selector: h1
```

Playwright itself is an **optional peer dependency**, imported the moment a
browser is first needed. A repository that only runs HTTP smoke checks never
downloads a browser because this package exists.

```bash
pnpm add -D playwright && pnpm exec playwright install chromium
```

## Steps and assertions

| Step | Input | Result |
| --- | --- | --- |
| `browser.open` | `url`, `waitUntil?` | `url`, `title`, `status` |
| `browser.click` | `selector`, `timeout?` | `selector`, `url` |
| `browser.fill` | `selector`, `value` | `selector`, `value` |
| `browser.press` | `selector`, `key` | `selector`, `key` |
| `browser.wait_for` | `selector`, `state?` | `selector` |
| `browser.text` | `selector` | `text` — readable later as `${id.text}` |
| `browser.screenshot` | `name?`, `fullPage?` | attaches a PNG |

Assertions: `visible`, `text_contains`, `title_is`, `url_contains`.

## Resources

| Name | Scope | Lifetime |
| --- | --- | --- |
| `browser` | `run` | one process for the entire run |
| `browser.context` | `test` | fresh cookies and storage per test |
| `page` | `test` | closed when the test ends, pass or fail |

Nothing here manages that lifetime. The plugin *declares* it and the kernel
acquires lazily, caches per scope and tears down in reverse order — which is
also why a suite that crashes does not leave browsers running.

## Why this plugin exists

It is the second half of the architecture gate. `@speq/plugin-loop` proved
control flow can live outside the kernel; this one exercises the two parts of
the spine the loop never touched.

**Scoped resources — passed, no kernel change.** Three scopes, a resource
depending on a resource, config reaching `setup`, reverse teardown, and an
assertion reaching for `page` without a step in front of it. All of it was
already expressible through the published API.

**Binary artifacts — the kernel had to keep a promise it had already made.**
`ExecContext.attach` was on the contract from day one, but the body went
nowhere: the event carried a byte count and the bytes were dropped. There was
nothing to fix in the plugin. What changed is that `path` was added to the
`artifact.attached` event and the kernel now writes the file — an added field,
a minor, and `attach(name, body, contentType)` is byte-for-byte the same call.

**Suite scope was declared and never opened.** `ResourceScope` published three
scopes and the runner opened two, so a `suite` resource failed with "scope is
not open here". Fixed in the runner; no API change.

## What this plugin still cannot do

**Screenshot on failure.** The obvious feature, and it is not implementable
from here. A `test:after` hook receives a `HookPayload` with no status on it
and no way to attach anything, so the plugin cannot see that a test failed or
hand back the picture proving it. That is a genuine gap in the spine, and the
fix is a design decision rather than a workaround: either `HookPayload` carries
the outcome and an attach, or failure capture becomes a step-level concern with
a `try/catch` step type. It is recorded here instead of being smuggled in.
