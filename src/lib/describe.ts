import type { CaptureEntry, DataSummary, DeletionCounts, SourceEntry as FullSourceEntry } from './db';
import type { Capture, CaptureNavigation, DeclaredField, OkSnapshotMeta, Removal, RemovalAction, SnapshotMeta, TrackerKind, TrackerPlace } from './model';
import { sourceLabel } from './model';
import type { SourceStatus } from './selection';
import { FRAME_UNESTABLISHED_NOTE, chooseSnapshot, describeFailure, failedSnapshotOf, frameSourceUnestablished, laterFailureOf, okSnapshotOf } from './selection';
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

const KIND_LABELS: Record<Capture['kind'], string> = { page: 'Page', selection: 'Selection', link: 'Link', tab: 'Tab', visit: 'Visit' };

/** Chrome's transition types in words (webNavigation transitionType). */
const TRANSITION_WORDS: Record<string, string> = {
  link: 'Link',
  form_submit: 'Form',
  typed: 'Typed address',
  generated: 'Address bar suggestion',
  keyword: 'Address bar keyword',
  keyword_generated: 'Address bar keyword',
  auto_bookmark: 'Bookmark or browser menu',
  start_page: 'Start page',
};

/** How a recorded page was reached, in words, or null when it was not recorded. The first matching rule wins. */
export function navigationWords(navigation: CaptureNavigation | null): string | null {
  if (!navigation) return null;
  const { transition, qualifiers, in_page } = navigation;
  let words: string;
  if (qualifiers.includes('forward_back')) words = 'Back or Forward';
  else if (in_page) words = 'Address changed by the page';
  else if (transition === 'reload') words = 'Reload or reopened tab';
  else if (qualifiers.includes('client_redirect')) words = 'Redirect by the page';
  // Anything started from the address bar is entered there, whatever type Chrome gives it.
  else if (qualifiers.includes('from_address_bar') && (transition === 'link' || transition === 'form_submit')) words = TRANSITION_WORDS.typed!;
  else words = TRANSITION_WORDS[transition] ?? `Other (Chrome: ${transition})`;
  return qualifiers.includes('server_redirect') ? `${words}, redirected by the server` : words;
}

const nf = new Intl.NumberFormat('en-US');
export const fmtNumber = (n: number): string => nf.format(n);

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Megabytes (10^6 bytes) with at most one decimal, for backup sizes. */
export function fmtMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
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
    laterFailureOf(entry, choice) ? 'latest attempt failed' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One plain sentence explaining the source status in the source details. */
