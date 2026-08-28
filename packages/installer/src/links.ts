import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export const LINKS_NAME = 'links.yaml'

/**
 * `speq link` is the single difference between developing a plugin and using
 * one. It is deliberately machine-local and not part of speq.yaml: a link
 * points at a directory that exists on one laptop, and committing it would
 * break the build for everyone else.
 */
export function readLinks(root: string): Record<string, string> {
  const file = join(root, LINKS_NAME)
  if (!existsSync(file)) return {}
  const parsed = parseYaml(readFileSync(file, 'utf8')) as Record<string, string> | null
  return parsed ?? {}
}

export function writeLinks(root: string, links: Record<string, string>): void {
  const file = join(root, LINKS_NAME)
  if (Object.keys(links).length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeFileSync(
    file,
    `# Local plugins, linked for development. Machine-specific — do not commit.\n\n` +
      stringifyYaml(links, { lineWidth: 0 })
  )
}

export function addLink(root: string, path: string): { name: string; path: string } {
  const target = isAbsolute(path) ? path : resolve(process.cwd(), path)
  const manifest = join(target, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`${target} has no package.json, so it is not a plugin`)
  }
  const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
  if (!name) throw new Error(`${manifest} declares no name`)

  const links = readLinks(root)
  links[name] = target
  writeLinks(root, links)
  return { name, path: target }
}

export function removeLink(root: string, name: string): boolean {
  const links = readLinks(root)
  if (!(name in links)) return false
  delete links[name]
  writeLinks(root, links)
  return true
}
