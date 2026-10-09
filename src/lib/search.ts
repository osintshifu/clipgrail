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

import { isOnSite, siteHost } from './url';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().startsWith(value);
}

/** A qualifier with a value it cannot use (after:yesterday) stays an ordinary word, so the search finds nothing rather than more. */
export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = { terms: [], sites: [], after: null, before: null };
  for (const [, phrase, word] of searchable(input).matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (phrase !== undefined) {
      const term = fold(phrase.replace(/\s+/g, ' ').trim());
      if (term) query.terms.push(term);
      continue;
    }
    const qualifier = /^(site|after|before):(.+)$/i.exec(word!);
    if (qualifier) {
      const key = qualifier[1]!.toLowerCase();
      const value = qualifier[2]!;
      const site = key === 'site' ? siteHost(value) : null;
      if (site) {
        query.sites.push(site);
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
  return sites.length === 0 || sites.some((site) => isOnSite(host, site));
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

/**
 * Text in the composed Unicode form, as typed: a page may store "ź" as "z"
 * and a separate accent. Search matches and passages use this form; it looks
 * the same on screen.
 */
export function searchable(text: string): string {
  return text.normalize('NFC');
}

/** Letters with no decomposition into a base letter and a mark, and the Greek final sigma. */
const BASE_LETTERS: Record<string, string> = { ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ı: 'i', ς: 'σ' };
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
  // İ is the one letter that lower-cases into two characters; as I it keeps its place.
  return text.replace(/\u0130/g, 'I').toLowerCase().replace(/[^\x20-\x7e]/g, foldChar);
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

/**
 * Matches of the terms in a text as stored (see termRanges). A text that
 * stores accents as separate characters is searched in the composed form and
 * the matches are mapped back, so the text itself is shown unchanged.
 */
export function storedRanges(text: string, terms: string[], limit = Infinity): Array<[number, number]> {
  if (searchable(text) === text) return termRanges(fold(text), terms, limit);
  let composed = '';
  // Position in `text` of every code unit of `composed`, and the end.
  const at: number[] = [];
  for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const part = searchable(match[0]);
    for (let k = 0; k < part.length; k++) at.push(match.index + Math.min(k, match[0].length - 1));
    composed += part;
  }
  at.push(text.length);
  return termRanges(fold(composed), terms, limit).map(([start, end]) => [at[start]!, at[end]!]);
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

/**
 * The passage around the first of the anchor terms found in the text, with
 * every term marked, or null when no anchor term is in it.
 */
export function snippetOf(text: string, folded: string, terms: string[], anchors = terms): Snippet | null {
  let first = -1;
  for (const term of anchors) {
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

/** What a search found in one saved text: the terms it contains and, for each, the passage around it. */
export interface TextHit {
  terms: Set<string>;
  snippets: Map<string, Snippet>;
}

export function textHit(text: string, terms: string[]): TextHit | null {
  const composed = searchable(text);
  const folded = fold(composed);
  const found = terms.filter((term) => folded.includes(term));
  if (!found.length) return null;
  return { terms: new Set(found), snippets: new Map(found.map((term) => [term, snippetOf(composed, folded, found, [term])!])) };
}
