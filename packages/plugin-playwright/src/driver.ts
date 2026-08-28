/**
 * Playwright's surface, described structurally rather than imported.
 *
 * The plugin must type-check and install in a repository that has no browsers
 * anywhere near it — a Go service that only runs HTTP smoke checks should not
 * pull down 300MB because this package exists in the registry. So `playwright`
 * is an optional peer dependency, loaded at the moment a browser is first
 * needed, and the types below are the only coupling at build time.
 */

export type BrowserName = 'chromium' | 'firefox' | 'webkit'

export interface Page {
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>
  title(): Promise<string>
  url(): string
  click(selector: string, options?: Record<string, unknown>): Promise<void>
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>
  press(selector: string, key: string, options?: Record<string, unknown>): Promise<void>
  textContent(selector: string, options?: Record<string, unknown>): Promise<string | null>
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>
  isVisible(selector: string, options?: Record<string, unknown>): Promise<boolean>
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>
  close(): Promise<void>
}

export interface BrowserContext {
  newPage(): Promise<Page>
  close(): Promise<void>
}

export interface Browser {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>
  close(): Promise<void>
}

export interface BrowserType {
  launch(options?: Record<string, unknown>): Promise<Browser>
}

const INSTALL_HINT =
  "@speq/plugin-playwright needs the 'playwright' package, which it does not bundle.\n" +
  '  pnpm add -D playwright && pnpm exec playwright install chromium'

export async function loadBrowserType(name: BrowserName): Promise<BrowserType> {
  // An indirect specifier on purpose: the module is resolved at run time by
  // the host project, not at build time by this package.
  const specifier = 'playwright'
  let mod: Record<string, unknown>
  try {
    mod = (await import(specifier)) as Record<string, unknown>
  } catch (err) {
    throw new Error(`${INSTALL_HINT}\n  (import failed: ${err instanceof Error ? err.message : String(err)})`)
  }

  const type = mod[name] as BrowserType | undefined
  if (!type?.launch) {
    throw new Error(`playwright exposes no browser named '${name}'; expected chromium, firefox or webkit`)
  }
  return type
}
