import { gunzipSync } from 'node:zlib'

export interface TarEntry {
  /** Path with the leading `package/` npm always adds already stripped. */
  path: string
  mode: number
  body: Uint8Array
}

const BLOCK = 512

/**
 * A tar reader, rather than a dependency.
 *
 * Not because extracting tar is interesting, but because this is the exact
 * point where an installer gets a security hole: an entry called
 * `../../../.ssh/authorized_keys` extracts wherever it likes, and a symlink
 * entry does the same one level of indirection later. Both are refused here,
 * loudly. A package that needs them is a package we do not install.
 */
export function extractTarGz(gzipped: Uint8Array, options: { strip?: number } = {}): TarEntry[] {
  return readTar(gunzipSync(gzipped), options.strip ?? 1)
}

export function readTar(buffer: Uint8Array, strip: number): TarEntry[] {
  const entries: TarEntry[] = []
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = 0
  let longName: string | undefined

  while (offset + BLOCK <= view.length) {
    const header = view.subarray(offset, offset + BLOCK)
    if (header.every((b) => b === 0)) break

    const name = longName ?? readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156]!) || '0'
    const mode = readOctal(header, 100, 8)
    longName = undefined

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    const data = view.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    // GNU long name and pax headers describe the *next* entry.
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x' || type === 'X') {
      longName = readPaxPath(data.toString('utf8'))
      continue
    }
    if (type === 'g') continue

    if (type === '1' || type === '2') {
      throw new Error(`refusing archive: it contains a link entry (${name}), which an installer must not follow`)
    }
    if (type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '7') continue

    const full = prefix ? `${prefix}/${name}` : name

    // Checked before stripping, not after: dropping empty segments turns
    // `/etc/passwd` into a perfectly innocent-looking relative path, and the
    // check would then pass on something the archive never actually asked for.
    assertSafe(full)

    const path = stripComponents(full, strip)
    if (path === undefined) continue

    entries.push({ path, mode: mode || 0o644, body: new Uint8Array(data) })
  }

  return entries
}

/** npm wraps everything in `package/`; strip is how that goes away. */
function stripComponents(path: string, strip: number): string | undefined {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= strip) return undefined
  return parts.slice(strip).join('/')
}

function assertSafe(path: string): void {
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    throw new Error(`refusing archive: entry '${path}' escapes the directory it is being written to`)
  }
}

function readString(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function readOctal(header: Buffer, start: number, length: number): number {
  const text = readString(header, start, length).trim()
  return text ? parseInt(text, 8) || 0 : 0
}

/** pax records are `<len> <key>=<value>\n`; only `path` matters here. */
function readPaxPath(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}
