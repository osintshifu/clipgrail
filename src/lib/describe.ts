import type { SourceEntry as FullSourceEntry } from './db';
import type { Capture, OkSnapshotMeta, SnapshotMeta } from './model';
import { sourceLabel } from './model';
import type { SourceStatus } from './selection';
import { chooseSnapshot, describeFailure, failedSnapshotOf, okSnapshotOf } from './selection';
import { plural } from './text';

/** Descriptions need only snapshot metadata, so they work for the side panel and the library alike. */
type SourceEntry = FullSourceEntry<SnapshotMeta>;

/** User-facing status names. The status itself always comes from chooseSnapshot(), never from the page title. */
export const STATUS_LABELS: Record<SourceStatus, string> = {
  ok: 'Text saved',
  partial: 'Partial text',
  pending: 'Address only',
  failed: 'Capture failed',
  none: 'Selections only',
};

const KIND_LABELS: Record<Capture['kind'], string> = { page: 'Page', selection: 'Selection', link: 'Link', tab: 'Tab' };

const nf = new Intl.NumberFormat('en-US');
export const fmtNumber = (n: number): string => nf.format(n);

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtBytes(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const selectionCount = (entry: SourceEntry) => entry.captures.filter((c) => c.capture.kind === 'selection').length;

/** Short meta line for the source list, for example "573 chars · 2 captures · 1 selection". */
export function sourceMeta(entry: SourceEntry): string {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  const selections = selectionCount(entry);
  let main = '';
  if (ok && choice.status === 'ok') main = `${fmtNumber(ok.character_count)} chars`;
  else if (ok) main = `${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} chars`;
  else if (failed) main = describeFailure(failed);
  else if (choice.status === 'none') main = plural(selections, 'selection');
  return [
    main,
    entry.captures.length > 1 ? plural(entry.captures.length, 'capture') : '',
    choice.status !== 'none' && selections ? plural(selections, 'selection') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One plain sentence explaining the source status in the source details. */
export function statusSentence(entry: SourceEntry): string {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  if (ok && choice.status === 'ok') {
    const fallback = ok.extraction_method === 'page-text' ? ' · from visible page text, no article found' : '';
    const which = choice.total > 1 ? ` · capture ${choice.position} of ${choice.total}` : '';
    return `Readable text saved ${fmtTime(ok.captured_at)} · ${fmtNumber(ok.character_count)} characters${fallback}${which}.`;
  }
  if (ok) {
    return `Partial text: cut at capture to ${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} characters. Saved ${fmtTime(ok.captured_at)}.`;
  }
  if (choice.status === 'pending') {
    return choice.entry?.capture.kind === 'tab'
      ? 'The tab address was saved without reading the page, so there is no text yet. Open the page and clip it to save its text.'
      : 'The link was saved without opening the page, so there is no text yet. Open the page and clip it to save its text.';
  }
  if (failed) return `Capture ${fmtTime(failed.captured_at)} failed: ${describeFailure(failed)}. No text was saved; the address is kept.`;
  const selections = selectionCount(entry);
  return `No page text. Only ${plural(selections, 'selection')} ${selections === 1 ? 'was' : 'were'} clipped from this page.`;
}

export function captureHead(capture: Capture, index: number): string {
  return `Capture ${index + 1} · ${KIND_LABELS[capture.kind]}`;
}

/** What one capture saved, for the Captures list. */
export function captureLine(capture: Capture, snapshot: SnapshotMeta | undefined): string {
  if (capture.kind === 'selection' && capture.fragment) {
    return `${fmtNumber(capture.fragment.character_count)} characters${capture.fragment.truncated ? ', partial' : ''}`;
  }
  if (snapshot?.status === 'ok') {
    return snapshot.truncated
      ? `Partial text, ${fmtNumber(snapshot.character_count)} of ${fmtNumber(snapshot.original_character_count)} characters`
      : `Text saved, ${fmtNumber(snapshot.character_count)} characters`;
  }
  if (snapshot?.status === 'failed') return `Failed: ${describeFailure(snapshot)}. ${snapshot.error_message}`;
  if (snapshot?.status === 'pending') {
    return capture.kind === 'tab' ? 'Address only (tab saved, not read)' : 'Address only (link saved, not opened)';
  }
  return '';
}

/** Provenance lines of one capture: where a link was found and the address as visited. */
export function captureExtra(capture: Capture, dedupUrl: string): string {
  return [
    capture.kind === 'link'
      ? `Found on ${capture.found_on ?? 'an unknown page'}${capture.anchor_text ? ` · link text “${capture.anchor_text}”` : ''}`
      : '',
    capture.original_url !== dedupUrl ? `Original URL: ${capture.original_url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface DetailRow {
  label: string;
  value: string;
  mono: boolean;
}

/** Rows that describe the source itself, whatever capture is shown. */
export function sourceRows(entry: SourceEntry, sessionName: string): DetailRow[] {
  const { source } = entry;
  return [
    { label: 'Label', value: `${sourceLabel(source)} · assigned in ${sessionName}, never reused`, mono: false },
    { label: 'Address', value: source.dedup_url, mono: true },
    { label: 'Captures', value: `${entry.captures.length} (${entry.captures.map((c) => c.capture.kind).join(', ')})`, mono: false },
  ];
}

/** Rows of one successful snapshot: when it was taken, how, its size and SHA-256. */
function snapshotRows(ok: OkSnapshotMeta): DetailRow[] {
  return [
    { label: 'Snapshot taken', value: fmtTime(ok.captured_at), mono: false },
    {
      label: 'Extraction',
      value:
        ok.extraction_method === 'readability'
          ? 'Readability (article text)'
          : `Visible page text (${(ok.fallback_reason ?? 'fallback').replace(/_/g, ' ')})`,
      mono: false,
    },
    {
      label: 'Characters',
      value: ok.truncated
        ? `${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} (cut at capture)`
        : fmtNumber(ok.character_count),
      mono: false,
    },
    { label: 'SHA-256', value: ok.sha256, mono: true },
  ];
}

/** Technical details of a source, shown on demand. */
export function detailRows(entry: SourceEntry, sessionName: string): DetailRow[] {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  const { source } = entry;
  const rows: DetailRow[] = sourceRows(entry, sessionName);
  if (ok) rows.push(...snapshotRows(ok));
  if (failed) {
    rows.push({
      label: 'Last attempt',
      value: `${fmtTime(failed.captured_at)} · ${describeFailure(failed)}${failed.http_status ? ` (browser reported HTTP ${failed.http_status})` : ''}`,
      mono: false,
    });
  }
  const visited = [...new Set(entry.captures.map((c) => c.capture.original_url))].filter((u) => u !== source.dedup_url);
  if (visited.length) rows.push({ label: 'As visited', value: visited.join('\n'), mono: true });
  return rows;
}

/** Technical details of one capture and what it saved, for reading a single version in the library. */
export function captureDetailRows(capture: Capture, snapshot: SnapshotMeta | undefined, dedupUrl: string): DetailRow[] {
  const rows: DetailRow[] = [{ label: 'Captured', value: `${fmtTime(capture.captured_at)} · ${KIND_LABELS[capture.kind]}`, mono: false }];
  if (capture.original_url !== dedupUrl) rows.push({ label: 'As visited', value: capture.original_url, mono: true });
  if (capture.kind === 'link') {
    rows.push({ label: 'Found on', value: `${capture.found_on ?? 'unknown page'}${capture.anchor_text ? ` · link text “${capture.anchor_text}”` : ''}`, mono: false });
  }
  if (capture.fragment) {
    rows.push(
      { label: 'Characters', value: fmtNumber(capture.fragment.character_count) + (capture.fragment.truncated ? ' (cut at capture)' : ''), mono: false },
      { label: 'SHA-256', value: capture.fragment.sha256, mono: true },
    );
  }
  if (snapshot?.status === 'ok') rows.push(...snapshotRows(snapshot));
  if (snapshot?.status === 'failed') {
    rows.push({
      label: 'Result',
      value: `${describeFailure(snapshot)}${snapshot.http_status ? ` (browser reported HTTP ${snapshot.http_status})` : ''}`,
      mono: false,
    });
  }
  return rows;
}
