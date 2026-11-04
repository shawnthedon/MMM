# File management

A real file service, a panel over it, and a download manager that can be paused because it streams.

**Status: increment 1 shipped. The FTP client described in the request is not built yet — this document
says what exists, what it refuses to fake, and what is still missing.**

---

## 1. What was there before

The **Files** screen (`views.artifacts`, `src/views2.js:1164`) shows a hard-coded `248 MB / 2 GB`, a
`248 MB used` subtitle, rows from `state.files` in the browser, an "Upload" that writes a JavaScript
object into local state, and a "Share" button that copies a string saying a link expires in 24 hours.
None of it touches a disk. The capability registry had exactly one file operation —
`files.upload` — declared `no-service`, with the note *"The files table exists but no route serves it."*

That screen is kept, unchanged, and labelled in Settings as "Sample artifacts screen". It is not the file
manager and the panel says so.

## 2. What exists now

### Gateway — `apps/gateway/src/files.js` (real filesystem)

| Piece | Detail |
| --- | --- |
| Roots | `file_locations` rows: an absolute directory, a label, a kind, and a purpose. Three are seeded on first boot under `MMM_FILES_ROOT` (default `./var/files`): `downloads/`, `artifacts/`, `web/` |
| Listing | `GET /files/list?location=&path=` — name, type (file/dir/link), size, mtime, extension, sorted, bounded at 2000 entries |
| Reads | `GET /files/stat`, `GET /files/usage` (bounded recursive walk: bytes, files, dirs, `truncated` flag) |
| Writes | `POST /files/dir`, `POST /files/move`, `POST /files/copy`, `DELETE /files/entry` |
| Bytes up | `POST /files/upload` — binary body, temp file + rename, answer carries the size `stat` reports |
| Bytes down | `GET /files/download` — `Accept-Ranges: bytes`, `206` with `Content-Range`, `416` when impossible |
| Records | `file_downloads` — byte counts, status, attempts, error; reconciled to `failed` if a row still said `running` after a restart |

### Safety, and why each rule exists

1. **A path never escapes its root.** `resolveInside` refuses `..`, absolute paths and null bytes;
   `assertNoEscape` then re-checks `realpath` — walking up to the deepest existing ancestor — so a symlink
   inside the root that points outside it is refused rather than followed. Both are tested, including an
   attempt to write *through* such a link.
2. **Deleting is reversible.** `removeEntry` moves to `<root>/.trash/<timestamp>__<name>`; there is no
   unlink route anywhere in the module.
3. **A write is reported from the disk.** Uploads are `stat`ed after the rename, and the response says
   `confirmedBy: 'stat'` — what the browser sent is not evidence.
4. **Deployment is a boundary, not a permission.** Reads need `file:read` (Observer), writes `file:write`
   (Operator), enrolling a root `file:configure` (Owner).

### Registry

16 operations, all with contracts, all dispatchable by an Owner:
`files.capabilities`, `files.locations.list|create|update|delete`, `files.list|stat|usage|mkdir|move|copy|delete`,
`files.downloads.list|create|update|delete`.

Two routes are excused from the dispatcher by name in `capabilities.UNEXPOSED`, because a dispatcher call
is a JSON result and these carry bytes: `POST /files/upload` (the file *is* the body) and
`GET /files/download` (a stream). Drift check stays at zero.

`files.delete` is declared **reversible**, not destructive — because it moves to the trash. Calling it
destructive would have forced an approval gate that the route does not enforce (see the audit's P2
finding), which would have been a declaration the code cannot honour.

### Panel — `src/files.js` + `src/files.css`, opened from Settings

Three tabs:

- **Browse** — location chips, breadcrumb, rows with type icons and sizes. Long-press (500 ms, with a
  haptic tick where the device has one) or right-click opens a context sheet: Open / Download /
  Rename-or-move / Copy to / New folder inside / Move to trash. Folders open on tap.
- **Downloads** — one card per record: bytes, percentage, live speed and ETA, a bar whose width is the
  byte count, and Pause / Resume / Stop / Restart / Save / Delete. The same actions are in the context
  sheet.
- **Storage** — each enrolled root, its absolute path, measured usage, its purpose, and an "Enrol a
  directory" form for an Owner.

Uploads use `XMLHttpRequest` **because only XHR reports upload progress** — a progress bar that cannot
move is exactly the decorative control this app is not allowed to have. Upload speed is computed from
`upload.onprogress`.

## 3. How pause and resume are actually real

