// Minimal Dropbox API v2 client. All file content is fetched into memory only;
// nothing is ever written to the local disk.
import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Public app key of the "DSH Document Classifier" Dropbox app (PKCE public client, no secret). */
export const APP_KEY = process.env.DROPBOX_APP_KEY ?? '8btbby459536hgl'

export const CREDENTIALS_PATH =
  process.env.DROPBOX_READER_CREDENTIALS ?? join(homedir(), '.config', 'dsh-dropbox-reader', 'credentials.json')

                              
                 
                    
                       
                      
                    
 

export async function loadCredentials()                       {
  let file              = {}
  try {
    file = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'))
  } catch {}
  return {
    appKey: file.appKey ?? APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET ?? file.appSecret,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN ?? file.refreshToken,
    accessToken: process.env.DROPBOX_ACCESS_TOKEN ?? file.accessToken,
    expiresAt: process.env.DROPBOX_ACCESS_TOKEN ? undefined : file.expiresAt,
  }
}

export async function saveCredentials(creds             )                {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 })
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 })
  await chmod(CREDENTIALS_PATH, 0o600)
}

export async function deleteCredentials()                {
  await rm(CREDENTIALS_PATH, { force: true })
}

export class DropboxError extends Error {
  status        
  summary         
  constructor(message        , status        , summary         ) {
    super(message)
    this.status = status
    this.summary = summary
  }
}

export class Dropbox {
          creds                         
          refreshing                             

  /** Drop cached credentials so the next call re-reads the credentials file. */
  reset()       {
    this.creds = undefined
  }

          async token(force = false)                  {
    this.creds ??= await loadCredentials()
    const c = this.creds
    const fresh = c.accessToken && (!c.expiresAt || c.expiresAt - 60_000 > Date.now())
    if (fresh && !force) return c.accessToken 
    if (!c.refreshToken || !c.appKey) {
      if (c.accessToken && !force) return c.accessToken
      throw new DropboxError(
        'Dropbox is not connected. Call dropbox_connect (without a code) to get a sign-in link for the user.',
        401,
      )
    }
    this.refreshing ??= (async () => {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken , client_id: c.appKey  })
      if (c.appSecret) body.set('client_secret', c.appSecret)
      const res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body })
      const json      = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new DropboxError(
          `Dropbox sign-in expired or was revoked (${json.error_description ?? res.statusText}). Call dropbox_connect to sign in again.`,
          res.status,
        )
      c.accessToken = json.access_token
      c.expiresAt = Date.now() + (json.expires_in ?? 14400) * 1000
      return c.accessToken 
    })().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

          async request(url        , init                                , signal              )                    {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init(await this.token(attempt > 0)), signal })
      if (res.status === 401 && attempt === 0) continue
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get('retry-after') ?? 1) * 1000
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)))
        continue
      }
      if (!res.ok && res.status !== 206) {
        const text = await res.text()
        let summary                    
        try {
          summary = JSON.parse(text).error_summary
        } catch {}
        const detail = summary ?? text.slice(0, 500)
        // The token predates a permission: the app owner enabled it, but this sign-in doesn't include it.
        if (/missing_scope|does not have the required scope/.test(detail))
          throw new DropboxError(
            `This Dropbox sign-in is missing a permission (${detail}). It was probably granted before the permission was ` +
              'enabled for the app. Call dropbox_connect without a code to get a new sign-in link (no need to disconnect first); ' +
              'the new sign-in replaces the old one. If the error mentions "Your app", the app owner must enable the permission ' +
              'in the Dropbox App Console first.',
            res.status,
            summary,
          )
        throw new DropboxError(`Dropbox API error ${res.status}: ${detail}`, res.status, summary)
      }
      return res
    }
  }

  /** RPC endpoint on api.dropboxapi.com. */
  async rpc         (endpoint        , args         , signal              )             {
    const res = await this.request(
      `https://api.dropboxapi.com/2/${endpoint}`,
      // No-argument endpoints must be sent without Content-Type: Dropbox answers a
      // JSON Content-Type with an empty body with "500 unexpected error occurred".
      (t) =>
        args === null
          ? { method: 'POST', headers: { Authorization: `Bearer ${t}` } }
          : { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) },
      signal,
    )
    return res.json()              
  }

  /** Content endpoint (download/export); returns bytes in memory plus metadata. */
  async content(
    endpoint        ,
    args         ,
    opts                                                                      ,
  )                                                                {
    const res = await this.request(
      `https://content.dropboxapi.com/2/${endpoint}`,
      (t) => {
        const headers                         = {
          Authorization: `Bearer ${t}`,
          // Non-ASCII characters must be escaped in the header.
          'Dropbox-API-Arg': JSON.stringify(args).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
        }
        if (opts.range) headers.Range = `bytes=${opts.range[0]}-${opts.range[1]}`
        return { method: 'POST', headers }
      },
      opts.signal,
    )
    const meta = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}')
    // Stream into memory, stopping at maxBytes so huge files are never fully pulled.
    const chunks               = []
    let size = 0
    let truncated = false
    const reader = res.body .getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.length > opts.maxBytes) {
        chunks.push(value.subarray(0, opts.maxBytes - size))
        size = opts.maxBytes
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      size += value.length
    }
    const bytes = new Uint8Array(size)
    let off = 0
    for (const c of chunks) {
      bytes.set(c, off)
      off += c.length
    }
    return { bytes, meta, truncated }
  }
}

/** Dropbox wants "" for the root and a leading slash otherwise; ids ("id:...") pass through. */
export function normPath(p                    )         {
  if (!p || p === '/' || p === '.') return ''
  if (/^(id|rev|ns):/.test(p)) return p
  return p.startsWith('/') ? p.replace(/\/+$/, '') : '/' + p.replace(/\/+$/, '')
}
