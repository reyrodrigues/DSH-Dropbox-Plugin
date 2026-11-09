// Dropbox operations behind the agent tools. Every result is plain text built
// from bytes held in memory; nothing is written to the local disk.
import { createHash, randomBytes } from 'node:crypto'
import { readFile as readFs, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { APP_KEY, CREDENTIALS_PATH, deleteCredentials, Dropbox, loadCredentials, normPath, saveCredentials } from './dropbox.ts'
import { decodeText, ext, extractOffice, IMAGE_MIME, looksLikeText, OFFICE_EXT } from './extract.ts'

export const MAX_TEXT = 200_000
const MAX_DOC_BYTES = 50 * 1024 * 1024
const EXPORTABLE = /\.(gdoc|gsheet|gslides|paper)$/i
const SCOPES = 'account_info.read files.metadata.read files.content.read sharing.read'

export const dbx = new Dropbox()

export function fmtSize(n?: number): string {
  if (n === undefined) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

function fmtEntry(e: any): string {
  if (e['.tag'] === 'folder') return `[dir]  ${e.path_display}/`
  if (e['.tag'] === 'deleted') return `[deleted] ${e.path_display}`
  return `[file] ${e.path_display}  (${fmtSize(e.size)}, modified ${e.server_modified})`
}

// --- Sign-in (OAuth 2 PKCE, offline access) --------------------------------

// The PKCE verifier is kept on disk (not in memory) so a sign-in survives plugin
// reloads and restarts between "get link" and "paste code". Valid for 1 hour.
const PENDING_PATH = join(dirname(CREDENTIALS_PATH), 'pending-signin.json')
const PENDING_TTL = 60 * 60 * 1000

async function savePending(verifier: string) {
  await mkdir(dirname(PENDING_PATH), { recursive: true, mode: 0o700 })
  await writeFile(PENDING_PATH, JSON.stringify({ verifier, createdAt: Date.now() }), { mode: 0o600 })
}
async function loadPending(): Promise<string | undefined> {
  try {
    const p = JSON.parse(await readFs(PENDING_PATH, 'utf8'))
    return Date.now() - p.createdAt < PENDING_TTL ? p.verifier : undefined
  } catch {
    return undefined
  }
}

export async function connect(code: string | undefined, signal: AbortSignal): Promise<string> {
  if (!code) {
    const verifier = randomBytes(48).toString('base64url')
    await savePending(verifier)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const url = new URL('https://www.dropbox.com/oauth2/authorize')
    url.search = new URLSearchParams({
      client_id: APP_KEY,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: SCOPES,
    }).toString()
    return (
      'Ask the user to open this link (it replaces any earlier link), sign in to Dropbox, click "Allow", and paste back the code Dropbox shows:\n\n' +
      `${url}\n\nThen call dropbox_connect again with that code. Access is read-only.`
    )
  }
  const pendingVerifier = await loadPending()
  if (!pendingVerifier) throw new Error('No sign-in in progress (or it expired after 1 hour). Call dropbox_connect without a code to get a new link.')
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    signal,
    body: new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: pendingVerifier }),
  })
  const json: any = await res.json().catch(() => ({}))
  // On failure keep the pending sign-in, so a mistyped code can be retried with the same link.
  if (!res.ok)
    throw new Error(
      `Dropbox rejected the code: ${json.error_description ?? res.statusText}. Check it was copied from the most recent link and try again; ` +
        'Dropbox codes are single-use and expire after a few minutes.',
    )
  await rm(PENDING_PATH, { force: true })
  await saveCredentials({
    appKey: APP_KEY,
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 14400) * 1000,
  })
  dbx.reset()
  return `Connected to Dropbox.\n${await whoami(signal)}`
}

