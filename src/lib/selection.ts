import type { CaptureEntry, SourceEntry } from './db';
import type { FailedSnapshot, SnapshotMeta } from './model';

/**
 * Display status of a source, from its best snapshot:
 * ok / partial (latest successful snapshot, complete or truncated), else the
 * latest attempt: failed / pending, or none when only selections exist.
 */
export type SourceStatus = 'ok' | 'partial' | 'failed' | 'pending' | 'none';

export interface SnapshotChoice<S extends SnapshotMeta = SnapshotMeta> {
  status: SourceStatus;
  /** Capture whose snapshot was chosen (undefined when status is none). */
  entry: CaptureEntry<S> | undefined;
  /** 1-based position of that capture among all captures of the source, oldest first. */
  position: number;
  total: number;
}

/**
 * The snapshot shown and used for a source: the latest successful one;
 * if none succeeded, the latest attempt so its failure or pending state stays visible.
 */
export function chooseSnapshot<S extends SnapshotMeta>(source: SourceEntry<S>): SnapshotChoice<S> {
  const total = source.captures.length;
  let latestAttempt: { entry: CaptureEntry<S>; position: number } | undefined;
  for (let i = total - 1; i >= 0; i--) {
    const entry = source.captures[i];
    if (!entry?.snapshot) continue;
    if (entry.snapshot.status === 'ok') {
      return { status: entry.snapshot.truncated ? 'partial' : 'ok', entry, position: i + 1, total };
    }
    latestAttempt ??= { entry, position: i + 1 };
  }
  if (!latestAttempt) return { status: 'none', entry: undefined, position: 0, total };
  const status = latestAttempt.entry.snapshot?.status === 'failed' ? 'failed' : 'pending';
  return { status, entry: latestAttempt.entry, position: latestAttempt.position, total };
}

/** The chosen successful snapshot: with its text when the entries carry texts, else its metadata. */
export function okSnapshotOf<S extends SnapshotMeta>(choice: SnapshotChoice<S>): Extract<S, { status: 'ok' }> | undefined {
  const snapshot = choice.entry?.snapshot;
  return snapshot?.status === 'ok' ? (snapshot as Extract<S, { status: 'ok' }>) : undefined;
}

export function failedSnapshotOf(choice: SnapshotChoice): FailedSnapshot | undefined {
  const snapshot = choice.entry?.snapshot;
  return snapshot?.status === 'failed' ? snapshot : undefined;
}

/** Display title: title of the chosen successful snapshot, else the latest tab title, else null. */
export function capturedTitle(source: SourceEntry<SnapshotMeta>): string | null {
  const ok = okSnapshotOf(chooseSnapshot(source));
  if (ok?.title) return ok.title;
  for (let i = source.captures.length - 1; i >= 0; i--) {
    const title = source.captures[i]?.capture.tab_title.trim();
    if (title) return title;
  }
  return null;
}

const ERROR_LABELS: Record<FailedSnapshot['error_code'], string> = {
  page_unavailable: 'page unavailable',
  http_error: 'HTTP error',
  empty_text: 'no readable text',
  extraction_error: 'extraction error',
  timeout: 'timed out',
};

/** Short description of a failed snapshot. "HTTP 404" only when the browser reported that status. */
export function describeFailure(snapshot: FailedSnapshot): string {
  if (snapshot.error_code === 'http_error' && snapshot.http_status) return `HTTP ${snapshot.http_status}`;
  return ERROR_LABELS[snapshot.error_code];
}
