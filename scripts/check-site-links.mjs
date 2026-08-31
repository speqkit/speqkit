#!/usr/bin/env node
/**
 * Every internal link and asset on the site resolves to a file.
 *
 *   node scripts/check-site-links.mjs [site-dir]
 *
 * A 404 on a documentation site is the cheapest bug there is to prevent and
 * the most expensive to find out about from a stranger, who does not file a
 * report — they close the tab. External links are left alone: this runs on
 * every push and a check that depends on somebody else's uptime is a check
 * that goes red for reasons nobody here can fix.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const site = resolve(process.argv[2] ?? 'site')
if (!existsSync(site)) {
  console.error(`no such directory: ${site}`)
  process.exit(2)
}

function htmlFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full))
    else if (entry.endsWith('.html')) out.push(full)
  }
  return out
}

const pages = htmlFiles(site)
let broken = 0
let checked = 0

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const here = dirname(page)
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])

  for (const ref of refs) {
    if (/^(https?:|mailto:|data:|#)/.test(ref)) continue
    checked++

    const [path, hash] = ref.split('#')
    // A bare fragment is same-page; an empty path with a hash was skipped above.
    const target = path === '' ? page : resolve(here, path)
    // A directory link means its index.
    const file = existsSync(target) && statSync(target).isDirectory() ? join(target, 'index.html') : target

    if (!existsSync(file)) {
      console.error(`  ${relative(site, page)}  ->  ${ref}   (no ${relative(site, file)})`)
      broken++
      continue
    }

    // An anchor that names nothing is a link that silently lands at the top
    // of the page, which reads as the site being wrong about its own contents.
    if (hash) {
      const targetHtml = file === page ? html : readFileSync(file, 'utf8')
      if (!new RegExp(`id="${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(targetHtml)) {
        console.error(`  ${relative(site, page)}  ->  ${ref}   (no element with that id)`)
        broken++
      }
    }
  }
}

console.log(`\n${pages.length} page(s), ${checked} internal reference(s) checked`)
if (broken > 0) {
  console.error(`\n${broken} broken reference(s).\n`)
  process.exit(1)
}
console.log('all of them resolve.\n')