export async function disconnect(signal: AbortSignal): Promise<string> {
  const c = await loadCredentials()
  const token = c.accessToken
  if (token) await fetch('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal }).catch(() => {})
  await deleteCredentials()
  dbx.reset()
  return `Disconnected from Dropbox and deleted ${CREDENTIALS_PATH}.`
}

// --- Read-only operations -------------------------------------------------

export async function whoami(signal: AbortSignal): Promise<string> {
  const [acct, space] = await Promise.all([dbx.rpc('users/get_current_account', null, signal), dbx.rpc('users/get_space_usage', null, signal)])
  const alloc = space.allocation?.allocated
  return `${acct.name.display_name} <${acct.email}> (${acct.account_type['.tag']})\nUsed ${fmtSize(space.used)}${alloc ? ` of ${fmtSize(alloc)}` : ''}`
}

export async function listFolder(a: { path?: string; recursive?: boolean; limit?: number; cursor?: string }, signal: AbortSignal): Promise<string> {
  const r = a.cursor
    ? await dbx.rpc('files/list_folder/continue', { cursor: a.cursor }, signal)
    : await dbx.rpc('files/list_folder', { path: normPath(a.path), recursive: !!a.recursive, limit: a.limit ?? 200 }, signal)
  const lines: string[] = r.entries.map(fmtEntry)
  if (!lines.length) lines.push('(empty)')
  if (r.has_more) lines.push(`\n[more entries available — call again with cursor="${r.cursor}"]`)
  return lines.join('\n')
}

export async function search(
  a: { query?: string; path?: string; extensions?: string[]; filenameOnly?: boolean; limit?: number; cursor?: string },
  signal: AbortSignal,
): Promise<string> {
  let r: any
  if (a.cursor) r = await dbx.rpc('files/search/continue_v2', { cursor: a.cursor }, signal)
  else {
    if (!a.query) throw new Error('query is required unless cursor is given')
    const options: any = { max_results: a.limit ?? 50, filename_only: !!a.filenameOnly }
    if (a.path) options.path = normPath(a.path)
    if (a.extensions?.length) options.file_extensions = a.extensions.map((x) => x.replace(/^\./, ''))
    r = await dbx.rpc('files/search_v2', { query: a.query, options }, signal)
  }
  const lines: string[] = r.matches.map((m: any) => fmtEntry(m.metadata.metadata))
  if (!lines.length) lines.push('No matches.')
  if (r.has_more) lines.push(`\n[more results — call again with cursor="${r.cursor}"]`)
  return lines.join('\n')
}

export async function getMetadata(path: string, signal: AbortSignal): Promise<string> {
  const m = await dbx.rpc('files/get_metadata', { path: normPath(path), include_media_info: true }, signal)
  return JSON.stringify(m, null, 2)
}

export async function listRevisions(path: string, limit: number | undefined, signal: AbortSignal): Promise<string> {
  const r = await dbx.rpc('files/list_revisions', { path: normPath(path), limit: limit ?? 10 }, signal)
  return r.entries.map((e: any) => `${e.rev}  ${e.server_modified}  ${fmtSize(e.size)}`).join('\n') || 'No revisions.'
}

function page(info: string, body: string, offset: number, limit: number, unit: string): string {
  const slice = body.slice(offset, offset + limit)
  const end = offset + slice.length
  const more = end < body.length ? `\n\n[truncated: ${unit} ${offset}-${end} of ${body.length}; call again with offset=${end}]` : ''
  return `${info}\n\n${slice}${more}`
}

function renderBinary(info: string, name: string, bytes: Uint8Array): string {
  const e = ext(name)
  const kind = IMAGE_MIME[e] ? 'Image' : e === 'pdf' ? 'PDF' : 'Binary'
  const hex = Buffer.from(bytes.subarray(0, 128)).toString('hex').replace(/(.{32})/g, '$1\n')
  return `${info}\n${kind} file (.${e}); text extraction is not supported for this type. First bytes:\n${hex}`
}

export async function readFile(a: { path: string; offset?: number; length?: number; rev?: string }, signal: AbortSignal): Promise<string> {
  const limit = a.length ?? MAX_TEXT
  const offset = a.offset ?? 0
  const target = a.rev ? `rev:${a.rev}` : normPath(a.path)
  const meta = await dbx.rpc('files/get_metadata', { path: target }, signal)
  if (meta['.tag'] !== 'file') throw new Error(`${a.path} is a folder; use dropbox_list_folder.`)
  const name: string = meta.name
  const info = `${meta.path_display} — ${fmtSize(meta.size)}, modified ${meta.server_modified}, rev ${meta.rev}`
  if (meta.export_info || EXPORTABLE.test(name)) {
    const { bytes } = await dbx.content('files/export', { path: meta.id }, { signal, maxBytes: MAX_DOC_BYTES })
    return page(`${info} (exported)`, decodeText(bytes), offset, limit, 'characters')
  }
  const dlArg = { path: a.rev ? target : meta.id }
  if (OFFICE_EXT.has(ext(name))) {
    if (meta.size > MAX_DOC_BYTES) return `${info}\nFile is larger than ${fmtSize(MAX_DOC_BYTES)}; cannot extract text.`
    const { bytes } = await dbx.content('files/download', dlArg, { signal, maxBytes: MAX_DOC_BYTES })
    return page(info, extractOffice(bytes, name), offset, limit, 'characters')
  }
  if (meta.size === 0) return `${info}\n\n(empty file)`
  if (offset >= meta.size) return `${info}\n\noffset ${offset} is past the end of the file.`
  // Ranged read: only the requested bytes leave Dropbox.
  const end = Math.min(meta.size, offset + limit) - 1
  const { bytes } = await dbx.content('files/download', dlArg, { signal, maxBytes: limit, range: [offset, end] })
  if (IMAGE_MIME[ext(name)] || ext(name) === 'pdf' || !looksLikeText(bytes, name)) return renderBinary(info, name, bytes)
  const more = end + 1 < meta.size ? `\n\n[truncated: bytes ${offset}-${end + 1} of ${meta.size}; call again with offset=${end + 1}]` : ''
  return `${info}\n\n${decodeText(bytes)}${more}`
}

export async function readSharedLink(a: { url: string; path?: string; password?: string; length?: number }, signal: AbortSignal): Promise<string> {
  const arg: any = { url: a.url }
  if (a.path) arg.path = normPath(a.path)
  if (a.password) arg.link_password = a.password
  const limit = a.length ?? MAX_TEXT
  const { bytes, meta } = await dbx.content('sharing/get_shared_link_file', arg, { signal, maxBytes: MAX_DOC_BYTES })
  const name: string = meta.name ?? a.path ?? a.url
  const info = `${name} — ${fmtSize(meta.size)} (shared link)`
  if (OFFICE_EXT.has(ext(name))) return page(info, extractOffice(bytes, name), 0, limit, 'characters')
  if (IMAGE_MIME[ext(name)] || ext(name) === 'pdf' || !looksLikeText(bytes, name)) return renderBinary(info, name, bytes)
  return page(info, decodeText(bytes), 0, limit, 'characters')
}
