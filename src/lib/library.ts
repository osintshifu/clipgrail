import type { CaptureEntry, LibraryData, SourceEntry } from './db';
import type { Fragment, Session, SnapshotMeta } from './model';
import { sourceLabel } from './model';
import type { SearchQuery, Snippet, TextHit } from './search';
import { fold, inDays, onSite, parseSearch, snippetOf } from './search';
import type { SourceStatus } from './selection';
import { capturedTitle, chooseSnapshot } from './selection';

/** A source as the library reads it: captures with snapshot metadata, texts loaded on demand. */
export type LibraryEntry = SourceEntry<SnapshotMeta>;

export interface LibraryRow {
  entry: LibraryEntry;
  session: Session;
  /** S-number within the source's own session. Shown with the session name wherever sessions are mixed. */
  label: string;
  title: string | null;
  status: SourceStatus;
  /** Time of the newest capture. */
  last_captured_at: string;
  /** When the source was first saved. */
  added_at: string;
  /** Title and address folded for search (see fold): what the list shows of a source. */
  haystack: string;
  /** Host of the address, for site:. */
  host: string;
}

export type LibrarySort = 'last-desc' | 'last-asc' | 'added-desc' | 'added-asc';

export const SORT_LABELS: Record<LibrarySort, string> = {
  'last-desc': 'Last capture, newest',
  'last-asc': 'Last capture, oldest',
  'added-desc': 'Date added, newest',
  'added-asc': 'Date added, oldest',
};

/** The view shown in the library: a session or all sources, narrowed by a search and a status. */
export interface LibraryFilter {
  /** 'all' or a session ID. */
  view: string;
  query: string;
  status: SourceStatus | 'any';
  sort: LibrarySort;
}

export const ALL_SOURCES = 'all';

