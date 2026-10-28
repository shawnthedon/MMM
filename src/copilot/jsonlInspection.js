/* Bounded JSONL syntax inspection for inline artifact text only.
 * This is NOT training validation, safety review, or a server-side security boundary. */
export const JSONL_MAX_BYTES = 1024 * 1024;
export const JSONL_MAX_ROWS = 10000;

export function inspectJsonl(text) {
  if (typeof text !== 'string') return { ok: false, rows: 0, errors: ['Inline text is unavailable.'] };
  // A UTF-16 code unit cannot encode to less than one UTF-8 byte; reject early to bound allocation.
  if (text.length > JSONL_MAX_BYTES || new TextEncoder().encode(text).byteLength > JSONL_MAX_BYTES) {
    return { ok: false, rows: 0, errors: ['Inline JSONL exceeds the 1 MiB inspection limit.'] };
  }
  let rows = 0;
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    rows += 1;
    if (rows > JSONL_MAX_ROWS) return { ok: false, rows, errors: ['JSONL exceeds the 10,000-row inspection limit.'] };
    try {
      const value = JSON.parse(lines[i]);
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        if (errors.length < 5) errors.push(`Line ${i + 1}: expected a JSON object.`);
      }
    } catch {
      if (errors.length < 5) errors.push(`Line ${i + 1}: invalid JSON.`);
    }
  }
  if (!rows) errors.push('No non-empty records found.');
  return { ok: errors.length === 0, rows, errors };
}
