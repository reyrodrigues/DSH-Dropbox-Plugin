// In-memory content decoding: text detection and Office (docx/pptx/xlsx) text extraction.
import { inflateRawSync } from 'node:zlib'

const TEXT_EXT = new Set(
  ('txt md markdown rst csv tsv json jsonl yaml yml toml ini cfg conf xml html htm css scss less js mjs cjs ts tsx jsx ' +
    'py rb go rs java kt swift c h cpp hpp cs php sh bash zsh fish ps1 sql graphql log env tex bib srt vtt svg ipynb ' +
    'gitignore dockerfile makefile r lua pl dart vue svelte properties gradle').split(' '),
)
export const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
export const OFFICE_EXT = new Set(['docx', 'pptx', 'xlsx'])

export function ext(name: string): string {
  const base = name.split('/').pop()!.toLowerCase()
  const i = base.lastIndexOf('.')
  return i < 0 ? base : base.slice(i + 1)
}

export function looksLikeText(bytes: Uint8Array, name: string): boolean {
  if (TEXT_EXT.has(ext(name))) return true
  const sample = bytes.subarray(0, 8192)
  let bad = 0
  for (const b of sample) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) bad++
  }
  return sample.length === 0 || bad / sample.length < 0.02
}

/** Decode UTF-8, dropping a partial multi-byte sequence at the end of a ranged read. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\uFFFD$/, '')
}

// --- ZIP (in memory) -------------------------------------------------------

function unzip(buf: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/Office file')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = new Map<string, Uint8Array>()
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + xlen + clen
    if (!want(name)) continue
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
    const data = buf.subarray(start, start + csize)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, inflateRawSync(data))
  }
  return out
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')

function paragraphs(xml: string, para: string, run: string): string {
  const out: string[] = []
  const pre = new RegExp(`<${para}[ >][\\s\\S]*?</${para}>`, 'g')
  const tre = new RegExp(`<${run}(?: [^>]*)?>([\\s\\S]*?)</${run}>|<w:tab/>|<w:br/>`, 'g')
  for (const p of xml.match(pre) ?? []) {
    let line = ''
    for (const m of p.matchAll(tre)) line += m[1] !== undefined ? decodeEntities(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n'
    out.push(line)
  }
  return out.join('\n')
}

export function extractOffice(bytes: Uint8Array, name: string): string {
  const e = ext(name)
  const td = new TextDecoder()
  if (e === 'docx') {
    const files = unzip(bytes, (n) => n === 'word/document.xml')
    const xml = files.get('word/document.xml')
    if (!xml) throw new Error('word/document.xml missing')
    return paragraphs(td.decode(xml), 'w:p', 'w:t')
  }
  if (e === 'pptx') {
    const files = unzip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    const nums = [...files.keys()].map((k) => +k.match(/(\d+)\.xml$/)![1]).sort((a, b) => a - b)
    return nums.map((i) => `--- Slide ${i} ---\n` + paragraphs(td.decode(files.get(`ppt/slides/slide${i}.xml`)!), 'a:p', 'a:t')).join('\n\n')
  }
  if (e === 'xlsx') {
    const files = unzip(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    const shared: string[] = []
    const ss = files.get('xl/sharedStrings.xml')
    if (ss)
      for (const si of td.decode(ss).match(/<si>[\s\S]*?<\/si>/g) ?? [])
        shared.push([...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join(''))
    const wb = files.get('xl/workbook.xml')
    const sheetNames = wb ? [...td.decode(wb).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeEntities(m[1])) : []
    const nums = [...files.keys()].filter((k) => k.includes('worksheets')).map((k) => +k.match(/(\d+)\.xml$/)![1]).sort((a, b) => a - b)
    const parts: string[] = []
    for (const i of nums) {
      const xml = td.decode(files.get(`xl/worksheets/sheet${i}.xml`)!)
      const rows: string[] = []
      for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
        const cells: string[] = []
        for (const c of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]
          const inner = c[2] ?? ''
          const ref = attrs.match(/r="([A-Z]+)/)?.[1]
          const type = attrs.match(/t="([^"]+)"/)?.[1]
          let v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
          if (type === 's' && v !== undefined) v = shared[+v]
          else if (type === 'inlineStr') v = [...inner.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')
          if (v === undefined) continue
          if (ref) {
            const col = [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1
            while (cells.length < col) cells.push('')
          }
          cells.push(decodeEntities(v).replace(/\t|\n/g, ' '))
        }
        rows.push(cells.join('\t'))
      }
      parts.push(`--- Sheet: ${sheetNames[i - 1] ?? i} ---\n` + rows.join('\n'))
    }
    return parts.join('\n\n')
  }
  throw new Error(`Unsupported office format: ${e}`)
}
