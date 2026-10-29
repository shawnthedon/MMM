/* ============ Self-modification — readable diffs ============
 * A change an agent cannot explain to a reviewer in diff form is not a change a reviewer can approve.
 * This is a small, dependency-free unified diff. It is deliberately boring: no colour, no clever
 * heuristics, and a hard line cap so a 40 MB generated file cannot exhaust the gateway.
 */

const MAX_LINES = 4000;

const splitLines = (text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n');

/** Longest common subsequence table, bounded so pathological inputs cannot blow up memory. */
function lcsMatrix(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + (j + 1)] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  return { table, cols };
}

/**
 * @returns {{ text: string, added: number, removed: number, lines: number, truncated: boolean }}
 */
export function unifiedDiff(beforeText, afterText, { beforeName = 'baseline', afterName = 'candidate', context = 3 } = {}) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      text: `--- ${beforeName}\n+++ ${afterName}\n@@ file too large to diff in the gateway (${a.length} → ${b.length} lines) @@\n`,
      added: 0, removed: 0, lines: 0, truncated: true,
    };
  }

  const ops = []; // { type: ' ' | '-' | '+', text }
  const { table, cols } = lcsMatrix(a, b);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ type: ' ', text: a[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) { ops.push({ type: '-', text: a[i] }); i += 1; }
    else { ops.push({ type: '+', text: b[j] }); j += 1; }
  }
  while (i < a.length) { ops.push({ type: '-', text: a[i] }); i += 1; }
  while (j < b.length) { ops.push({ type: '+', text: b[j] }); j += 1; }

  // Keep only hunks that contain a change, with `context` lines around them.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
  });

  const out = [`--- ${beforeName}`, `+++ ${afterName}`];
  let added = 0;
  let removed = 0;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) { idx += 1; continue; }
    // Start a hunk.
    const start = idx;
    let end = idx;
    while (end + 1 < ops.length && keep[end + 1]) end += 1;
    const hunk = ops.slice(start, end + 1);
    const beforeStart = ops.slice(0, start).filter((o) => o.type !== '+').length;
    const afterStart = ops.slice(0, start).filter((o) => o.type !== '-').length;
    const beforeCount = hunk.filter((o) => o.type !== '+').length;
    const afterCount = hunk.filter((o) => o.type !== '-').length;
    out.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (const op of hunk) {
      if (op.type === '+') added += 1;
      if (op.type === '-') removed += 1;
      out.push(`${op.type}${op.text}`);
    }
    idx = end + 1;
  }

  const text = out.join('\n') + '\n';
  const lines = added + removed;
  return { text: lines ? text : '', added, removed, lines, truncated: false };
}

/** A one-paragraph, human summary for the mobile panel. */
export function describeDiff({ files = 0, added = 0, removed = 0 } = {}) {
  if (!files) return 'No changes yet.';
  return `${files} file${files === 1 ? '' : 's'} changed · +${added} −${removed} lines`;
}