export function libraryRows(data: LibraryData): LibraryRow[] {
  const sessions = new Map(data.sessions.map((s) => [s.id, s]));
  return data.sources.flatMap((entry) => {
    const session = sessions.get(entry.source.session_id);
    if (!session) return [];
    const title = capturedTitle(entry);
    const last = entry.captures.reduce((max, c) => (c.capture.captured_at > max ? c.capture.captured_at : max), entry.source.created_at);
    return [
      {
        entry,
        session,
        label: sourceLabel(entry.source),
        title,
        status: chooseSnapshot(entry).status,
        last_captured_at: last,
        added_at: entry.source.created_at,
        haystack: fold(`${title ?? ''}\n${entry.source.dedup_url}`),
        host: hostname(entry.source.dedup_url),
      },
    ];
  });
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A search word such as "s3" also finds the source with that label. */
const LABEL_WORD = /^s[1-9]\d*$/;

/** Saved texts a search has read, by snapshot ID: the terms each contains and a passage around the first. */
export type TextHits = Map<string, TextHit>;

/** Selections are kept while the library is open, so each is folded once. */
const foldedFragments = new WeakMap<Fragment, string>();
function foldedFragment(fragment: Fragment): string {
  let folded = foldedFragments.get(fragment);
  if (folded === undefined) foldedFragments.set(fragment, (folded = fold(fragment.text)));
  return folded;
}

interface Field {
  where: string;
  text: string;
  folded: string;
  /** The capture the field belongs to; null for the source note. */
  capture_id: string | null;
}

/** Notes and selections of a source, newest capture first: the parts a search finds that the list does not show. */
function fieldsOf(entry: LibraryEntry): Field[] {
  const fields: Field[] = [];
  if (entry.source.note) fields.push({ where: 'Note', text: entry.source.note, folded: fold(entry.source.note), capture_id: null });
  const captures = [...entry.captures].reverse();
  for (const { capture } of captures) if (capture.note) fields.push({ where: 'Note', text: capture.note, folded: fold(capture.note), capture_id: capture.id });
  for (const { capture } of captures) {
    if (capture.fragment) fields.push({ where: 'Selection', text: capture.fragment.text, folded: foldedFragment(capture.fragment), capture_id: capture.id });
  }
  return fields;
}

/** IDs of the successful snapshots of a source: the saved texts a search reads. */
export function textIdsOf(entry: LibraryEntry): string[] {
  return entry.captures.flatMap((c) => (c.snapshot?.status === 'ok' ? [c.snapshot.id] : []));
}

function shownTerm(row: LibraryRow, term: string): boolean {
  return row.haystack.includes(term) || (LABEL_WORD.test(term) && row.label.toLowerCase() === term);
}

function matches(row: LibraryRow, query: SearchQuery, hits: TextHits | undefined): boolean {
  if (!onSite(row.host, query.sites)) return false;
  if ((query.after !== null || query.before !== null) && !row.entry.captures.some((c) => inDays(c.capture.captured_at, query))) return false;
  const hidden = query.terms.filter((term) => !shownTerm(row, term));
  if (!hidden.length) return true;
  const fields = fieldsOf(row.entry);
  const textHits = hits ? textIdsOf(row.entry).flatMap((id) => hits.get(id) ?? []) : [];
  return hidden.every((term) => fields.some((f) => f.folded.includes(term)) || textHits.some((hit) => hit.terms.has(term)));
}

/**
 * Rows of the chosen view that contain every word and phrase of the search,
 * pass its site:, after: and before:, and have the chosen status, in the
 * chosen order. Saved texts count once a search has read them (hits).
 */
export function filterRows(rows: LibraryRow[], filter: LibraryFilter, hits?: TextHits): LibraryRow[] {
  const query = parseSearch(filter.query);
  const key = filter.sort.startsWith('last') ? 'last_captured_at' : 'added_at';
  const direction = filter.sort.endsWith('desc') ? -1 : 1;
  return rows
    .filter(
      (row) =>
        (filter.view === ALL_SOURCES || row.session.id === filter.view) &&
        (filter.status === 'any' || row.status === filter.status) &&
        matches(row, query, hits),
    )
    .sort(
      (a, b) =>
        direction * a[key].localeCompare(b[key]) ||
        a.session.created_at.localeCompare(b.session.created_at) ||
        a.entry.source.number - b.entry.source.number,
    );
}

/** Where a search found a source, beyond what the list shows: the passage to show under it, and the capture to open. */
export interface SearchSnippet {
  where: string;
  snippet: Snippet;
  capture_id: string | null;
}

/** Notes come first, then selections, then the current saved text and earlier texts, newest first. */
export function searchSnippet(row: LibraryRow, query: SearchQuery, hits: TextHits | undefined): SearchSnippet | null {
  const terms = query.terms;
  if (terms.every((term) => shownTerm(row, term))) return null;
  for (const field of fieldsOf(row.entry)) {
    const snippet = snippetOf(field.text, field.folded, terms);
    if (snippet) return { where: field.where, snippet, capture_id: field.capture_id };
  }
  if (!hits) return null;
  const versions = versionsOf(row.entry);
  for (const version of [...versions.filter((v) => v.current), ...versions.filter((v) => !v.current)]) {
    const snapshot = version.capture.snapshot;
    const hit = snapshot?.status === 'ok' ? hits.get(snapshot.id) : undefined;
    if (hit) {
      return version.current
        ? { where: 'Saved text', snippet: hit.snippet, capture_id: null }
        : { where: `Earlier text · capture ${version.number}`, snippet: hit.snippet, capture_id: version.capture.capture.id };
    }
  }
  return null;
}

export interface Version {
  capture: CaptureEntry<SnapshotMeta>;
  /** 1-based position among the source's captures, oldest first, as in the side panel. */
  number: number;
  /** True for the capture whose text the Research Job uses: the latest successful snapshot. */
  current: boolean;
}

/** The captures of a source newest first, with the one whose text Research Jobs use marked. */
export function versionsOf(entry: LibraryEntry): Version[] {
  const choice = chooseSnapshot(entry);
  const currentId = choice.status === 'ok' || choice.status === 'partial' ? choice.entry?.capture.id : undefined;
  return entry.captures
    .map((capture, i) => ({ capture, number: i + 1, current: capture.capture.id === currentId }))
    .reverse();
}
