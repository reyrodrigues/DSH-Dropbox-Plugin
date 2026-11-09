# Dropbox Reader for DeepSeek Harness

Lets the agent browse, search, and read your Dropbox **without downloading files to your computer**.
File contents stream from the Dropbox API into memory and go straight to the agent; nothing is
written to disk. Large text files are read by byte range, so only the requested part is fetched.
Access is **read-only**.

## Install

In DeepSeek Harness, open **Plugins → Add plugin**, enter

```
dsh-plugin-dropbox-reader
```

and click **Install**, then **Enable now**. No Node.js, terminal, or Dropbox developer account is needed.

## Connect your Dropbox

Ask the agent: *"Connect my Dropbox."* It will give you a Dropbox sign-in link. Approve access for
**DSH Document Classifier**, then paste the code Dropbox shows back into the chat. You only do this once.
The sign-in is stored in `~/.config/dsh-dropbox-reader/credentials.json` (readable only by you).
Say *"Disconnect my Dropbox"* to revoke it.

## What the agent can do

| Tool | Purpose |
|---|---|
| `dropbox_connect` / `dropbox_disconnect` | Sign in / sign out |
| `dropbox_whoami` | Connected account and space usage |
| `dropbox_list_folder` | List a folder (optionally recursive, paginated) |
| `dropbox_search` | Search names and contents, filter by folder or extension |
| `dropbox_get_metadata` | Size, dates, revision, id |
| `dropbox_read_file` | Text/code (paged), .docx/.pptx/.xlsx as text, Google Docs/Sheets/Slides and Paper exported |
| `dropbox_list_revisions` | File history; `dropbox_read_file` accepts a `rev` |
| `dropbox_read_shared_link` | Read a file from a shared link |

Not supported yet: text from PDFs and image contents (these return metadata only).

## Development

The source is TypeScript in `src/`. `npm run build` strips the types into `lib/` with Node's built-in
type stripper (Node ≥ 22.13) and needs no dependencies. `npm publish` runs the build automatically.

To test locally before publishing, run `npm run build`, then in Harness use **Plugins → Add plugin**
with the absolute path to this folder.
