/**
 * Library search: words and "phrases" that must all appear in a source, and
 * site:, after: and before: qualifiers that narrow the results. Matching
 * ignores case and diacritics, so "zrodlo" finds "Źródło".
 */

export interface SearchQuery {
  /** Folded words and phrases; every one must appear somewhere in the source. */
  terms: string[];
  /** Hosts from site:; a source on any of them or on their subdomains matches. */
  sites: string[];
  /** Local days (YYYY-MM-DD) from after: and before:, both included. */
  after: string | null;
  before: string | null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().startsWith(value);
}

/** The host a site: value names: without scheme, port, path or a trailing dot. */
function siteHost(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split(/[/?#]/, 1)[0]
      ?.replace(/:\d*$/, '')
      .replace(/\.$/, '') ?? ''
  );
}

/** A qualifier with a value it cannot use (after:yesterday) stays an ordinary word, so the search finds nothing rather than more. */
export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = { terms: [], sites: [], after: null, before: null };
  for (const [, phrase, word] of input.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (phrase !== undefined) {
      const term = fold(phrase.replace(/\s+/g, ' ').trim());
      if (term) query.terms.push(term);
      continue;
    }
    const qualifier = /^(site|after|before):(.+)$/i.exec(word!);
    if (qualifier) {
      const key = qualifier[1]!.toLowerCase();
      const value = qualifier[2]!;
      if (key === 'site' && siteHost(value)) {
        query.sites.push(siteHost(value));
        continue;
      }
      if ((key === 'after' || key === 'before') && isDay(value)) {
        query[key] = value;
        continue;
      }
    }
    query.terms.push(fold(word!));
  }
  return query;
}

export function onSite(host: string, sites: string[]): boolean {
  return sites.length === 0 || sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** The local day (YYYY-MM-DD) of an ISO time. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function inDays(iso: string, query: Pick<SearchQuery, 'after' | 'before'>): boolean {
  const day = localDay(iso);
  return (query.after === null || day >= query.after) && (query.before === null || day <= query.before);
}

/** Letters with no decomposition into a base letter and a mark. */
const BASE_LETTERS: Record<string, string> = { ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ı: 'i' };
const foldedChars = new Map<string, string>();

function foldChar(ch: string): string {
  let folded = foldedChars.get(ch);
  if (folded === undefined) {
    const base = /\s/.test(ch) ? ' ' : (BASE_LETTERS[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, ''));
    folded = base.length === 1 ? base : ch;
    foldedChars.set(ch, folded);
  }
  return folded;
}

/**
 * Lower case without diacritics, with every kind of white space as a plain
 * space. Every character keeps its position, so a match found in the folded
 * text is at the same place in the original.
 */
export function fold(text: string): string {
  const lower = text.toLowerCase();
  // A few letters lower-case into two characters (İ); those keep their case.
  if (lower.length !== text.length) return text.replace(/[\s\S]/g, (ch) => (ch.toLowerCase().length === 1 ? foldChar(ch.toLowerCase()) : ch));
  return lower.replace(/[^\x20-\x7e]/g, foldChar);
}

/** Start and end of the matches of the terms in a folded text (at most `limit` per term), in order, overlapping matches joined. */
export function termRanges(folded: string, terms: string[], limit = Infinity): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const term of terms) {
    let n = 0;
    for (let i = folded.indexOf(term); i >= 0 && n < limit; i = folded.indexOf(term, i + term.length), n++) found.push([i, i + term.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const range of found) {
    const last = joined.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else joined.push(range);
  }
  return joined;
}

/** A short passage from a text, with the matched terms marked (positions within `text`). */
export interface Snippet {
  text: string;
  marks: Array<[number, number]>;
  /** True when text was left out before or after the passage. */
  cut_before: boolean;
  cut_after: boolean;
}

const BEFORE = 60;
const AFTER = 180;

/** The passage around the first term found in the text, or null when none is in it. */
export function snippetOf(text: string, folded: string, terms: string[]): Snippet | null {
  let first = -1;
  for (const term of terms) {
    const i = folded.indexOf(term);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) return null;
  let start = Math.max(0, first - BEFORE);
  let end = Math.min(text.length, first + AFTER);
  // Start after a space and never split a character written as two code units.
  if (start > 0) {
    const space = folded.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return {
    text: text.slice(start, end).replace(/\s/g, ' '),
    marks: termRanges(folded.slice(start, end), terms),
    cut_before: start > 0,
    cut_after: end < text.length,
  };
}

/** What a search found in one saved text: the terms it contains and the passage around the first. */
export interface TextHit {
  terms: Set<string>;
  snippet: Snippet;
}

export function textHit(text: string, terms: string[]): TextHit | null {
  const folded = fold(text);
  const found = new Set(terms.filter((term) => folded.includes(term)));
  if (!found.size) return null;
  return { terms: found, snippet: snippetOf(text, folded, [...found])! };
}
