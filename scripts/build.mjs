// Zero-dependency build: strip TypeScript types with Node's built-in
// stripTypeScriptTypes and rewrite relative ".ts" imports to ".js".
import { stripTypeScriptTypes } from 'node:module'
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
await rm(join(root, 'lib'), { recursive: true, force: true })
await mkdir(join(root, 'lib'), { recursive: true })
for (const f of await readdir(join(root, 'src'))) {
  if (!f.endsWith('.ts')) continue
  const src = await readFile(join(root, 'src', f), 'utf8')
  const js = stripTypeScriptTypes(src, { mode: 'strip' }).replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  await writeFile(join(root, 'lib', f.replace(/\.ts$/, '.js')), js)
  console.log(`lib/${f.replace(/\.ts$/, '.js')}`)
}
