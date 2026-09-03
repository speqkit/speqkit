import { definePlugin, type AssertOutcome, type InputSchema } from '@speqkit/plugin-api'
import { loadBrowserType, type Browser, type BrowserContext, type BrowserName, type Page } from './driver.js'

interface PlaywrightConfig {
  browser?: BrowserName
  headless?: boolean
  slowMo?: number
  baseUrl?: string
  viewport?: { width: number; height: number }
  timeoutMs?: number
}

/**
 * The second half of the architecture gate.
 *
 * `@speqkit/plugin-loop` proved control flow can live outside the kernel. This
 * one exercises the two parts of the spine it never touched:
 *
 *   - scoped resources — a browser that outlives the run, a page that dies
 *     with the test, torn down in reverse order whatever happens;
 *   - binary artifacts — a PNG handed to `ctx.attach` and reachable from any
 *     reporter, including ones that do not exist yet.
 *
 * Same rule as the loop plugin: written against the published API only. What
 * it could not do without a kernel change is recorded in the README rather
 * than worked around here.
 */
export default definePlugin({
  name: '@speqkit/plugin-playwright',
  docs: {
    summary: 'drives a real browser through Playwright, in the same suite as everything else',
    readme: 'https://github.com/speqkit/speqkit/tree/main/packages/plugin-playwright#readme',
    examples: [
      {
        title: 'a page, filled in and submitted',
        summary:
          'The browser is a resource: one page per test, closed whatever happened to it. ' +
          'A selector is whatever Playwright accepts.',
        for: ['browser.open', 'browser.fill', 'browser.click', 'browser.press', 'visible'],
        code: [
          'steps:',
          '  - type: browser.open',
          '    url: ${base}/login',
          '  - type: browser.fill',
          '    selector: "#email"',
          '    value: ${buyer}',
          '  - type: browser.fill',
          '    selector: "#password"',
          '    value: ${env:TEST_PASSWORD}',
          '  - type: browser.click',
          '    selector: "button[type=submit]"',
          '    assert:',
          '      - type: visible',
          '        selector: "[data-test=dashboard]"'
        ].join('\n')
      },
      {
        title: 'waiting, reading, and checking where you ended up',
        for: ['browser.wait_for', 'browser.text', 'text_contains', 'title_is', 'url_contains'],
        code: [
          'steps:',
          '  - type: browser.wait_for',
          '    selector: "[data-test=total]"',
          '    state: visible',
          '  - id: total',
          '    type: browser.text',
          '    selector: "[data-test=total]"',
          '    assert:',
          '      - type: equals',
          '        path: text',
          '        expected: "€6.00"',
          '      - type: url_contains',
          '        expected: /checkout/confirmed'
        ].join('\n')
      },
      {
        title: 'a picture of what went wrong',
        summary: 'Attached to the run, so the report links it and CI keeps it.',
        for: ['browser.screenshot'],
        code: [
          'cleanup:',
          '  - type: browser.screenshot',
          '    name: checkout'
        ].join('\n')
      }
    ]
  },
  configSchema: {
    type: 'object',
    properties: {
      browser: { type: 'string' },
      headless: { type: 'boolean' },
      slowMo: { type: 'number' },
      baseUrl: { type: 'string' },
      viewport: { type: 'object' },
      timeoutMs: { type: 'number' }
    }
  },

  setup(ctx) {
    /* ---------------------------------------------------------------- */
    /* Resources. Three scopes, three lifetimes, declared not managed.   */
    /* ---------------------------------------------------------------- */

    // One browser process for the whole run. Launching it per test is the
    // single most common reason a UI suite takes twenty minutes.
    ctx.defineResource<Browser>('browser', {
      scope: 'run',
      async setup(res) {
        const config = res.config<PlaywrightConfig>()
        const type = await loadBrowserType(config.browser ?? 'chromium')
        return type.launch({
          headless: config.headless ?? true,
          ...(config.slowMo ? { slowMo: config.slowMo } : {})
        })
      },
      teardown: (browser) => browser.close()
    })

    // A fresh context per test is what isolation actually means here:
    // cookies, storage and permissions start empty every time, and nothing
    // a test does can leak into the next one.
    ctx.defineResource<BrowserContext>('browser.context', {
      scope: 'test',
      async setup(res) {
        const config = res.config<PlaywrightConfig>()
        const browser = await res.resource<Browser>('browser')
        return browser.newContext({
          ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
          ...(config.viewport ? { viewport: config.viewport } : {})
        })
      },
      teardown: (context) => context.close()
    })

    ctx.defineResource<Page>('page', {
      scope: 'test',
      async setup(res) {
        const context = await res.resource<BrowserContext>('browser.context')
        return context.newPage()
      },
      teardown: (page) => page.close()
    })

    /* ---------------------------------------------------------------- */
    /* Steps                                                             */
    /* ---------------------------------------------------------------- */

    const selectorSchema: InputSchema = {
      type: 'object',
      properties: { selector: { type: 'string' }, timeout: { type: 'number' } },
      required: ['selector'],
      additionalProperties: false
    }

    ctx.defineStepType('browser.open', {
      summary: 'opens a page at `url`, in the browser this project configured',
      schema: {
        type: 'object',
        properties: { url: { type: 'string' }, waitUntil: { type: 'string' } },
        required: ['url'],
        additionalProperties: false
      },
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        const response = await page.goto(String(input.url), {
          ...(input.waitUntil ? { waitUntil: input.waitUntil } : {})
        })
        return { url: page.url(), title: await page.title(), status: response?.status() ?? null }
      }
    })

    ctx.defineStepType('browser.click', {
      summary: 'clicks the element the selector names',
      schema: selectorSchema,
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        await page.click(String(input.selector), timeoutOf(exec.config<PlaywrightConfig>(), input))
        return { selector: input.selector, url: page.url() }
      }
    })

    ctx.defineStepType('browser.fill', {
      summary: 'types `value` into the field the selector names',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' }, value: {}, timeout: { type: 'number' } },
        required: ['selector', 'value'],
        additionalProperties: false
      },
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        await page.fill(String(input.selector), String(input.value), timeoutOf(exec.config<PlaywrightConfig>(), input))
        return { selector: input.selector, value: input.value }
      }
    })

    ctx.defineStepType('browser.press', {
      summary: 'presses a key, e.g. Enter or Escape',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' }, key: { type: 'string' }, timeout: { type: 'number' } },
        required: ['selector', 'key'],
        additionalProperties: false
      },
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        await page.press(String(input.selector), String(input.key), timeoutOf(exec.config<PlaywrightConfig>(), input))
        return { selector: input.selector, key: input.key }
      }
    })

    ctx.defineStepType('browser.wait_for', {
      summary: 'waits until the element the selector names reaches a state',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' }, state: { type: 'string' }, timeout: { type: 'number' } },
        required: ['selector'],
        additionalProperties: false
      },
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        await page.waitForSelector(String(input.selector), {
          ...timeoutOf(exec.config<PlaywrightConfig>(), input),
          ...(input.state ? { state: input.state } : {})
        })
        return { selector: input.selector }
      }
    })

    // Reads the page into the variable namespace, so `${title.text}` is
    // available to every later step exactly like an HTTP body would be.
    ctx.defineStepType('browser.text', {
      summary: 'reads the text of the element the selector names, for the checks below it',
      schema: selectorSchema,
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        const text = await page.textContent(String(input.selector), timeoutOf(exec.config<PlaywrightConfig>(), input))
        return { selector: input.selector, text: text ?? '' }
      }
    })

    // The artifact half of the gate: bytes go to `attach` and the kernel is
    // responsible for them from there. This plugin never learns where they
    // are written, and no reporter has to be taught about screenshots.
    ctx.defineStepType('browser.screenshot', {
      summary: 'attaches a screenshot to the run, which every report links',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, selector: { type: 'string' }, fullPage: { type: 'boolean' } },
        additionalProperties: false
      },
      async execute(exec, input) {
        const page = await exec.resource<Page>('page')
        const name = String(input.name ?? 'screenshot.png')
        const bytes = await page.screenshot({ fullPage: input.fullPage === true })
        exec.attach(name.endsWith('.png') ? name : `${name}.png`, bytes, 'image/png')
        return { name, bytes: bytes.byteLength, url: page.url() }
      }
    })

    /* ---------------------------------------------------------------- */
    /* Assertions                                                        */
    /* ---------------------------------------------------------------- */

    // An assertion may reach for a resource too, so `visible` does not need
    // a step in front of it just to have something to look at.
    ctx.defineAssertion('visible', {
      summary: 'the element the selector names is on the page and visible',
      schema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
        additionalProperties: false
      },
      async evaluate(assert, input) {
        const page = await assert.resource<Page>('page')
        const selector = String(input.selector)
        const visible = await page.isVisible(selector)
        return outcome(visible, `${selector} is not visible`, `${selector} is visible`, true, visible)
      }
    })

    ctx.defineAssertion('text_contains', {
      summary: 'the element the selector names contains this text',
      schema: {
        type: 'object',
        properties: { expected: { type: 'string' } },
        required: ['expected'],
        additionalProperties: false
      },
      evaluate(assert, input) {
        const actual = String(assert.last?.text ?? '')
        const needle = String(input.expected)
        return outcome(
          actual.includes(needle),
          `expected text to contain ${JSON.stringify(needle)}, got ${JSON.stringify(actual.slice(0, 200))}`,
          `text contains ${JSON.stringify(needle)}`,
          needle,
          actual
        )
      }
    })

    ctx.defineAssertion('title_is', {
      summary: 'the page\'s title is exactly this',
      schema: {
        type: 'object',
        properties: { expected: { type: 'string' } },
        required: ['expected'],
        additionalProperties: false
      },
      async evaluate(assert, input) {
        const page = await assert.resource<Page>('page')
        const actual = await page.title()
        return outcome(
          actual === input.expected,
          `expected title ${JSON.stringify(input.expected)}, got ${JSON.stringify(actual)}`,
          `title is ${JSON.stringify(actual)}`,
          input.expected,
          actual
        )
      }
    })

    ctx.defineAssertion('url_contains', {
      summary: 'the address the browser is on contains this',
      schema: {
        type: 'object',
        properties: { expected: { type: 'string' } },
        required: ['expected'],
        additionalProperties: false
      },
      async evaluate(assert, input) {
        const page = await assert.resource<Page>('page')
        const actual = page.url()
        const needle = String(input.expected)
        return outcome(
          actual.includes(needle),
          `expected url to contain ${JSON.stringify(needle)}, got ${JSON.stringify(actual)}`,
          `url is ${actual}`,
          needle,
          actual
        )
      }
    })
  }
})

function timeoutOf(config: PlaywrightConfig, input: Record<string, unknown>): { timeout?: number } {
  const timeout = typeof input.timeout === 'number' ? input.timeout : config.timeoutMs
  return timeout === undefined ? {} : { timeout }
}

function outcome(
  passed: boolean, whenFailed: string, whenPassed: string, expected?: unknown, actual?: unknown
): AssertOutcome {
  return { passed, message: passed ? whenPassed : whenFailed, expected, actual }
}
