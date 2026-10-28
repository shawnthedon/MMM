/* ============ Sentence-aware chunking ============
 * Pure functions, no DOM. Used by the live type-to-speech controller to decide what is safe to
 * submit for synthesis *now* (a finished sentence) and what must stay buffered (an incomplete one).
 *
 * Rules:
 *   • `.` `!` `?` end a sentence when followed by whitespace/end.
 *   • Abbreviations (Dr., e.g., i.e., etc.) and decimals (3.14) do not end a sentence.
 *   • Ellipses are consumed as one boundary, not three.
 *   • A chunk longer than `maxChars` is split at the last word/punctuation boundary before the
 *     limit, never inside a word, so engines still receive pronounceable text.
 */

export const DEFAULT_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'eg', 'ie', 'fig', 'no',
  'inc', 'ltd', 'co', 'corp', 'approx', 'dept', 'est', 'al', 'ca', 'cf', 'viz', 'u.s', 'u.k', 'e.g', 'i.e',
]);

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);

const lastWord = (text, token) => {
  const match = String(text).match(/([\w.]+)\.$/);
  const candidate = match ? match[1].toLowerCase().replace(/\.$/, '') : '';
  return candidate === token || candidate === token.replace(/\./g, '');
};

/** True when `text` ends with an abbreviation that must not terminate a sentence. */
export function endsWithAbbreviation(text, abbreviations = DEFAULT_ABBREVIATIONS) {
  if (!/\.$/.test(text)) return false;
  const token = String(text).match(/([\w.]+)\.$/)?.[1]?.toLowerCase() || '';
  if (!token) return false;
  return abbreviations.has(token) || [...abbreviations].some((abbr) => lastWord(text, abbr));
}

/** Split a finished string into sentence-sized pieces (no trailing partial piece). */
export function splitSentences(text, { maxChars = 280, abbreviations = DEFAULT_ABBREVIATIONS } = {}) {
  return segment(text, { maxChars, abbreviations, allowIncomplete: false })
    .filter((part) => part.complete)
    .map((part) => part.text);
}

/**
 * Segment text into chunks with absolute offsets.
 * Returns `[{ text, complete, start, end }]`; `complete` is false only for the trailing, unfinished
 * fragment when `allowIncomplete` is set.
 */
export function segmentDetailed(text, { maxChars = 280, abbreviations = DEFAULT_ABBREVIATIONS, allowIncomplete = true, offset = 0 } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  let start = 0;
  let index = 0;

  const pushPiece = (raw, rawStart, complete) => {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const textStart = offset + rawStart + leading;
    if (trimmed.length <= maxChars) {
      out.push({ text: trimmed, complete, start: textStart, end: textStart + trimmed.length });
      return;
    }
    // Over-length: cut on a word boundary, never inside a word.
    let consumed = 0;
    let guard = 0;
    while (consumed < trimmed.length && guard < 400) {
      guard += 1;
      const remaining = trimmed.slice(consumed);
      if (remaining.length <= maxChars) {
        out.push({ text: remaining.trim(), complete, start: textStart + consumed, end: textStart + consumed + remaining.trim().length });
        consumed = trimmed.length;
        break;
      }
      const window = remaining.slice(0, maxChars);
      let cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf(', '), window.lastIndexOf('; '));
      if (cut < maxChars * 0.4) cut = maxChars;
      const piece = remaining.slice(0, cut).trim();
      if (piece) out.push({ text: piece, complete: true, start: textStart + consumed, end: textStart + consumed + piece.length });
      consumed += cut;
      while (consumed < trimmed.length && /\s/.test(trimmed[consumed])) consumed += 1;
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (TERMINATORS.has(char)) {
      let end = index + 1;
      while (end < source.length && TERMINATORS.has(source[end])) end += 1;
      while (end < source.length && CLOSERS.has(source[end])) end += 1;
      const next = source[end] || '';
      const boundary = next === '' || /\s/.test(next);
      const sentence = source.slice(start, end);
      const blockingAbbrev = char === '.' && endsWithAbbreviation(sentence, abbreviations);
      const decimal = char === '.' && /\d$/.test(sentence) && /^\d/.test(next);
      if (boundary && !blockingAbbrev && !decimal) {
        pushPiece(sentence, start, true);
        start = end;
        while (start < source.length && /\s/.test(source[start])) start += 1;
        index = start;
        continue;
      }
      index = end;
      continue;
    }
    index += 1;
  }

  const tail = source.slice(start);
  if (tail.trim()) {
    const complete = allowIncomplete ? /[.!?…][\"'”’)\]]*\s*$/.test(tail.trim()) : false;
    pushPiece(tail, start, complete);
  }
  return out;
}

/** Same as `segmentDetailed` without offsets. */
export function segment(text, options = {}) {
  return segmentDetailed(text, options).map(({ text: value, complete }) => ({ text: value, complete }));
}

/**
 * Incremental buffer for live typing.
 *
 * `update(text)` returns only the chunks that became speakable since the previous call, so a
 * keystroke can never re-submit a sentence that is already speaking. Editing text before the
 * emitted offset would invalidate old speech — the controller starts a new generation for that,
 * and this buffer resets itself defensively.
 */
export function createSentenceBuffer({ maxChars = 280, abbreviations = DEFAULT_ABBREVIATIONS } = {}) {
  let text = '';
  let emitted = 0;

  return {
    get text() { return text; },
    update(next) {
      const value = String(next ?? '');
      if (value.slice(0, emitted) !== text.slice(0, emitted)) emitted = 0;
      text = value;
      const parts = segmentDetailed(text.slice(emitted), { maxChars, abbreviations, allowIncomplete: true, offset: emitted });
      const done = parts.filter((part) => part.complete);
      if (done.length) emitted = done[done.length - 1].end;
      return done.map((part) => part.text);
    },
    append(fragment) {
      text += String(fragment ?? '');
      return this.update(text);
    },
    /** Return the unsent remainder (used by Play and by the idle flush). */
    flush() {
      const remainder = text.slice(emitted).trim();
      emitted = text.length;
      return remainder;
    },
    pendingComplete() {
      return segmentDetailed(text.slice(emitted), { maxChars, abbreviations }).filter((part) => part.complete).map((part) => part.text);
    },
    isPending() {
      return text.slice(emitted).trim().length > 0;
    },
    pendingText() {
      return text.slice(emitted).trim();
    },
    reset() {
      text = '';
      emitted = 0;
    },
    get emittedChars() { return emitted; },
  };
}
