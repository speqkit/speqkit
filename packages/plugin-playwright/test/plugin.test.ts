import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { harness, type Harness } from '@speqkit/test-kit'
import playwright from '@speqkit/plugin-playwright'

/**
 * Driven against a real browser on a real page.
 *
 * This plugin is one half of the architecture gate — it is the proof that a
 * scoped resource and a binary artifact work from outside the kernel — and it
 * had no tests, which made the proof an assertion. What is pinned here is
 * exactly the part a screenshot of a passing run does not show: that one
 * browser process serves the whole run while a page dies with its test, and
 * that bytes handed to `attach` come out the other side.
 *
 * The browser is optional everywhere else in this repository, so these skip
 * when it is absent. `SPEQ_REQUIRE_BROWSER=1` turns that skip into a failure,
 * and CI sets it in the one job that installs chromium — otherwise "green"
 * and "did not run" look the same from the outside.
 */

const required = process.env.SPEQ_REQUIRE_BROWSER === '1'
const installed = await browserIsInstalled()
if (required && !installed) throw new Error('SPEQ_REQUIRE_BROWSER=1 but no chromium is installed')

async function browserIsInstalled(): Promise<boolean> {
  try {
    const { chromium } = (await import('playwright')) as { chromium: { executablePath(): string } }
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const PAGE = `<!doctype html>
<html><head><title>The shop</title></head>
<body>
  <h1>Orders</h1>
  <input id="sku" />
  <button id="add" onclick="document.querySelector('h1').textContent = 'Added ' + document.querySelector('#sku').value">Add</button>
  <p id="ghost" style="display:none">not for you</p>
</body></html>`

let server: Server
let base: string
let kit: Harness

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

afterEach(async () => {
  await kit?.close()
})

async function withBrowser(): Promise<Harness> {
  kit = await harness(playwright, {
    config: { playwright: { browser: 'chromium', headless: true, baseUrl: base } }
  })
  return kit
}

describe.skipIf(!installed)('a browser', () => {
  it('opens a page and reads it into the variable namespace', async () => {
    const kit = await withBrowser()

    const open = await kit.step({ id: 'home', type: 'browser.open', url: '/' })
    expect(open.result).toMatchObject({ title: 'The shop', status: 200 })

    const heading = await kit.step({ id: 'heading', type: 'browser.text', selector: 'h1' })
    expect(heading.result.text).toBe('Orders')

    // The point of binding a step result: a later step says ${heading.text}
    // exactly as it would say ${login.body.token}. Nothing about the browser
    // is special in the scope chain.
    const typed = await kit.step({ type: 'browser.fill', selector: '#sku', value: '${heading.text}-1' })
    expect(typed.result.value).toBe('Orders-1')
  })

  it('lets an assertion look at the page with no step in front of it', async () => {
    const kit = await withBrowser()
    await kit.step({ type: 'browser.open', url: '/' })

    expect(await kit.assert({ type: 'title_is', expected: 'The shop' })).toMatchObject({ passed: true })
    expect(await kit.assert({ type: 'visible', selector: 'h1' })).toMatchObject({ passed: true })

    const hidden = await kit.assert({ type: 'visible', selector: '#ghost' })
    expect(hidden.passed).toBe(false)
    expect(hidden.message).toBe('#ghost is not visible')
  })

  it('says what it expected and what it got, so a report can show a diff', async () => {
    const kit = await withBrowser()
    await kit.step({ type: 'browser.open', url: '/' })

    expect(await kit.assert({ type: 'title_is', expected: 'The warehouse' }))
      .toMatchObject({ passed: false, expected: 'The warehouse', actual: 'The shop' })
  })

  it('hands a screenshot to the kernel and keeps no idea where it went', async () => {
    const kit = await withBrowser()
    await kit.step({ type: 'browser.open', url: '/' })

    const shot = await kit.step({ type: 'browser.screenshot', name: 'home', fullPage: true })

    // The name is normalised because a reporter writes it as a file.
    expect(shot.artifacts[0]).toMatchObject({ name: 'home.png', contentType: 'image/png' })
    expect((shot.artifacts[0]!.body as Uint8Array).byteLength).toBeGreaterThan(0)
    // A PNG, not an empty buffer with the right name on it.
    expect(Buffer.from(shot.artifacts[0]!.body as Uint8Array).subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('keeps one browser for the run and a fresh page per test', async () => {
    const kit = await withBrowser()

    await kit.step({ type: 'browser.open', url: '/' })
    await kit.step({ type: 'browser.fill', selector: '#sku', value: 'abc' })
    await kit.step({ type: 'browser.click', selector: '#add' })
    expect((await kit.step({ type: 'browser.text', selector: 'h1' })).result.text).toBe('Added abc')

    const browser = await kit.resource('browser')
    await kit.endTest()

    // The whole reason resource scopes exist: cookies, storage and the DOM
    // start empty for the next test, and the process that took a second to
    // launch is still the same one.
    await kit.step({ type: 'browser.open', url: '/' })
    expect((await kit.step({ type: 'browser.text', selector: 'h1' })).result.text).toBe('Orders')
    expect(await kit.resource('browser')).toBe(browser)
  })
})

describe('the grammar', () => {
  it('refuses a key it does not know, with no browser anywhere near it', async () => {
    // Validation is the half of this plugin that must work in a repository
    // with no browsers installed at all — which is the repository the README
    // promises, since `playwright` is an optional peer.
    kit = await harness(playwright)

    const diagnostics = kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'browser.open', url: '/', waitUnitl: 'load' }]
    }])

    expect(diagnostics[0]?.message).toMatch(/unknown field 'waitUnitl'/)
    expect(diagnostics[0]?.message).toContain('waitUntil')
  })

  it('asks for the selector every selector step needs', async () => {
    kit = await harness(playwright)

    const diagnostics = kit.validate([{
      name: 't',
      source: 'suites/t.yaml',
      steps: [{ type: 'browser.click' }, { type: 'browser.fill', selector: '#a' }]
    }])

    expect(diagnostics.map((d) => `${d.path} ${d.message}`)).toEqual([
      "steps[0] missing required field 'selector'",
      "steps[1] missing required field 'value'"
    ])
  })
})
