/**
 * What changed between two saved texts of a source: paragraphs that stayed the
 * same, and changed paragraphs marked word by word. Texts are only compared,
 * never interpreted.
 */
import { countCharacters } from './text';

/** Unchanged text, or one change: the words removed from the older text and those added in the newer one. */
export type DiffPart = { same: string } | { removed: string; added: string };

export type DiffBlock =
  /** A paragraph found unchanged in both texts. */
  | { kind: 'same'; text: string }
  /** Paragraphs that differ, with each change marked. */
  | { kind: 'changed'; parts: DiffPart[] };

export interface TextDiff {
  blocks: DiffBlock[];
  /** Places where text was removed, added or replaced. */
  changes: number;
  added: number;
  removed: number;
}

/** Above this many removed and added paragraphs the texts are too different to mark. */
export const MAX_PARAGRAPH_EDITS = 2000;
/** Changed paragraphs above these sizes are shown as removed and added whole, not word by word. */
const MAX_WORD_EDITS = 2000;
const MAX_WORD_TOKENS = 40_000;

/**
 * Whole emoji; characters of scripts written without spaces, each with its
 * marks; words (with inner marks, so "09:12", "4,000" and "e-mail" stay
 * whole); runs of white space; and single punctuation marks with their marks.
 */
const TOKEN =
  /\p{RGI_Emoji}|[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]\p{M}*|[[\p{L}\p{M}\p{N}]--[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]]+(?:[.:,'’\/\-][[\p{L}\p{M}\p{N}]--[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]]+)*|\s+|[^\p{L}\p{M}\p{N}\s]\p{M}*/gv;

type Edit = ['=' | '-' | '+', string];

/** Compares the older text with the newer one, or returns null when they differ in too many paragraphs to mark. */
export function compareTexts(older: string, newer: string): TextDiff | null {
  const edits = diffItems(older.split('\n\n'), newer.split('\n\n'), MAX_PARAGRAPH_EDITS);
  if (!edits) return null;
  const diff: TextDiff = { blocks: [], changes: 0, added: 0, removed: 0 };
  for (let i = 0; i < edits.length; ) {
    if (edits[i]![0] === '=') {
      diff.blocks.push({ kind: 'same', text: edits[i]![1] });
      i++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    for (; i < edits.length && edits[i]![0] !== '='; i++) (edits[i]![0] === '-' ? removed : added).push(edits[i]![1]);
    diff.blocks.push({ kind: 'changed', parts: changedParts(removed.join('\n\n'), added.join('\n\n'), diff) });
  }
  return diff;
}

/** The changes between the removed and the added paragraphs of one place, word by word when that is affordable. */
function changedParts(removed: string, added: string, diff: TextDiff): DiffPart[] {
  const whole = (): DiffPart[] => {
    diff.changes += 1;
    diff.removed += countCharacters(removed);
    diff.added += countCharacters(added);
    return [{ removed, added }];
  };
  if (!removed || !added) return whole();
  const a = removed.match(TOKEN) ?? [];
  const b = added.match(TOKEN) ?? [];
  const edits = a.length + b.length <= MAX_WORD_TOKENS ? diffItems(a, b, MAX_WORD_EDITS) : null;
  if (!edits) return whole();
  for (const [kind, token] of edits) {
    if (kind === '-') diff.removed += countCharacters(token);
    if (kind === '+') diff.added += countCharacters(token);
  }
  // One change runs from a removed or added word to the next unchanged word; spaces (not a line break) between two changes join them.
  const parts: DiffPart[] = [];
  let change: { removed: string; added: string } | null = null;
  for (let i = 0; i < edits.length; i++) {
    const [kind, token] = edits[i]!;
    const next = edits[i + 1];
    if (kind === '=' && change && /^[^\S\n]+$/.test(token) && next && next[0] !== '=') {
      change.removed += token;
      change.added += token;
    } else if (kind === '=') {
      change = null;
      const last = parts.at(-1);
      if (last && 'same' in last) last.same += token;
      else parts.push({ same: token });
    } else {
      if (!change) {
        change = { removed: '', added: '' };
        parts.push(change);
        diff.changes += 1;
      }
      if (kind === '-') change.removed += token;
      else change.added += token;
    }
  }
  return parts;
}

/** The edits that turn a into b, shortest first (Myers), or null when more than maxEdits are needed. */
function diffItems(a: string[], b: string[], maxEdits: number): Edit[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // Items are compared as numbers: equal strings get the same number.
  const ids = new Map<string, number>();
  const idOf = (item: string) => ids.get(item) ?? (ids.set(item, ids.size), ids.size - 1);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA.map(idOf), midB.map(idOf), maxEdits);
  if (!middle) return null;
  return [
    ...a.slice(0, start).map((item): Edit => ['=', item]),
    ...middle.map(([kind, index]): Edit => [kind, kind === '+' ? midB[index]! : midA[index]!]),
    ...a.slice(endA).map((item): Edit => ['=', item]),
  ];
}

/** Myers' shortest edit script as [kind, index into a (= and -) or b (+)], or null beyond maxEdits. */
function myers(a: number[], b: number[], maxEdits: number): Array<['=' | '-' | '+', number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds the furthest x on diagonals -d-1..d+1 before step d, for walking back.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return walkBack(trace, n, m);
    }
  }
  return null;
}

function walkBack(trace: Int32Array[], n: number, m: number): Array<['=' | '-' | '+', number]> {
  const edits: Array<['=' | '-' | '+', number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push(['=', x]);
    }
    // The step into this point: down is a word added from b, right a word removed from a.
    if (d > 0) edits.push(x === prevX ? ['+', y - 1] : ['-', x - 1]);
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}
