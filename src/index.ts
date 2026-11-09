// DeepSeek Harness Host plugin: registers native Dropbox tools on ctx.tools.
// Runs inside the Harness process — no external Node, MCP server, or paths.
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as op from './operations.ts'

export const name = 'dropbox-reader'
export const inject = ['tools']

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
} as const

export function apply(ctx: any) {
  const tools = [
    defineTool({
      name: 'dropbox_connect',
      description:
        'Connect the user\'s Dropbox (read-only). Call without "code" to get a sign-in link to show the user; ' +
        'after they approve, call again with the code Dropbox displayed. Use when any Dropbox tool reports it is not connected.',
      parameters: { code: { type: 'string', description: 'Authorization code the user pasted from Dropbox.' } },
      output: textOutput,
      execute: (a: any, exec: any) => op.connect(a.code, exec.signal),
    }),
    defineTool({
      name: 'dropbox_disconnect',
      description: 'Sign out of Dropbox: revoke the token and delete the stored credentials.',
      parameters: {},
      output: textOutput,
      execute: (_a: any, exec: any) => op.disconnect(exec.signal),
    }),
    defineTool({
      name: 'dropbox_whoami',
      description: 'Show which Dropbox account is connected and its space usage.',
      parameters: {},
      output: textOutput,
      execute: (_a: any, exec: any) => op.whoami(exec.signal),
    }),
    defineTool({
      name: 'dropbox_list_folder',
      description: 'List files and folders in a Dropbox folder ("" or "/" is the root). Returns a cursor when more entries exist.',
      parameters: {
        path: { type: 'string', description: 'Folder path, e.g. "/Projects". Default: root.' },
        recursive: { type: 'boolean', description: 'Include all subfolders. Default false.' },
        limit: { type: 'integer', description: 'Max entries per page (1-2000). Default 200.' },
        cursor: { type: 'string', description: 'Cursor from a previous call to fetch the next page.' },
      },
      output: textOutput,
      execute: (a: any, exec: any) => op.listFolder(a, exec.signal),
    }),
    defineTool({
      name: 'dropbox_search',
      description: 'Search Dropbox by file name and content, optionally within a folder or for given file extensions.',
      parameters: {
        query: { type: 'string', description: 'Search text (required unless cursor is given).' },
        path: { type: 'string', description: 'Restrict to this folder.' },
        extensions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["pdf","docx"]' },
        filenameOnly: { type: 'boolean', description: 'Match file names only. Default false.' },
        limit: { type: 'integer', description: 'Max results (1-1000). Default 50.' },
        cursor: { type: 'string', description: 'Cursor from a previous search to continue.' },
      },
      output: textOutput,
      execute: (a: any, exec: any) => op.search(a, exec.signal),
    }),
    defineTool({
      name: 'dropbox_get_metadata',
      description: 'Get metadata (size, modified time, revision, id) for a Dropbox file or folder.',
      parameters: { path: { type: 'string', required: true, description: 'Path or "id:..." of the file or folder.' } },
      output: textOutput,
      execute: (a: any, exec: any) => op.getMetadata(a.path, exec.signal),
    }),
    defineTool({
      name: 'dropbox_read_file',
      description:
        'Read a Dropbox file straight into the conversation without saving it locally. Text and code files support ' +
        'offset/length paging (only that byte range is fetched). .docx/.pptx/.xlsx are converted to text; Google ' +
        'Docs/Sheets/Slides and Paper are exported. Images, PDFs and other binaries return metadata only.',
      parameters: {
        path: { type: 'string', required: true, description: 'File path, e.g. "/Notes/todo.md", or "id:...".' },
        offset: { type: 'integer', description: 'Byte (text) or character (documents) offset. Default 0.' },
        length: { type: 'integer', description: `Max bytes/characters to return. Default ${op.MAX_TEXT}.` },
        rev: { type: 'string', description: 'Read a specific revision (see dropbox_list_revisions).' },
      },
      output: textOutput,
      execute: (a: any, exec: any) => op.readFile(a, exec.signal),
    }),
    defineTool({
      name: 'dropbox_list_revisions',
      description: 'List previous revisions of a Dropbox file.',
      parameters: {
        path: { type: 'string', required: true },
        limit: { type: 'integer', description: 'Max revisions (1-100). Default 10.' },
      },
      output: textOutput,
      execute: (a: any, exec: any) => op.listRevisions(a.path, a.limit, exec.signal),
    }),
    defineTool({
      name: 'dropbox_read_shared_link',
      description: 'Read a file from a Dropbox shared link (dropbox.com/s/... or /scl/...) without saving it locally.',
      parameters: {
        url: { type: 'string', required: true, description: 'The shared link URL.' },
        path: { type: 'string', description: 'For folder links: path of the file inside the shared folder.' },
        password: { type: 'string', description: 'Link password, if any.' },
        length: { type: 'integer', description: `Max characters to return. Default ${op.MAX_TEXT}.` },
      },
      output: textOutput,
      execute: (a: any, exec: any) => op.readSharedLink(a, exec.signal),
    }),
  ]
  // Registrations are scoped to ctx and removed automatically when the plugin unloads.
  for (const tool of tools) ctx.tools.register(tool)
}
