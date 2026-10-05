import type { CaptureEntry, LibraryData, SourceEntry } from './db';
import type { Session, SnapshotMeta } from './model';
import { sourceLabel } from './model';
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
  /** Lowercase title and address, the fields searched. */
  haystack: string;
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
        haystack: `${title ?? ''}\n${entry.source.dedup_url}`.toLowerCase(),
      },
    ];
  });
}

/** Rows of the chosen view that contain every word of the query and have the chosen status, in the chosen order. */
export function filterRows(rows: LibraryRow[], filter: LibraryFilter): LibraryRow[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  const key = filter.sort.startsWith('last') ? 'last_captured_at' : 'added_at';
  const direction = filter.sort.endsWith('desc') ? -1 : 1;
  return rows
    .filter(
      (row) =>
        (filter.view === ALL_SOURCES || row.session.id === filter.view) &&
        (filter.status === 'any' || row.status === filter.status) &&
        words.every((word) => row.haystack.includes(word)),
    )
    .sort(
      (a, b) =>
        direction * a[key].localeCompare(b[key]) ||
        a.session.created_at.localeCompare(b.session.created_at) ||
        a.entry.source.number - b.entry.source.number,
    );
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