export function statusSentence(entry: SourceEntry): string {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  const later = laterFailureOf(entry, choice);
  const laterText = later ? ` Latest attempt ${fmtTime(later.captured_at)} failed: ${describeFailure(later)}.` : '';
  if (ok && choice.status === 'ok') {
    const fallback = ok.extraction_method === 'page-text' ? ' · from visible page text, no article found' : '';
    const which = choice.total > 1 ? ` · capture ${choice.position} of ${choice.total}` : '';
    return `Readable text saved ${fmtTime(ok.captured_at)} · ${fmtNumber(ok.character_count)} characters${fallback}${which}.${laterText}`;
  }
  if (ok) {
    return `Partial text: cut at capture to ${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} characters. Saved ${fmtTime(ok.captured_at)}.${laterText}`;
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

export interface TextComparison {
  /** True when the earlier capture saved exactly the same text (same SHA-256). */
  same: boolean;
  /** The latest earlier capture with the same text, else the nearest earlier capture with text. */
  earlier: Capture;
  /** Its number in the Captures list. */
  number: number;
}

/**
 * How each capture with saved page text after the first compares with an earlier one, keyed by capture id.
 * Captures are oldest first and numbered as in the Captures list.
 */
export function textComparisons(captures: Array<CaptureEntry<SnapshotMeta>>): Map<string, TextComparison> {
  const compared = new Map<string, TextComparison>();
  const earlier: Array<{ capture: Capture; number: number; sha256: string }> = [];
  captures.forEach(({ capture, snapshot }, i) => {
    if (snapshot?.status !== 'ok') return;
    const same = earlier.findLast((e) => e.sha256 === snapshot.sha256);
    const match = same ?? earlier.at(-1);
    if (match) compared.set(capture.id, { same: !!same, earlier: match.capture, number: match.number });
    earlier.push({ capture, number: i + 1, sha256: snapshot.sha256 });
  });
  return compared;
}

/** "Same text as capture 2" or "Text differs from capture 2", for the Captures lists. */
export function comparisonLine(comparison: TextComparison): string {
  // A no-break space keeps the number on the line of the word "capture".
  return `${comparison.same ? 'Same text as' : 'Text differs from'} capture\u00a0${comparison.number}`;
}

/** What the capture says about an embedded frame it was selected in, or null. */
function frameLine(capture: Capture): string | null {
  if (!capture.frame) return null;
  return frameSourceUnestablished(capture.frame) ? FRAME_UNESTABLISHED_NOTE : 'Selected in an embedded frame';
}

/** Provenance lines of one capture: an embedded frame, how a recorded page was reached, where a saved link, a recorded page or a frame was found, and the address as visited. */
export function captureExtra(capture: Capture, dedupUrl: string): string {
  const reached = navigationWords(capture.navigation);
  return [
    frameLine(capture) ?? '',
    reached ? `Reached by: ${reached}` : '',
    capture.kind === 'link'
      ? `Found on ${capture.found_on ?? 'an unknown page'}${capture.anchor_text ? ` · link text “${capture.anchor_text}”` : ''}`
      : capture.found_on
        ? `Found on ${capture.found_on}`
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
  const reached = navigationWords(capture.navigation);
  if (reached) rows.push({ label: 'Reached by', value: reached, mono: false });
  if (capture.kind === 'link') {
    rows.push({ label: 'Found on', value: `${capture.found_on ?? 'unknown page'}${capture.anchor_text ? ` · link text “${capture.anchor_text}”` : ''}`, mono: false });
  } else if (capture.found_on) {
    rows.push({ label: 'Found on', value: capture.found_on, mono: false });
  }
  const frame = frameLine(capture);
  if (frame) {
    const address = capture.frame?.url && frameSourceUnestablished(capture.frame) ? ` Frame address: ${capture.frame.url}` : '';
    rows.push({ label: 'Frame', value: frame + address, mono: false });
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

// ---------- Page code ----------

export const DECLARED_LABELS: Record<DeclaredField, string> = {
  site_name: 'Site name',
  author: 'Author',
  publisher: 'Publisher',
  published: 'Published',
  type: 'Type',
  x_account: 'X account',
  canonical: 'Canonical',
  generator: 'Generator',
};
export const TRACKER_LABELS: Record<TrackerKind, string> = {
  ga4: 'Google Analytics 4',
  google_tag: 'Google tag',
  ua: 'Google Analytics (Universal)',
  gtm: 'Google Tag Manager',
  meta_pixel: 'Meta Pixel',
  adsense: 'Google AdSense',
};
export const PLACE_WORDS: Record<TrackerPlace, string> = {
  script_address: 'script address',
  inline_script: 'inline script',
  noscript: 'noscript frame',
  ad_tag: 'ad tag',
  image: 'tracking image',
  amp_tag: 'AMP analytics tag',
};

export const PAGE_CODE_NOTE =
  "Read from the page code when the page was clipped; not part of the saved text or its SHA-256. A tracker that loads only after cookie consent, or runs on the website's server, is not seen: no tracker listed does not mean the page does not track.";

export interface PageCodeRow {
  label: string;
  value: string;
  /** Where the value was read: the tags it was declared in, or where a tracker ID was found. */
  from: string;
  mono: boolean;
}

export interface PageCodeView {
  /** "Declared by the page", or for a capture without page code what Readability read with the text, which may come from the visible text. */
  declaredTitle: string;
  declared: PageCodeRow[];
  /** Null when the page code was not read for the capture. */
  trackers: PageCodeRow[] | null;
  note: string;
}

/**
 * What the page code said at a capture, for its details. A page or selection
 * clipped before the page code was read shows what Readability read with the
 * text instead. Null for captures that never read the page.
 */
export function pageCodeView(capture: Capture, snapshot: SnapshotMeta | undefined): PageCodeView | null {
  const code = capture.page_code;
  if (code) {
    return {
      declaredTitle: 'Declared by the page',
      declared: code.declared.map((d) => ({ label: DECLARED_LABELS[d.field], value: d.value, from: d.from.join(', '), mono: false })),
      trackers: code.trackers.map((t) => ({ label: TRACKER_LABELS[t.kind], value: t.id, from: t.where.map((w) => PLACE_WORDS[w]).join(', '), mono: true })),
      note: PAGE_CODE_NOTE,
    };
  }
  if (capture.kind !== 'page' && capture.kind !== 'selection') return null;
  const ok = snapshot?.status === 'ok' ? snapshot : null;
  const read: Array<[string, string | null | undefined]> = [
    ['Site name', ok?.site_name],
    ['Author', ok?.byline],
    ['Published', ok?.published_time],
    ['Canonical', ok?.canonical_url],
  ];
  const declared = read.flatMap(([label, value]) => (value ? [{ label, value, from: '', mono: false }] : []));
  return {
    declaredTitle: 'Read with the text by Readability',
    declared,
    trackers: null,
    note: 'The page code was not read for this capture: it was made before ClipGrail read page code, or the page could not be read in time.',
  };
}

/** The capture whose page code the side panel shows: the newest that read it, else the one with the current text. */
export function pageCodeCapture(entry: SourceEntry): { capture: Capture; snapshot: SnapshotMeta | undefined; number: number } | null {
  const numbered = entry.captures.map((c, i) => ({ ...c, number: i + 1 }));
  const read = numbered.filter((c) => c.capture.page_code).at(-1);
  if (read) return read;
  const current = okSnapshotOf(chooseSnapshot(entry));
  return numbered.find((c) => current && c.snapshot === current) ?? null;
}

/** The values and tracker IDs of a capture's page code as one text, for search; field names are left out so they are not found. */
export function pageCodeText(capture: Capture): string {
  const code = capture.page_code;
  if (!code) return '';
  return [...code.declared.map((d) => d.value), ...code.trackers.map((t) => t.id)].join(' · ');
}

// ---------- Deleting data ----------

/** Confirmation text: what is deleted (main) and what deleting cannot reach plus the last backup (small). */
export interface DeletionText {
  main: string[];
  small: string[];
}

export const NOT_AFFECTED = 'Copies you exported, pasted into a chat or saved in a backup are not affected.';

/** "Last backup: …" or "No backup yet"; the date is when the backup file was handed to Chrome. */
export function backupLine(lastBackupAt: string | null): string {
  return lastBackupAt ? `Last backup: ${fmtTime(lastBackupAt)}` : 'No backup yet';
}

export function sourceDeletionText(label: string, name: string, counts: DeletionCounts, lastBackupAt: string | null): DeletionText {
  const what = counts.captures === 1 ? 'its capture, saved text and notes' : `its ${counts.captures} captures, saved texts and notes`;
  const jobs =
    counts.jobs === 1
      ? `1 Research Job that includes ${label} is deleted too.`
      : `${counts.jobs} Research Jobs that include ${label} are deleted too.`;
  return {
    main: [`"${name}" is deleted with ${what}. ${label} is not given to another source.`, counts.jobs ? jobs : '', 'Its label, title and address stay in the deletion log.'].filter(Boolean),
    small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`],
  };
}

/** "S1, S2 and S4", or the first five and how many more. */
function labelList(labels: string[]): string {
  const first = labels.slice(0, 5);
  const more = labels.length - first.length;
  if (more > 0) return `${first.join(', ')} and ${more} more`;
  return first.length > 1 ? `${first.slice(0, -1).join(', ')} and ${first.at(-1)}` : (first[0] ?? '');
}

/** Several sources: their labels when they share a session, else how many sessions they come from. */
export function sourcesDeletionText(labels: string[], sessionCount: number, counts: DeletionCounts, lastBackupAt: string | null): DeletionText {
  const who = sessionCount === 1 ? labelList(labels) : `${plural(labels.length, 'source')} from ${plural(sessionCount, 'session')}`;
  const main = [`${who} are deleted with their ${plural(counts.captures, 'capture')}, saved texts and notes. Their labels are not given to other sources.`];
  if (counts.jobs) main.push(counts.jobs === 1 ? '1 Research Job that includes them is deleted too.' : `${counts.jobs} Research Jobs that include them are deleted too.`);
  main.push('Their labels, titles and addresses stay in the deletion log.');
  return { main, small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`] };
}

export function sessionDeletionText(name: string, counts: DeletionCounts, active: boolean, lastBackupAt: string | null): DeletionText {
  const main =
    counts.sources === 0
      ? [`Session "${name}" is empty. Deleting it removes its prompt and notes.`]
      : [`It is deleted with its ${plural(counts.sources, 'source')} and ${plural(counts.captures, 'capture')}, their saved texts and notes, and the session prompt.`];
  if (counts.jobs) main.push(counts.jobs === 1 ? 'Its 1 Research Job is deleted too.' : `Its ${counts.jobs} Research Jobs are deleted too.`);
  if (counts.sources) main.push('The labels, titles and addresses of its sources stay in the deletion log.');
  if (active) main.push('New clips will go to the Inbox.');
  return { main, small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`] };
}

export function inboxEmptyingText(counts: DeletionCounts, nextNumber: number, lastBackupAt: string | null): DeletionText {
  const all = counts.sources > 1 ? 'All ' : '';
  const main = [`${all}${plural(counts.sources, 'source')} and ${plural(counts.captures, 'capture')} in the Inbox are deleted with their saved texts and notes.`];
  if (counts.jobs) main.push(counts.jobs === 1 ? '1 Research Job is deleted too.' : `${counts.jobs} Research Jobs are deleted too.`);
  main.push(`The Inbox stays. New sources continue from S${nextNumber}.`);
  if (counts.sources) main.push('The labels, titles and addresses of its sources stay in the deletion log.');
  return { main, small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`] };
}

// ---------- Deletion log ----------

const REMOVAL_VERBS: Record<RemovalAction, string> = {
  delete: 'Deleted',
  delete_session: 'Session deleted',
  empty_inbox: 'Inbox emptied',
  undo: 'Undone',
  review: 'Removed after recording',
  move: 'Moved',
  restore: 'Replaced by a restore',
};

export const REMOVAL_NOTE =
  "ClipGrail never gives a label to another source, so a source that is deleted, undone, moved or replaced by a restore leaves a gap in its session's labels. The log keeps the label, title and address of each deleted or replaced source and how many captures it had; its saved texts and notes are gone. A source removed with Undo or after a recording keeps only its label. Removing an entry from the log cannot be undone.";

export interface RemovalView {
  verb: string;
  /** For a move: the session and label the source has there. */
  target: string | null;
  heading: string;
  /** What happened, said after the time. */
  summary: string;
}

export function removalView(removal: Removal): RemovalView {
  const { action, sources, jobs, moved_to: to } = removal;
  const one = sources.length === 1 ? `S${sources[0]!.number}` : null;
  const captures = plural(sources.reduce((n, s) => n + s.captures, 0), 'capture');
  const deletedJobs = !jobs ? '' : jobs === 1 ? ` 1 Research Job that included ${one ? 'it' : 'them'} was deleted too.` : ` ${jobs} Research Jobs that included ${one ? 'it' : 'them'} were deleted too.`;
  // A session's own Research Jobs go with it, whether or not they include these sources.
  const sessionJobs = !jobs ? '' : jobs === 1 ? ' 1 Research Job was deleted too.' : ` ${jobs} Research Jobs were deleted too.`;
  const session = sources[0]!.session_name;
  const views: Record<RemovalAction, () => Omit<RemovalView, 'verb' | 'target'>> = {
    delete: () => ({ heading: `${one ?? plural(sources.length, 'source')} deleted`, summary: `Deleted with ${captures}, ${one ? 'its' : 'their'} saved texts and notes.${deletedJobs}` }),
    delete_session: () => ({ heading: `Session "${session}" deleted`, summary: `Deleted with ${plural(sources.length, 'source')} and ${captures}, their saved texts and notes.${sessionJobs}` }),
    empty_inbox: () => ({ heading: 'Inbox emptied', summary: `${plural(sources.length, 'source')} and ${captures} were deleted with their saved texts and notes.${sessionJobs}` }),
    undo: () => ({ heading: `${one ?? plural(sources.length, 'source')} undone`, summary: 'Removed with Undo, which keeps no title or address.' }),
    review: () => ({ heading: `${one ?? plural(sources.length, 'source')} removed after recording`, summary: 'Removed in the review after a recording, which keeps no title or address.' }),
    move: () => ({
      heading: `${one} moved to ${to!.session_name}`,
      summary: to!.joined
        ? `Moved with ${captures} to ${to!.session_name}, where it joined S${to!.number}, which had the same address.`
        : `Moved with ${captures} to ${to!.session_name} as S${to!.number}.`,
    }),
    restore: () => ({
      heading: `${one ?? plural(sources.length, 'source')} replaced by a restore`,
      summary: `Removed when a backup without ${one ? 'it' : 'them'} was restored, with ${captures}, ${one ? 'its' : 'their'} saved texts and notes.`,
    }),
  };
  return { verb: REMOVAL_VERBS[action], target: to ? `${to.session_name} S${to.number}` : null, ...views[action]() };
}

/** What a search of the log finds in an entry besides its labels, which are matched whole: what happened, sessions, titles and addresses. */
export function removalText(removal: Removal): string {
  return [removalView(removal).verb, removal.moved_to?.session_name, ...removal.sources.flatMap((s) => [s.session_name, s.title, s.url])].filter(Boolean).join('\n');
}

export function removalDeletionText(removal: Removal, lastBackupAt: string | null): DeletionText {
  const labels = labelList(removal.sources.map((s) => `S${s.number}`));
  const gap = removal.sources.length === 1 ? `The gap ${labels} left` : 'The gaps their labels left';
  return {
    main: [`The entry for ${labels} is deleted with what it keeps. ${gap} will no longer be explained.`],
    small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`],
  };
}

export function logClearingText(entries: number, lastBackupAt: string | null): DeletionText {
  return {
    main: [`${entries === 1 ? 'The entry is' : `All ${fmtNumber(entries)} entries are`} deleted with the labels, titles and addresses they keep. Gaps in labels will no longer be explained.`],
    small: [NOT_AFFECTED, `${backupLine(lastBackupAt)}.`],
  };
}

/** Two lines for the side panel menu: what is stored and roughly how much space it takes. */
export function storageLines(summary: DataSummary, usageBytes: number | null): [string, string] {
  const characters =
    summary.characters >= 1_000_000 ? `${(summary.characters / 1_000_000).toFixed(1)} million characters` : `${fmtNumber(summary.characters)} characters`;
  const size = usageBytes === null ? '' : usageBytes < 100_000 ? ' · less than 0.1 MB' : ` · about ${(usageBytes / 1_000_000).toFixed(1)} MB`;
  return [
    `${plural(summary.sessions, 'session')} · ${plural(summary.sources, 'source')} · ${plural(summary.captures, 'capture')}`,
    `${characters}${size}`,
  ];
}
