import type { CaptureEntry, SourceEntry } from './db';
import type { CaptureFrame, FailedSnapshot, SnapshotMeta } from './model';
import { isCapturableUrl } from './url';

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

/**
 * The latest failed attempt to read the page, when it came after the
 * successful snapshot in use: the page may have changed or gone since.
 */
export function laterFailureOf<S extends SnapshotMeta>(source: SourceEntry<S>, choice: SnapshotChoice<S>): FailedSnapshot | undefined {
  if (choice.status !== 'ok' && choice.status !== 'partial') return undefined;
  for (let i = source.captures.length - 1; i >= choice.position; i--) {
    const snapshot = source.captures[i]?.snapshot;
    if (snapshot?.status === 'failed') return snapshot as FailedSnapshot;
  }
  return undefined;
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
  text_missing: 'saved text missing',
};

/** Short description of a failed snapshot. "HTTP 404" only when the browser reported that status. */
export function describeFailure(snapshot: FailedSnapshot): string {
  if (snapshot.error_code === 'http_error' && snapshot.http_status) return `HTTP ${snapshot.http_status}`;
  return ERROR_LABELS[snapshot.error_code];
}

/** True for a selection made in an embedded frame without an http or https address: its source URL is not established. */
export function frameSourceUnestablished(frame: CaptureFrame | null): boolean {
  return frame !== null && !(frame.url !== null && isCapturableUrl(frame.url));
}

/** Shown with such a selection wherever it appears, Research Jobs included, whatever their private options. */
export const FRAME_UNESTABLISHED_NOTE = 'Selected in an embedded frame. Its source URL could not be established; the parent page is recorded as context.';
