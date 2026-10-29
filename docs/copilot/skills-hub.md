# Skills Hub, import and the Skills Matrix

**Routes:** `#/skills`, `#/matrix` · **Code:** `src/skillsData.js`, `src/skillsImport.js`,
`src/skillsImportView.js`, `src/skillsMatrix.js`, `src/skills.css`, `src/views2.js`
**Evidence:** `npm run test:skills` → 23/23 · smoke renders both routes · catalogue counts and
refusals asserted in the suite.

This implements the *MMMV2 skills interoperability design spec* (`§6` registry + matrix, `§7`
import/export, `§16.2` import acceptance criteria) as far as the repository can do so honestly.
There is **no skills runtime and no skills table on the gateway**: skills here are manifests in the
local store plus a typed relationship graph. The UI says so rather than implying execution.

## What ships

| Piece | Where | Notes |
| --- | --- | --- |
| Catalogue of **24 skills** | `src/skillsData.js` | 21 marketplace, 1 user-authored, 2 agent-synthesized; existing ids `sk-1…sk-6` preserved so agents, designer templates and tests keep working. |
| Typed relationships | `src/skillsData.js` → `REL_TYPES`, `RELATIONS` | 8 types, 24 seeded edges. |
| Import pipeline | `src/skillsImport.js` | Parse → schema → quarantine → scan → dependencies → permissions → preview → install/reject → audit. |
| Import UI | `src/skillsImportView.js` | Paste or upload, review sheet with findings, skip toggles, install / reject. |
| Matrix view | `src/skillsMatrix.js` | Graph + accessible table, legend, filters, validation, versioning, undo, export. |

## Where the controls live

The Skills Hub header is **New · Import · ⛓ (matrix)**. The matrix shortcut is a graph glyph
(`icons.graph`) reused everywhere:

- header of the Skills Hub, immediately after **Import**;
- inside **every** skill drawer as a chip next to the version/status chips, and again in the drawer
  footer for active skills;
- the sidebar route `#/matrix`;
- the *Installed* tab banner.

Both shortcut variants navigate to the same view; the drawer variant opens that skill's node sheet.

## Import formats

| Format | Detected by | Parsed as |
| --- | --- | --- |
| `SKILL.md` | leading `---` frontmatter block | YAML frontmatter (`name`, `description`, `version`, `allowed-tools`, `permissions`, `requires`, `inputs`, `outputs`) + markdown body. A file without frontmatter still imports, deriving the name from the heading and flagging it. |
| `skill.json` | single JSON object | Manifest fields, with `metadata.*` fallbacks |
| registry JSON | array or `{ "skills": [...] }` | Several skills (+ optional `relations`) |
| `skill.yaml` | `.yaml`/`.yml` extension or name/description keys | YAML subset: scalars, inline lists, block lists, nested map, literal blocks |
| MMM package | `schema: "mmm.skill.package.v1"` | Skills **and** typed relationships; re-imports our own export |
| `.zip` / `.skill` | binary upload | Stored/deflated entries; every `SKILL.md` and `skill.json` inside becomes a candidate |

Anything else is refused with an explanation of the accepted formats.

## Review findings

Blocking (`status: blocked`, cannot be installed):

- missing or invalid `name`;
- body over 64 KB, package over 4 MB;
- embedded secrets (API keys, GitHub/Slack tokens, AWS keys, private keys);
- instruction-injection patterns (prompt overrides, “grant yourself”, policy bypass, piped shell
  downloads, obfuscated payloads);
- zip entries that escape the archive (`../`, absolute paths, backslash paths) — the whole package is
  refused before extraction;
- the same name **at the same version** already installed.

Warnings (`needs-deps`, `conflict`, or simply recorded):

- required skills that are not installed (catalogue entries that the user has not added do **not**
  satisfy a dependency);
- a different version of an installed skill (the import will replace it explicitly, never silently);
- external hosts referenced in the body — importing does not fetch them or grant egress;
- tools declared without permissions, undeclared execution text, missing licence;
- relationships naming unknown skills or unknown types are dropped and listed.

Informational notes list requested tools and permissions, always with the reminder that the import
grants neither.

## Install, quarantine, audit

Installing lands every skill as `status: 'pending'` with `imported.quarantined = true`, its source
format/file, and the findings that were shown. Approval happens in Skills → Imported (or the
drawer) and only flips `status` to `active` / releases the flag — it does not grant permissions.
Rejecting records the attempt in the import log and adds nothing.

`state.skillImports` keeps the last 40 attempts (file, format, installed/skipped counts, rejection
reason, finding count); the *Imported* tab renders it as the audit trail.

## Skills Matrix

- **Graph** — radial layout, stable node order, zoomable, searchable, filterable by relationship
  type. Nodes show pending (`?`, dashed ring) and unavailable (`!`, red ring) states as text, not
  colour alone.
- **Typed edges** — `depends_on`, `complements`, `inherits_from`, `composes_with`, `triggers`,
  `conflicts_with`, `supersedes`, `related_to`, each with its own dash pattern, width and arrowhead;
  the legend doubles as the filter.
- **Accessible alternative** — a `<details>` table of every visible edge with Remove buttons, so the
  data is reachable without the SVG.
- **Editing** — a valid link saves immediately, bumps `matrixVersion`, pushes an undo snapshot into
  `matrixHistory` and writes an event. Self-links, duplicates, unknown skills and cycles in ordered
  types are rejected with a reason; `conflicts_with` against an execution link warns.
- **Honesty** — the footer states the store is this browser, that the gateway has no skills route,
  and that the runtime overlay is **not instrumented**; the graph never animates activity.
- **Reduced motion** — zoom transitions are removed under `prefers-reduced-motion: reduce`.

## Export

`buildPackage(names)` produces `mmm.skill.package.v1` with the selected skills and only the
relationships whose endpoints are both included (the count of omitted edges is reported). It contains
no credentials, memory, run logs, permission grants or local metadata, and re-imports cleanly.

## Migration

`core.migrate()` merges the catalogue into an existing saved workspace by id (keeping local status,
install and import metadata), adds missing catalogue skills, and creates `relations`,
`matrixVersion`, `matrixHistory` and `skillImports` when absent. Old six-skill workspaces therefore
gain the marketplace and the matrix on their next load without losing local changes.

## Limits worth repeating

- No skill in this repository executes. “Declared” means a manifest exists; the drawer's
  `runtime:` line says `manifest-only` for imports.
- Nothing is fetched from a URL at import time — pasting a link is not a supported source.
- The gateway has no `skills` table or route, so the hub is local to the browser and labelled as
  such. When a gateway route is added, this module is the seam to change.
