import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, YAMLSeq, Scalar } from 'yaml'
import { candidates, parseSpec } from '@speq/installer'

/**
 * `speq add` and `speq remove` edit the user's file, so they go through the
 * YAML document model rather than parse-and-restringify: a config full of
 * comments explaining why a plugin is there must survive having a line added
 * to it. Losing those comments once is enough for people to stop using the
 * command and edit by hand.
 */
export function addPluginToConfig(root: string, spec: string): { file: string; added: boolean } {
  const file = join(root, 'speq.yaml')
  const doc = parseDocument(readFileSync(file, 'utf8'))

  let list = doc.get('plugins') as YAMLSeq | undefined
  if (!list) {
    list = new YAMLSeq()
    doc.set('plugins', list)
  }

  const wanted = names(spec)
  const already = list.items.some((item) => {
    const value = item instanceof Scalar ? item.value : item
    return typeof value === 'string' && overlaps(names(value), wanted)
  })
  if (already) return { file, added: false }

  list.add(new Scalar(spec))
  writeFileSync(file, doc.toString({ lineWidth: 0 }))
  return { file, added: true }
}

export function removePluginFromConfig(root: string, spec: string): { file: string; removed: string | undefined } {
  const file = join(root, 'speq.yaml')
  const doc = parseDocument(readFileSync(file, 'utf8'))
  const list = doc.get('plugins') as YAMLSeq | undefined
  if (!list) return { file, removed: undefined }

  const wanted = names(spec)
  const index = list.items.findIndex((item) => {
    const value = item instanceof Scalar ? item.value : item
    return typeof value === 'string' && overlaps(names(value), wanted)
  })
  if (index < 0) return { file, removed: undefined }

  const item = list.items[index]
  const removed = String(item instanceof Scalar ? item.value : item)
  list.delete(index)
  writeFileSync(file, doc.toString({ lineWidth: 0 }))
  return { file, removed }
}

/** `http`, `@speq/plugin-http` and `@speq/plugin-http@^2` all name one plugin. */
function names(spec: string): string[] {
  return candidates(parseSpec(spec).name)
}

function overlaps(a: string[], b: string[]): boolean {
  return a.some((name) => b.includes(name))
}