The browser cannot append to a file on disk, so the honest design is: the panel streams the response
with `fetch` + `ReadableStream`, keeps the chunks, and reports progress to the gateway every ~900 ms.

- **Pause** aborts the controller. The gateway is told `paused` with the byte count reached.
- **Resume** re-requests the same URL with `Range: bytes=<bytesDone>-`, receives `206`, and appends.
- **Stop** aborts and records `cancelled`.
- **Restart** zeroes the count and records an attempt.
- **Save** assembles the chunks into a `Blob` and hands it to the browser's own download.

A reload is handled too: on `GET /files/downloads`, any row still marked `running` is reconciled to
`failed` with "the transfer stopped when the app closed; resume from the saved byte count". Progress bars
never claim a socket nobody is holding.

**Limit, stated plainly:** the bytes are held in memory until you press Save, so the practical ceiling is
a file that fits comfortably in the tab. `FILE_LIMITS.downloadBytes` is 64 MB and the panel does not
pretend otherwise.

## 4. What is *not* built yet

| Requested | State |
| --- | --- |
| FTP client, FTP settings, agent/Copilot upload to a web host | **not built.** No FTP module, no settings, no route. The `web` location exists so the source side of a deploy has somewhere to live, and `agent.web.deploy` does not exist. |
| "Devices and network" in the tree | **blocked, by design of the platform.** A browser cannot enumerate devices or mount SMB/NFS/WebDAV shares. What *is* possible is enrolling a directory the host has already mounted (`MMM_FILES_ROOT` or an Owner-enrolled absolute path) — that is what the Storage tab does, and it is the only honest version of "network folders" here. |
| "Assign folders for application usage" | **partly built.** A location carries a `purpose` (`downloads`, `uploads`, `web-deploy`) and a `granted` flag; the seeded roots already carry theirs. There is no per-download "save to this folder" preference yet — the download goes to the record and the browser's own save dialog picks the destination. |
| Range-based *server-side* download to a folder on the host | not built; every download currently lands in the browser, not on the gateway. |
| Thumbnails / previews | not built. |

## 4b. How to reach it (this was broken, and why)

The first ship of this panel was correct and **invisible**. Two reasons, both fixed:

1. **The nav tile labelled “Files” pointed at `artifacts`** — the prototype's sample screen. `files` had no
   destination in the module grid at all, so tapping *Files* showed seeded rows and a fabricated
   “248 MB used”, and the real manager was only reachable by URL or from Settings. The grid now sends
   **Files → `files`**, and `artifacts` is relabelled **“Sample artifacts”** and taken out of the grid
   (still routable; Settings links to it and says what it is).
2. **With no gateway the screen was a single banner.** Honest, but it hid the feature's shape. It now
   renders its three tabs and a four-step panel that says what is missing and how to fix it, with a button
   to Account & Access. Nothing is pre-filled with example data in either state.

To see it with real files:

```
npm run dev:gateway      # terminal 1 — owns the directories
npm run dev              # terminal 2 — proxies /api to :8787
```

Then open **Files** in the module grid. With no session yet you get the four-step panel; sign in and the
tree appears. Three roots are created on the gateway's first boot; `MMM_FILES_ROOT` moves them.

If the app does not know the gateway yet, either set `VITE_GATEWAY_URL=/` (same origin, proxied by Vite)
before `npm run dev`, or use **Account & Access → Configure gateway** with `/`. Until this was fixed the
env var did nothing: `envUrl()` read `import.meta?.env?.VITE_GATEWAY_URL`, and Vite only substitutes the
plain `import.meta.env.VITE_GATEWAY_URL` — optional chaining suppressed the substitution, so the app always
booted in demo mode and the file manager always showed its "needs a gateway" panel.

## 5. Evidence

| Suite | Result |
| --- | --- |
| `npm run test:files` (real gateway + real temp filesystem) | **22 passed, 0 failed** |
| `npm run test:files:ui` (real panel code, stubbed transport) | **8 passed, 0 failed** |
| `npm run test:capabilities` | 21 passed (the no-service list moved with the new service) |
| `npm run test:dispatch` | 36 passed |
| `npm run build` | green |

The gateway suite is the integration proof: uploaded bytes are read back from disk, a `Range` request
returns exactly the requested slice, a traversal and a symlink escape are both refused with nothing
written outside the root, an Observer cannot write, an Operator cannot enrol a root, an un-enrol leaves
the directory intact, and the audit chain still verifies.
