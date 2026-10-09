import './style.css';
import { browser } from 'wxt/browser';
import { announceDataChange, onDataChange } from '../../lib/changes';
import { countForDeletion, countSourcesForDeletion, deleteRemovals, deleteSession, deleteSource, deleteSources, emptyInbox, loadLibrary, loadSnapshotText, loadThumbnail, thumbnailIds, openDb, loadNote, moveSource, setSessionArchived, setSourceImportant, setWriteListener, updateSourceNote, updateCaptureNote, visitSnapshotTexts } from '../../lib/db';
import type { LibraryData } from '../../lib/db';
import type { DeletionText } from '../../lib/describe';
import {
  REMOVAL_NOTE,
  STATUS_LABELS,
  captureDetailRows,
  captureHead,
  captureLine,
  comparisonLine,
  fmtNumber,
  fmtTime,
  hostOf,
  inboxEmptyingText,
  logClearingText,
  pageCodeView,
  removalDeletionText,
  removalText,
  removalView,
  sessionDeletionText,
  sourceDeletionText,
  sourcesDeletionText,
  sourceMeta,
  sourceRows,
  statusSentence,
  textComparisons,
} from '../../lib/describe';
import { $, fill, h } from '../../lib/dom';
import { faviconTile, faviconUrl } from '../../lib/favicon';
import { hydrateIcons, icon } from '../../lib/icons';
import type { Child } from '../../lib/dom';
import { compareTexts } from '../../lib/diff';
import { pageCodeBlock } from '../../lib/page-code-block';
import type { DiffPart, TextDiff } from '../../lib/diff';
import { ALL_SOURCES, SORT_LABELS, compareChoices, filterRows, libraryRows, searchSnippet, textIdsOf, textShaOf, versionsOf } from '../../lib/library';
import type { LibraryEntry, LibraryFilter, LibraryRow, LibrarySort, TextHits, Version } from '../../lib/library';
import { PIVOT_GROUPS, PIVOT_KINDS, PIVOT_NOTES, collectPivots, filterPivots, textFinds } from '../../lib/pivots';
import type { Pivot, PivotFilter, PivotUse, TextFind } from '../../lib/pivots';
import { fold, inDays, localDay, parseSearch, searchWords, searchable, storedRanges, textHit } from '../../lib/search';
import type { SearchQuery, Snippet } from '../../lib/search';
import { INBOX_SESSION_ID, sourceLabel } from '../../lib/model';
import { arrival, ledTo, sourcesByAddress, timelineEvents } from '../../lib/timeline';
import type { TimelineEvent } from '../../lib/timeline';
import type { Removal, Session } from '../../lib/model';
import type { SourceStatus } from '../../lib/selection';
import { describeFailure } from '../../lib/selection';
import { LIST_WIDTH, NAV_WIDTH, clampWidth, getActiveSessionId, setActiveSessionId, getJobSettings, saveJobSettings, getLibraryLayout, saveLibraryLayout, getLastBackupAt, dropExcludedSources, removeJobSettings } from '../../lib/settings';
import type { LibraryLayout, WidthRange } from '../../lib/settings';

import { finishNoteWrites, keepNoteFocus, noteEditor } from '../../lib/note-editor';

let db: IDBDatabase;
let data: LibraryData = { sessions: [], sources: [], removals: [] };
let rows: LibraryRow[] = [];
let shown: LibraryRow[] = [];
let activeId = INBOX_SESSION_ID;
const filter: LibraryFilter = { view: ALL_SOURCES, query: '', status: 'any', important: false, sort: 'last-desc' };
/** The list shows the sources, a session's timeline (every capture and visit in time order), or pivots: values with the sources each is in. */
let mode: 'sources' | 'timeline' | 'pivots' = 'sources';
/** The value open in the reader while no source is, by its key; the filters of the list of values; and the value as written in a source opened from it, marked there. */
let pivotKey: string | null = null;
const pivotFilter: PivotFilter = { query: '', group: 'all', shared: true };
let pivotMark: string | null = null;
/** The values of the view, as last listed. */
let pivots: Pivot[] = [];
/** Values found in each saved text, by snapshot ID. A saved text never changes, so each is read once. */
const finds = new Map<string, TextFind[]>();
let readingFinds = false;
/** The deletion log is shown as a view of its own, like a session; the entry open in the reader, and the filters of the list. */
const DELETION_LOG = 'deletion-log';
let removalId: string | null = null;
const logFilter = { query: '', session: 'all' };
let selectedId: string | null = null;
let viewedCaptureId: string | null = null;
/** While comparing: the source, its viewed capture and the one it is compared with; void once another capture or source is viewed. */
let comparing: { source: string; viewed: string; other: string } | null = null;
/** The change moved to with Previous and Next (from 1), and the folded paragraphs opened, in the comparison shown. */
let changeAt = 1;
let unfolded = new Set<number>();
/** The comparison last made, by the snapshot IDs of its texts (null: too different to mark), and why its texts could not be read. */
let lastDiff: { key: string; diff: TextDiff | null } | null = null;
let compareError: { key: string; message: string } | null = null;
/** The comparison whose result was last said to screen readers, and whether one opened from the address is still to be scrolled to. */
let announcedKey = '';
let scrollToCompare = false;
let archivedOpen = false;
let detailsOpen = false;
/** Snapshot texts already read. A saved text never changes, so they can be kept. */
const texts = new Map<string, string>();
/**
 * Saved texts read for the current search words: what each contains, by
 * snapshot ID. A saved text never changes, so after new captures only their
 * texts are read; new words start over.
 */
let textSearch: { key: string; hits: TextHits; read: Set<string> } = { key: '', hits: new Map(), read: new Set() };
/** The words saved texts are being read for, while a search reads them. */
let readingFor: string | null = null;
let searchRun = 0;
/** Set when a source is opened from a search: the reader scrolls to the first match once the text is shown. */
let scrollToMatch = false;
let noteSearchTimer: ReturnType<typeof setTimeout> | undefined;
/** Matches marked in one text of the reader, per search word. */
const MAX_HIGHLIGHTS = 1000;
/** Captures that have a page thumbnail, and the thumbnails read so far. */
let thumbIds = new Set<string>();
const thumbs = new Map<string, Promise<string | null>>();
const wide = window.matchMedia('(min-width: 901px)');
let layout: LibraryLayout = { sessions_hidden: false, reader_expanded: false, nav_width: NAV_WIDTH.initial, list_width: LIST_WIDTH.initial };
/** Sources selected to delete several at once; always a subset of the sources shown. */
const picked = new Set<string>();
let pickAnchor: string | null = null;
const expandButton = $<HTMLButtonElement>('expand-reader');

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const count = (n: number, word: string) => `${fmtNumber(n)} ${n === 1 ? word : `${word}s`}`;
const chip = (status: SourceStatus) => h('span', { class: `chip ${status}` }, [STATUS_LABELS[status]]);
const sessionOf = (id: string): Session | undefined => data.sessions.find((s) => s.id === id);
const logShown = () => filter.view === DELETION_LOG;
/** The timeline is one session's; All sources, also reached when the session shown was deleted, lists sources. */
const timelineShown = () => mode === 'timeline' && filter.view !== ALL_SOURCES && !logShown();
const viewName = () => (filter.view === ALL_SOURCES ? 'All sources' : logShown() ? 'Deletion log' : (sessionOf(filter.view)?.name ?? 'All sources'));
const selectedRow = () => rows.find((r) => r.entry.source.id === selectedId);

// ---------- Address: #view=<session ID, all or deletion-log>&mode=timeline|pivots&source=<source ID>&entry=<log entry ID> (identifiers only) ----------
// The side panel can add capture=<capture ID>&compare=<capture ID> to open a comparison of two saved texts.

function readHash(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const view = params.get('view');
  filter.view = view && (view === ALL_SOURCES || view === DELETION_LOG || sessionOf(view)) ? view : ALL_SOURCES;
  // The timeline is one session's; All sources shows the list.
  const wanted = params.get('mode');
  mode = wanted === 'pivots' ? 'pivots' : wanted === 'timeline' && filter.view !== ALL_SOURCES ? 'timeline' : 'sources';
  removalId = params.get('entry');
  const source = params.get('source');
  if (source !== selectedId) viewedCaptureId = null;
  const capture = params.get('capture');
  const other = params.get('compare');
  if (capture) {
    viewedCaptureId = capture;
    setComparing(source && other ? { source, viewed: capture, other } : null);
    scrollToCompare = !!comparing;
  }
  selectedId = source;
  setReading(filter.view === DELETION_LOG ? !!removalId : !!selectedId);
}

function writeHash(): void {
  const params = new URLSearchParams({ view: filter.view });
  if (logShown()) {
    if (removalId) params.set('entry', removalId);
  } else {
    if (timelineShown() || mode === 'pivots') params.set('mode', mode);
    if (selectedId) params.set('source', selectedId);
  }
  history.replaceState(null, '', `#${params.toString()}`);
}

/** Narrow windows show either the list or the open source. */
function setReading(reading: boolean): void {
  document.body.classList.toggle('reading', reading);
  $('back-button').hidden = !reading;
  $('narrow-position').hidden = !reading;
}

// ---------- Hidden columns (wide windows) ----------

/** The reader is expanded only while a source is open, so the list is never hidden with nothing to read. */
function applyLayout(): void {
  document.body.style.setProperty('--nav-w', `${layout.nav_width}px`);
  document.body.style.setProperty('--list-w', `${layout.list_width}px`);
  for (const [id, value, range] of [['resize-nav', layout.nav_width, NAV_WIDTH], ['resize-list', layout.list_width, LIST_WIDTH]] as const) {
    const handle = $(id);
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuemin', String(range.min));
    handle.setAttribute('aria-valuemax', String(range.max));
  }
  const expanded = layout.reader_expanded && !!selectedRow();
  document.body.classList.toggle('sessions-hidden', layout.sessions_hidden);
  document.body.classList.toggle('reader-expanded', expanded);
  $('show-sessions').hidden = !layout.sessions_hidden;
  const label = expanded ? 'Show all columns' : 'Expand reader';
  expandButton.title = label;
  expandButton.setAttribute('aria-label', label);
  expandButton.setAttribute('aria-pressed', String(expanded));
}

function changeLayout(changes: Partial<LibraryLayout>, focus?: HTMLElement): void {
  layout = { ...layout, ...changes };
  applyLayout();
  focus?.focus();
  saveLibraryLayout(layout).catch((error: unknown) => notice(`Layout not saved: ${errorText(error)}`));
}

/**
 * A column border: dragging it or the arrow keys (Shift for bigger steps)
 * change the column's width, a double-click restores it.
 */
function bindResize(handle: HTMLElement, key: 'nav_width' | 'list_width', range: WidthRange, columnStart: () => number): void {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const drag = new AbortController();
    handle.addEventListener(
      'pointermove',
      (move) => {
        layout = { ...layout, [key]: clampWidth(move.clientX - columnStart(), range) };
        applyLayout();
      },
      { signal: drag.signal },
    );
    const end = () => {
      drag.abort();
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      changeLayout({});
    };
    handle.addEventListener('pointerup', end, { signal: drag.signal });
    handle.addEventListener('pointercancel', end, { signal: drag.signal });
  });
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    if (!delta) return;
    event.preventDefault();
    changeLayout({ [key]: clampWidth(layout[key] + delta, range) });
  });
  handle.addEventListener('dblclick', () => changeLayout({ [key]: range.initial }));
}

// ---------- Thumbnails ----------

/** The capture whose thumbnail shows a source: the given one if it has a thumbnail, else the newest that has one. */
function thumbCapture(entry: { captures: { capture: { id: string } }[] }, preferred?: string): string | undefined {
  if (preferred && thumbIds.has(preferred)) return preferred;
  return [...entry.captures].reverse().find((c) => thumbIds.has(c.capture.id))?.capture.id;
}

/** An image filled in once its thumbnail is read. */
function thumbImage(captureId: string, cls: string, alt: string): HTMLImageElement {
  const img = h('img', { class: cls, attrs: { alt, decoding: 'async' } });
  if (!thumbs.has(captureId)) thumbs.set(captureId, loadThumbnail(db, captureId).catch(() => null));
  void thumbs.get(captureId)!.then((src) => {
    if (src) img.src = src;
    else img.remove();
  });
  return img;
}

function thumbCaptureImage(entry: { captures: { capture: { id: string } }[] }): HTMLImageElement | null {
  const id = thumbCapture(entry);
  return id ? thumbImage(id, 'thumb', '') : null;
}

/** The page as it looked at the viewed capture (or the newest one with a thumbnail), above its address. */
function readerThumb(entry: { captures: { capture: { id: string } }[] }, viewedId: string): HTMLImageElement | null {
  const id = thumbCapture(entry, viewedId);
  return id ? thumbImage(id, 'reader-thumb', 'The page as it looked when it was clipped') : null;
}

// ---------- Sessions ----------

function renderNav(): void {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.session.id, (counts.get(row.session.id) ?? 0) + 1);
  const current = data.sessions.filter((s) => s.archived_at === null);
  const archived = data.sessions.filter((s) => s.archived_at !== null);
  if (archived.some((s) => s.id === filter.view)) archivedOpen = true;
  const item = (key: string, name: string, n: number, session?: Session) => {
    const button = h('button', { class: 'nav-item', attrs: { type: 'button', 'aria-current': String(filter.view === key) }, on: { click: () => setView(key) } }, [
      icon(key === ALL_SOURCES ? 'stack' : key === INBOX_SESSION_ID ? 'tray' : key === DELETION_LOG ? 'clock-counter-clockwise' : 'folder-simple'),
      h('span', { class: 'name', attrs: { title: name } }, [name]),
      session?.id === activeId ? h('span', { class: 'active-tag', attrs: { title: 'Active session: new clips go here' } }, ['Active']) : null,
      h('span', { class: 'count' }, [fmtNumber(n)]),
    ]);
    if (!session) return button;
    return h('div', { class: 'nav-row' }, [button,
      h('button', { class: 'session-actions', attrs: { type: 'button', 'data-session': session.id, 'aria-label': `Actions for ${name}`, 'aria-haspopup': 'dialog' }, on: { click: (event) => openSessionActions(session, event.currentTarget as HTMLElement) } }, [icon('dots-three')]),
    ]);
  };
  const toggle = h(
    'button',
    {
      class: 'nav-item',
      attrs: { type: 'button', 'aria-expanded': String(archivedOpen) },
      on: {
        click: () => {
          archivedOpen = !archivedOpen;
          renderNav();
        },
      },
    },
    [icon('archive'), h('span', { class: 'name' }, ['Archived']), h('span', { class: 'chevron' }, [icon('caret-right')]), h('span', { class: 'count' }, [fmtNumber(archived.length)])],
  );
  fill($('nav-list'), [
    item(ALL_SOURCES, 'All sources', rows.length),
    h('div', { class: 'nav-group section-title' }, ['Sessions']),
    ...current.map((s) => item(s.id, s.name, counts.get(s.id) ?? 0, s)),
    archived.length ? toggle : null,
    ...(archivedOpen ? archived.map((s) => item(s.id, s.name, counts.get(s.id) ?? 0, s)) : []),
    h('div', { class: 'nav-group section-title' }, ['Removed']),
    item(DELETION_LOG, 'Deletion log', data.removals.length),
  ]);
  const option = (s: Session) => h('option', { attrs: { value: s.id } }, [`${s.name}${s.id === activeId ? ' · active' : ''} (${fmtNumber(counts.get(s.id) ?? 0)})`]);
  const select = $<HTMLSelectElement>('view-select');
  fill(select, [
    h('option', { attrs: { value: ALL_SOURCES } }, [`All sources (${fmtNumber(rows.length)})`]),
    ...current.map(option),
    archived.length ? h('optgroup', { attrs: { label: 'Archived' } }, archived.map(option)) : null,
    h('option', { attrs: { value: DELETION_LOG } }, [`Deletion log (${fmtNumber(data.removals.length)})`]),
  ]);
  select.value = filter.view;
}

function setView(view: string): void {
  clearPicked();
  filter.view = view;
  if (view === ALL_SOURCES && mode === 'timeline') mode = 'sources';
  if (selectedId && view !== ALL_SOURCES && selectedRow()?.session.id !== view) {
    selectedId = null;
    viewedCaptureId = null;
  }
  setReading(false);
  showSearch();
  writeHash();
  renderNav();
  renderList();
  renderReader();
  $('list-col').scrollTop = 0;
}

// ---------- Sources ----------

/** A passage with the words found marked: under a source, where the search found it; under a source a value is in, around the value. */
function snippetLine(snippet: Snippet, where?: string): HTMLElement {
  const { text, marks, cut_before, cut_after } = snippet;
  const parts: Child[] = [where ? h('span', { class: 'where' }, [where]) : null, cut_before ? '…' : null];
  let at = 0;
  for (const [start, end] of marks) {
    parts.push(text.slice(at, start), h('mark', {}, [text.slice(start, end)]));
    at = end;
  }
  parts.push(text.slice(at), cut_after ? '…' : null);
  return h('span', { class: 'src-snippet' }, parts);
}

function listItem(row: LibraryRow, mixed: boolean, query: SearchQuery): HTMLLIElement {
  const { entry } = row;
  const found = query.terms.length ? searchSnippet(row, query, textSearch.hits) : null;
  const meta = [sourceMeta(entry), `last ${fmtTime(row.last_captured_at)}`].filter(Boolean).join(' · ');
  const name = row.title ?? entry.source.dedup_url;
  const id = entry.source.id;
  const box: HTMLInputElement = h('input', {
    class: 'pick-box',
    attrs: { type: 'checkbox', tabindex: '-1', 'data-pick': id, 'aria-label': `Select ${row.label}${mixed ? ` in ${row.session.name}` : ''}` },
    on: { click: (event) => pick(id, (event as MouseEvent).shiftKey, box.checked) },
  });
  box.checked = picked.has(id);
  return h('li', { class: picked.has(id) ? 'picked' : '' }, [
    box,
    h(
      'button',
      {
        class: 'src',
        attrs: {
          type: 'button',
          tabindex: '-1',
          'data-id': id,
          'aria-current': String(id === selectedId),
          'aria-label': `${row.label}${mixed ? ` in ${row.session.name}` : ''}: ${name}, ${STATUS_LABELS[row.status]}${entry.source.important ? ', important' : ''}${found ? `, found in ${found.where}` : ''}`,
        },
        on: {
          click: (event) => {
            // Ctrl/Cmd+click and Shift+click select, as in file lists; a plain click opens the source.
            const { ctrlKey, metaKey, shiftKey } = event as MouseEvent;
            if (ctrlKey || metaKey || shiftKey) pick(id, shiftKey, shiftKey || !picked.has(id));
            else openSource(id, true);
          },
        },
      },
      [
        thumbCaptureImage(entry),
        faviconTile(entry.source.dedup_url),
        h('span', { class: 'src-body' }, [
          h('span', { class: `src-title${row.title ? '' : ' untitled'}` }, [entry.source.important ? starMark() : null, name]),
          h('span', { class: 'src-meta' }, [
            mixed ? h('span', { class: 'sess', attrs: { title: row.session.name } }, [row.session.name]) : null,
            chip(row.status),
            h('span', { class: 'src-host' }, [hostOf(entry.source.dedup_url)]),
            h('span', {}, [meta]),
          ]),
          found ? snippetLine(found.snippet, found.where) : null,
        ]),
      ],
    ),
  ]);
}

/** The filled star of a source marked important. */
const starMark = () => h('span', { class: 'star' }, [icon('star-fill', 'Important')]);

/** A line of generated words with the S-labels in it shown as labels. */
function withLabels(text: string): Child[] {
  return text.split(/\b(S[1-9]\d*)\b/).map((part, i) => (i % 2 ? h('span', { class: 'sid' }, [part]) : part));
}

/** One event of the timeline: when, which source, and what happened. */
function timelineItem(event: TimelineEvent): HTMLLIElement {
  const { entry, capture } = event;
  const row = rows.find((r) => r.entry.source.id === entry.source.id);
  const title = row?.title ?? entry.source.dedup_url;
  const time = fmtTime(capture.captured_at).slice(11);
  const what = event.detail ? `${event.verb} · ${event.detail}` : event.verb;
  return h('li', {}, [
    h(
      'button',
      {
        class: 'src tl-event',
        attrs: {
          type: 'button',
          tabindex: '-1',
          'data-id': entry.source.id,
          'data-capture': capture.id,
          'aria-label': `${time}, ${what}: ${sourceLabel(entry.source)} ${title}${entry.source.important ? ', important' : ''}`,
        },
        on: { click: () => openEvent(entry.source.id, capture.id, true) },
      },
      [
        h('span', { class: 'tl-time' }, [time]),
        h('span', { class: 'tl-body' }, [
          h('span', { class: 'tl-head' }, [
            h('span', { class: 'sid' }, [sourceLabel(entry.source)]),
            h('span', { class: `tl-title${row?.title ? '' : ' untitled'}` }, [title]),
            entry.source.important ? starMark() : null,
            capture.note.trim() ? icon('note-pencil', 'Has a note') : null,
            h('span', { class: 'tl-host' }, [hostOf(entry.source.dedup_url)]),
          ]),
          h('span', { class: 'tl-what' }, [h('b', {}, [event.verb]), ...(event.detail ? [' · ', ...withLabels(event.detail)] : [])]),
        ]),
      ],
    ),
  ]);
}

/** Opens the source of a timeline event at that capture; a visit shows the current text. */
function openEvent(sourceId: string, captureId: string, userAction: boolean): void {
  openSource(sourceId, userAction);
  const capture = rows.find((r) => r.entry.source.id === sourceId)?.entry.captures.find((c) => c.capture.id === captureId);
  if (capture) viewCapture(captureId, false);
}

const rowButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .src'));
/** The row of the open source; on the timeline the event of the capture being read, else the source's first event; in Pivots the value open or last opened. */
function selectedButton(): HTMLButtonElement | undefined {
  if (logShown()) return rowButtons().find((b) => b.dataset.entry === removalId);
  if (mode === 'pivots') return rowButtons().find((b) => b.dataset.pivot === pivotKey);
  const buttons = rowButtons().filter((b) => b.dataset.id === selectedId);
  return buttons.find((b) => b.dataset.capture === viewedCaptureId) ?? buttons[0];
}

/** One row is reachable with Tab: the open source (or value) if it is listed, else the first. */
function markSelected(): void {
  const buttons = rowButtons();
  for (const button of buttons) {
    const current =
      button.dataset.entry !== undefined ? button.dataset.entry === removalId : button.dataset.pivot !== undefined ? button.dataset.pivot === pivotKey : button.dataset.id === selectedId;
    button.setAttribute('aria-current', String(current));
  }
  setTabStop(selectedButton() ?? buttons[0]);
}

/** One row of the list is reachable with Tab: its checkbox and its button. */
function setTabStop(row: HTMLButtonElement | undefined): void {
  for (const button of rowButtons()) {
    const index = button === row ? 0 : -1;
    button.tabIndex = index;
    const box = button.previousElementSibling;
    if (box instanceof HTMLInputElement) box.tabIndex = index;
  }
}

// ---------- Selecting several sources ----------

/** Selects or clears one source, or with `range` every source shown between the last one picked and this one. */
function pick(id: string, range: boolean, state: boolean): void {
  const ids = shown.map((r) => r.entry.source.id);
  const from = range && pickAnchor ? ids.indexOf(pickAnchor) : -1;
  const to = ids.indexOf(id);
  const chosen = from >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const each of chosen) {
    if (state) picked.add(each);
    else picked.delete(each);
  }
  pickAnchor = id;
  renderSelection();
}

/** Keeps only shown sources selected and updates the checkboxes and the selection bar. */
function renderSelection(): void {
  const ids = new Set(shown.map((r) => r.entry.source.id));
  for (const id of picked) if (!ids.has(id)) picked.delete(id);
  for (const box of document.querySelectorAll<HTMLInputElement>('#rows .pick-box')) {
    const on = picked.has(box.dataset.pick ?? '');
    box.checked = on;
    box.closest('li')?.classList.toggle('picked', on);
  }
  $('selection-bar').hidden = picked.size === 0;
  $('rows').classList.toggle('selecting', picked.size > 0);
  $('selection-count').textContent = `${fmtNumber(picked.size)} of ${fmtNumber(shown.length)} selected`;
  const all = $<HTMLInputElement>('select-all');
  all.checked = picked.size > 0 && picked.size === shown.length;
  all.indeterminate = picked.size > 0 && picked.size < shown.length;
}

/** A new view, search or filter starts without a selection, so nothing hidden is deleted. */
function clearPicked(): void {
  picked.clear();
  pickAnchor = null;
}

/** Reads the saved texts the search words have not been looked for in yet, then shows the list again. */
function searchTexts(query: SearchQuery): void {
  const key = JSON.stringify(query.terms);
  if (key !== textSearch.key) textSearch = { key, hits: new Map(), read: new Set() };
  if (!query.terms.length) {
    readingFor = null;
    searchRun++;
    return;
  }
  if (readingFor === key) return;
  const state = textSearch;
  const ids = rows.flatMap((row) => textIdsOf(row.entry)).filter((id) => !state.read.has(id));
  if (!ids.length) return;
  const run = ++searchRun;
  readingFor = key;
  const done = (error?: unknown) => {
    if (run !== searchRun) return;
    readingFor = null;
    if (error !== undefined) {
      // Not read again for these words, so a text the browser cannot read does not restart the search forever.
      for (const id of ids) state.read.add(id);
      notice(`Saved texts could not be searched: ${errorText(error)}`);
    }
    const restore = keepListFocus();
    renderList();
    restore();
  };
  visitSnapshotTexts(db, ids, (id, text) => {
    if (run !== searchRun) return false;
    state.read.add(id);
    const hit = textHit(text, query.terms);
    if (hit) state.hits.set(id, hit);
    return true;
  }).then(() => done(), done);
}

/** Puts focus back on the same row, or its checkbox, after the list is drawn again. */
function keepListFocus(): () => void {
  const active = document.activeElement instanceof HTMLElement && document.activeElement.closest('#rows') ? document.activeElement : null;
  const selector = active?.dataset.entry !== undefined
    ? `.src[data-entry="${CSS.escape(active.dataset.entry)}"]`
    : active?.dataset.pivot !== undefined
    ? `.src[data-pivot="${CSS.escape(active.dataset.pivot)}"]`
    : active?.dataset.capture
    ? `.src[data-capture="${CSS.escape(active.dataset.capture)}"]`
    : active?.dataset.id
      ? `.src[data-id="${CSS.escape(active.dataset.id)}"]`
      : active?.dataset.pick
        ? `.pick-box[data-pick="${CSS.escape(active.dataset.pick)}"]`
        : null;
  return () => {
    if (selector) document.querySelector<HTMLElement>(`#rows ${selector}`)?.focus({ preventScroll: true });
  };
}

function renderList(): void {
  const logList = logShown();
  const pivotsShown = mode === 'pivots' && !logList;
  const timeline = timelineShown();
  $('list-title').textContent = viewName();
  // Pivots are found in all sources too; the timeline is one session's.
  $('mode-switch').hidden = logList;
  $('mode-timeline').hidden = filter.view === ALL_SOURCES;
  $('mode-sources').setAttribute('aria-pressed', String(!timeline && !pivotsShown));
  $('mode-timeline').setAttribute('aria-pressed', String(timeline));
  $('mode-pivots').setAttribute('aria-pressed', String(pivotsShown));
  for (const id of ['status-filter', 'important-filter']) $(id).hidden = pivotsShown || logList;
  $('sort').hidden = timeline || pivotsShown || logList;
  $('pivot-kind').hidden = !pivotsShown;
  $('shared-only').hidden = !pivotsShown;
  $('log-session').hidden = !logList;
  $('clear-log').hidden = !logList;
  setSearchLabels(logList ? 'log' : pivotsShown ? 'values' : 'sources');
  $('rows').classList.toggle('timeline', timeline || logList);
  if (logList) renderLogList();
  else if (pivotsShown) renderPivotList();
  else renderSourceList(timeline);
  markSelected();
  renderSelection();
  renderNarrowTop(selectedRow());
}

function renderSourceList(timeline: boolean): void {
  const query = parseSearch(filter.query);
  searchTexts(query);
  shown = filterRows(rows, filter, textSearch.hits, timeline);
  const inViewRows = filter.view === ALL_SOURCES ? rows : rows.filter((r) => r.session.id === filter.view);
  const inView = inViewRows.length;
  const narrowed = filter.query.trim() !== '' || filter.status !== 'any' || filter.important || !!filter.pivot;
  $('clear-filters').hidden = !narrowed;
  $('status-filter').classList.toggle('filter-on', filter.status !== 'any');
  $('search').classList.toggle('filter-on', filter.query.trim() !== '');
  const important = $('important-filter');
  important.setAttribute('aria-pressed', String(filter.important));
  important.classList.toggle('filter-on', filter.important);
  // Show sources in Pivots keeps the sources a value is in, until this button or Clear filters.
  const pivotFilterButton = $('pivot-filter');
  pivotFilterButton.hidden = !filter.pivot;
  if (filter.pivot) {
    fill(pivotFilterButton, [icon('x'), h('span', { class: 'pv-filter-value' }, [filter.pivot.value])]);
    pivotFilterButton.title = `Only the sources with ${filter.pivot.value}. Click to show all sources.`;
    pivotFilterButton.setAttribute('aria-label', `Remove filter: sources with ${filter.pivot.value}`);
  }
  const empty = $('list-empty');
  if (timeline) {
    // Labels name every source of the session, also those the filters hide.
    const byAddress = sourcesByAddress(inViewRows.map((r) => r.entry));
    const all = timelineEvents(inViewRows.map((r) => r.entry), byAddress).length;
    const events = timelineEvents(shown.map((r) => r.entry), byAddress).filter((e) => inDays(e.capture.captured_at, query));
    $('result-count').textContent =
      readingFor !== null ? 'Searching saved text…' : narrowed ? `${fmtNumber(events.length)} of ${count(all, 'event')}` : count(all, 'event');
    const items: HTMLLIElement[] = [];
    let day = '';
    for (const event of events) {
      const next = localDay(event.capture.captured_at);
      if (next !== day) {
        day = next;
        const weekday = new Date(event.capture.captured_at).toLocaleDateString('en-US', { weekday: 'long' });
        items.push(h('li', { class: 'tl-day' }, [`${day} · ${weekday}`]));
      }
      items.push(timelineItem(event));
    }
    $('rows').replaceChildren(...items);
    empty.hidden = events.length > 0;
    if (!events.length) {
      fill(empty, [
        all === 0
          ? h('p', {}, ['No activity yet. Clip or record pages in the side panel and they appear here in the order they happened.'])
          : h('p', {}, [readingFor !== null ? 'Searching saved text…' : 'No activity matches the search and filters.']),
        all > 0 ? h('button', { class: 'link', attrs: { type: 'button' }, on: { click: clearFilters } }, ['Clear filters']) : null,
      ]);
    }
  } else {
    $('result-count').textContent =
      readingFor !== null ? 'Searching saved text…' : narrowed ? `${fmtNumber(shown.length)} of ${count(inView, 'source')}` : count(inView, 'source');
    const mixed = filter.view === ALL_SOURCES;
    $('rows').replaceChildren(...shown.map((row) => listItem(row, mixed, query)));
    empty.hidden = shown.length > 0;
    if (!shown.length) {
      fill(empty, [
        inView === 0
          ? h('p', {}, [filter.view === ALL_SOURCES ? 'No sources yet. Clip pages from the side panel and they appear here.' : 'This session has no sources yet.'])
          : h('p', {}, [readingFor !== null ? 'Searching saved text…' : 'No sources match the search and filters.']),
        inView > 0 ? h('button', { class: 'link', attrs: { type: 'button' }, on: { click: clearFilters } }, ['Clear filters']) : null,
      ]);
    }
  }
}

/** The search field searches sources, in Pivots the values, and in the deletion log its entries. */
const SEARCH_LABELS = {
  sources: { placeholder: $<HTMLInputElement>('search').placeholder, title: $<HTMLInputElement>('search').title },
  values: { placeholder: 'Search values', title: 'All words must be in the value or its kind. Use quotes for a phrase.' },
  log: { placeholder: 'Search labels, titles and addresses', title: 'All words must be in the entry: labels such as S3, sessions, titles and addresses. Use quotes for a phrase.' },
};

/** Shows the search of the list shown: of log entries, of values in Pivots, else of sources. */
function showSearch(): void {
  $<HTMLInputElement>('search').value = logShown() ? logFilter.query : mode === 'pivots' ? pivotFilter.query : filter.query;
}

function setSearchLabels(list: keyof typeof SEARCH_LABELS): void {
  const search = $<HTMLInputElement>('search');
  const labels = SEARCH_LABELS[list];
  search.placeholder = labels.placeholder;
  search.title = labels.title;
  search.setAttribute('aria-label', labels.placeholder);
}

/** Shows the session's sources, its timeline or pivots; each keeps its own search. */
function setMode(next: typeof mode): void {
  // The timeline is one session's.
  if (next === mode || (next === 'timeline' && filter.view === ALL_SOURCES)) return;
  clearPicked();
  mode = next;
  showSearch();
  writeHash();
  renderList();
  renderReader();
  $('list-col').scrollTop = 0;
}

function clearFilters(): void {
  clearPicked();
  if (logShown()) {
    logFilter.query = '';
    logFilter.session = 'all';
  } else if (mode === 'pivots') {
    pivotFilter.query = '';
    pivotFilter.group = 'all';
  } else {
    filter.query = '';
    filter.status = 'any';
    filter.important = false;
    filter.pivot = null;
    $<HTMLSelectElement>('status-filter').value = 'any';
  }
  $<HTMLInputElement>('search').value = '';
  renderList();
  highlightMatches();
  $('search').focus();
}

function openSource(id: string, userAction: boolean): void {
  // A narrow window shows the reader first, so the reader can scroll to a match.
  const narrow = userAction && !wide.matches;
  if (narrow) setReading(true);
  pivotMark = null;
  // In Pivots the search is of values, not of sources.
  const query = parseSearch(mode === 'pivots' ? '' : filter.query);
  // Opened from a search: the capture where it found the words (null: the current text), also for the source already open.
  const row = rows.find((r) => r.entry.source.id === id);
  const found = row && query.terms.length ? searchSnippet(row, query, textSearch.hits) : null;
  if (selectedId !== id || (userAction && found)) viewedCaptureId = found?.capture_id ?? null;
  // Words found in the page code are in Details, which then opens.
  if (userAction && found?.where === 'Page code') detailsOpen = true;
  if (selectedId !== id) $('reader-col').scrollTop = 0;
  scrollToMatch = userAction && query.terms.length > 0;
  if (scrollToMatch) setComparing(null);
  selectedId = id;
  markSelected();
  writeHash();
  renderReader();
  if (narrow) $('back-button').focus();
}

// ---------- Pivots: values with the sources each is in ----------

/** Reads the saved texts of the view not yet read for values, then lists the values again. */
function readFinds(entries: LibraryEntry[]): void {
  if (readingFinds) return;
  const ids = entries.flatMap(textIdsOf).filter((id) => !finds.has(id));
  if (!ids.length) return;
  readingFinds = true;
  const done = (error?: unknown) => {
    readingFinds = false;
    if (error !== undefined) {
      // Not read again, so a text the browser cannot read does not restart the reading forever.
      for (const id of ids) if (!finds.has(id)) finds.set(id, []);
      notice(`Saved texts could not be read for values: ${errorText(error)}`);
    }
    if (mode !== 'pivots') return;
    const restore = keepListFocus();
    renderList();
    restore();
    if (!selectedId) {
      // The open value is drawn again with the values found; focus stays on its button or source.
      const active = document.activeElement instanceof HTMLElement && document.activeElement.closest('#reader') ? document.activeElement : null;
      renderReader();
      const again = active?.id ? document.getElementById(active.id) : active?.dataset.capture ? document.querySelector<HTMLElement>(`#reader [data-capture="${CSS.escape(active.dataset.capture)}"]`) : null;
      again?.focus({ preventScroll: true });
    }
  };
  // Reading stops while the list shows something else and goes on when it shows values again.
  visitSnapshotTexts(db, ids, (id, text) => {
    if (mode !== 'pivots') return false;
    try {
      finds.set(id, textFinds(text));
    } catch {
      // One text that cannot be read for values does not hide the values of the others.
      finds.set(id, []);
    }
    return true;
  }).then(() => done(), done);
}

function renderPivotList(): void {
  shown = [];
  const entries = (filter.view === ALL_SOURCES ? rows : rows.filter((r) => r.session.id === filter.view)).map((r) => r.entry);
  readFinds(entries);
  pivots = collectPivots(entries, (id) => finds.get(id));
  const listed = filterPivots(pivots, pivotFilter);
  const narrowed = pivotFilter.query.trim() !== '' || pivotFilter.group !== 'all';
  $('clear-filters').hidden = !narrowed;
  $('pivot-filter').hidden = true;
  $('search').classList.toggle('filter-on', pivotFilter.query.trim() !== '');
  const kind = $<HTMLSelectElement>('pivot-kind');
  kind.value = pivotFilter.group;
  kind.classList.toggle('filter-on', pivotFilter.group !== 'all');
  const shared = $('shared-only');
  shared.setAttribute('aria-pressed', String(pivotFilter.shared));
  shared.classList.toggle('filter-on', pivotFilter.shared);
  $('result-count').textContent = readingFinds
    ? 'Reading saved texts…'
    : narrowed
      ? `${fmtNumber(listed.length)} of ${count(pivots.length, 'value')}`
      : pivotFilter.shared
        ? `${fmtNumber(listed.length)} shared of ${count(pivots.length, 'value')}`
        : count(pivots.length, 'value');
  const mixed = filter.view === ALL_SOURCES;
  $('rows').replaceChildren(...listed.map((pivot) => pivotItem(pivot, mixed)));
  const empty = $('list-empty');
  empty.hidden = listed.length > 0;
  if (listed.length) return;
  const action = (label: string, run: () => void) => h('button', { class: 'link', attrs: { type: 'button' }, on: { click: run } }, [label]);
  fill(
    empty,
    readingFinds
      ? [h('p', {}, ['Reading saved texts…'])]
      : !pivots.length
        ? [
            h('p', {}, [
              'No values yet. Trackers and what pages declare about themselves are read when you clip a page; email addresses, Bitcoin and Ethereum addresses, IBANs and Telegram links are found in saved text and selections.',
            ]),
          ]
        : pivotFilter.shared && !narrowed
          ? [
              h('p', {}, ['No value is in two or more sources.']),
              action('Show all values', () => {
                pivotFilter.shared = false;
                renderList();
                $('shared-only').focus();
              }),
            ]
          : [h('p', {}, ['No values match the search and filters.']), action('Clear filters', clearFilters)],
  );
}

function pivotItem(pivot: Pivot, mixed: boolean): HTMLLIElement {
  const kind = PIVOT_KINDS[pivot.kind];
  const sites = `${pivot.sites.slice(0, 2).join(', ')}${pivot.sites.length > 2 ? ` +${pivot.sites.length - 2}` : ''}`;
  const meta = [kind.label, sites, mixed && pivot.sessions > 1 ? count(pivot.sessions, 'session') : null].filter(Boolean).join(' · ');
  return h('li', {}, [
    h(
      'button',
      {
        class: 'src pv-row',
        attrs: {
          type: 'button',
          tabindex: '-1',
          'data-pivot': pivot.key,
          'aria-current': String(pivot.key === pivotKey),
          'aria-label': `${kind.label} ${pivot.value}: in ${count(pivot.uses.length, 'source')} on ${count(pivot.sites.length, 'site')}`,
        },
        on: { click: () => openPivot(pivot.key, true) },
      },
      [
        h('span', { class: 'pv-kind' }, [kind.badge]),
        h('span', { class: `pv-value${kind.mono ? ' mono' : ''}` }, [pivot.value]),
        h('span', { class: 'pv-count' }, [count(pivot.uses.length, 'source')]),
        h('span', { class: 'src-meta' }, [meta]),
      ],
    ),
  ]);
}

/** Shows a value of the list in the reader, with the sources it is in. */
function openPivot(key: string, userAction: boolean): void {
  const narrow = userAction && !wide.matches;
  if (narrow) setReading(true);
  pivotKey = key;
  pivotMark = null;
  selectedId = null;
  viewedCaptureId = null;
  setComparing(null);
  $('reader-col').scrollTop = 0;
  markSelected();
  writeHash();
  renderReader();
  if (narrow) $('back-button').focus();
}

/** The value open in Pivots: the sources it is in, each opening where the value was found. */
function renderPivot(reader: HTMLElement): void {
  const pivot = pivots.find((p) => p.key === pivotKey);
  if (!pivot) {
    const message = !pivotKey ? 'Select a value to see the sources it is in.' : readingFinds ? 'Reading saved texts…' : 'This value is not in the sources shown.';
    reader.replaceChildren(h('div', { class: 'empty' }, [h('p', {}, [message])]));
    return;
  }
  const kind = PIVOT_KINDS[pivot.kind];
  const mixed = filter.view === ALL_SOURCES;
  const n = pivot.uses.length;
  const places = [...new Set(pivot.uses.map((u) => (u.where === 'Selection' ? 'selections' : 'saved text')))].sort();
  const found = kind.group === 'text' ? `Found in ${places.join(' and ')}.` : `Read from the page code when ${n === 1 ? 'the page was' : 'the pages were'} clipped.`;
  fill(reader, [
    h('div', { class: 'crumb' }, [
      h('span', {}, ['Pivot']),
      h('span', {}, ['·']),
      h('span', {}, [kind.label]),
      h('span', { class: 'pv-actions' }, [
        h('button', { class: 'btn-sm', attrs: { id: 'copy-pivot', type: 'button' }, on: { click: () => void copyPivot(pivot.value) } }, [icon('copy'), 'Copy']),
        h('button', { class: 'btn-sm', attrs: { id: 'show-pivot-sources', type: 'button', title: 'List these sources to read them one after another' }, on: { click: () => showPivotSources(pivot) } }, ['Show sources']),
      ]),
    ]),
    h('h3', { class: `pv-title${kind.mono ? ' mono' : ''}` }, [pivot.value]),
    h('div', { class: 'status-line' }, [
      h('span', {}, [`In ${count(n, 'source')} on ${count(pivot.sites.length, 'site')}${mixed ? `, in ${count(pivot.sessions, 'session')}` : ''}. ${found}`]),
    ]),
    h('div', { class: 'pv-uses' }, pivot.uses.map((use) => pivotUseButton(pivot, use, mixed))),
    h('p', { class: 'small' }, [PIVOT_NOTES[kind.group]]),
  ]);
}

function pivotUseButton(pivot: Pivot, use: PivotUse, mixed: boolean): HTMLButtonElement {
  const { source } = use.entry;
  const title = rows.find((r) => r.entry.source.id === source.id)?.title ?? source.dedup_url;
  const meta = [hostOf(source.dedup_url), mixed ? (sessionOf(source.session_id)?.name ?? null) : null, use.where].filter(Boolean).join(' · ');
  return h('button', { class: 'pv-use', attrs: { type: 'button', 'data-id': source.id, 'data-capture': use.capture_id }, on: { click: () => openPivotUse(pivot, use) } }, [
    h('span', { class: 'sid' }, [sourceLabel(source)]),
    h('span', { class: 'pv-use-title' }, [title]),
    h('span', { class: 'pv-use-meta' }, [meta]),
    use.snippet ? snippetLine(use.snippet) : null,
  ]);
}

/** Opens a source the value is in at the capture where it was found, with the value marked; a value from the page code is in Details. */
function openPivotUse(pivot: Pivot, use: PivotUse): void {
  if (PIVOT_KINDS[pivot.kind].group !== 'text') detailsOpen = true;
  openSource(use.entry.source.id, true);
  pivotMark = use.raw;
  scrollToMatch = true;
  viewCapture(use.capture_id, false);
  if (wide.matches) document.querySelector<HTMLElement>(`#reader .ver[data-id="${CSS.escape(use.capture_id)}"]`)?.focus({ preventScroll: true });
}

async function copyPivot(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    notice(`Not copied: ${errorText(error)}`);
    return;
  }
  say(`Copied ${value}.`);
  const button = document.getElementById('copy-pivot');
  if (!button) return;
  fill(button, [icon('check'), 'Copied']);
  setTimeout(() => fill(button, [icon('copy'), 'Copy']), 1500);
}

/** Lists the sources a value is in, with the other filters cleared, and opens the first. */
function showPivotSources(pivot: Pivot): void {
  filter.pivot = { value: pivot.value, ids: new Set(pivot.uses.map((u) => u.entry.source.id)) };
  filter.query = '';
  filter.status = 'any';
  filter.important = false;
  $<HTMLSelectElement>('status-filter').value = 'any';
  setMode('sources');
  const first = shown[0];
  // A wide window reads the first source next to the list; a narrow one shows the list.
  if (first && wide.matches) openSource(first.entry.source.id, false);
  else setReading(false);
  rowButtons()[0]?.focus();
}

// ---------- Deletion log: what each retired label was ----------

/** A session of the log by its name now, or once deleted by the name the log has. */
const logSessionName = (id: string, then: string) => sessionOf(id)?.name ?? then;
const removalSessions = (removal: Removal) => [...new Map(removal.sources.map((s) => [s.session_id, logSessionName(s.session_id, s.session_name)])).values()];

/** Folded text of each entry for the search of the log: with the sessions' names now, and for a move the title and address of the source it went to. */
const removalHaystacks = new WeakMap<Removal, string>();
function removalHaystack(removal: Removal): string {
  let text = removalHaystacks.get(removal);
  if (text === undefined) {
    const target = movedTo(removal);
    const now = [...removalSessions(removal), target?.title, target?.entry.source.dedup_url];
    removalHaystacks.set(removal, (text = fold(searchable([removalText(removal), ...now].filter(Boolean).join('\n')))));
  }
  return text;
}

/** A search word such as "s3" finds the entries of that label, not S30 or an address with "s3" in it. */
const LABEL_WORD = /^s[1-9]\d*$/;
function logMatches(removal: Removal, terms: string[]): boolean {
  const labels = new Set([...removal.sources.map((s) => `s${s.number}`), ...(removal.moved_to ? [`s${removal.moved_to.number}`] : [])]);
  return terms.every((t) => (LABEL_WORD.test(t) ? labels.has(t) : removalHaystack(removal).includes(t)));
}

const entryCount = (n: number) => `${fmtNumber(n)} ${n === 1 ? 'entry' : 'entries'}`;

function renderLogList(): void {
  shown = [];
  $('pivot-filter').hidden = true;
  const all = data.removals;
  // Sessions the log names, by their name now or, once deleted, as the log has it.
  const names = new Map<string, string>();
  for (const removal of all) for (const s of removal.sources) if (!names.has(s.session_id)) names.set(s.session_id, sessionOf(s.session_id)?.name ?? s.session_name);
  if (!names.has(logFilter.session)) logFilter.session = 'all';
  const select = $<HTMLSelectElement>('log-session');
  fill(select, [h('option', { attrs: { value: 'all' } }, ['All sessions']), ...[...names].map(([id, name]) => h('option', { attrs: { value: id } }, [name]))]);
  select.value = logFilter.session;
  const terms = searchWords(logFilter.query);
  const listed = all.filter((r) => (logFilter.session === 'all' || r.sources.some((s) => s.session_id === logFilter.session)) && logMatches(r, terms));
  const narrowed = logFilter.query.trim() !== '' || logFilter.session !== 'all';
  $('clear-filters').hidden = !narrowed;
  $('search').classList.toggle('filter-on', logFilter.query.trim() !== '');
  select.classList.toggle('filter-on', logFilter.session !== 'all');
  $<HTMLButtonElement>('clear-log').disabled = !all.length;
  $('result-count').textContent = narrowed ? `${fmtNumber(listed.length)} of ${entryCount(all.length)}` : entryCount(all.length);
  const items: HTMLLIElement[] = [];
  let day = '';
  for (const removal of listed) {
    const next = localDay(removal.removed_at);
    if (next !== day) {
      day = next;
      const weekday = new Date(removal.removed_at).toLocaleDateString('en-US', { weekday: 'long' });
      items.push(h('li', { class: 'tl-day' }, [`${day} · ${weekday}`]));
    }
    items.push(removalItem(removal));
  }
  $('rows').replaceChildren(...items);
  const empty = $('list-empty');
  empty.hidden = listed.length > 0;
  if (!listed.length) {
    fill(empty, [
      all.length
        ? h('p', {}, ['No entries match the search and session.'])
        : h('p', {}, ["Nothing removed yet. When you delete a source, undo a clip or move a source to another session, its label is noted here, so a gap in a session's labels can be explained."]),
      all.length ? h('button', { class: 'link', attrs: { type: 'button' }, on: { click: clearFilters } }, ['Clear filters']) : null,
    ]);
  }
}

/** The source a moved label went to, if it is still there. */
function movedTo(removal: Removal): LibraryRow | undefined {
  const to = removal.moved_to;
  return to ? rows.find((r) => r.session.id === to.session_id && r.entry.source.number === to.number) : undefined;
}

function removalItem(removal: Removal): HTMLLIElement {
  const view = removalView(removal);
  const time = fmtTime(removal.removed_at).slice(11);
  const sessions = removalSessions(removal);
  const labels = removal.sources.map((s) => `S${s.number}`);
  const deleted = removal.sources.find((s) => s.url);
  const target = movedTo(removal);
  const what: Child[] = deleted
    ? [h('b', {}, [deleted.title ?? deleted.url!]), removal.sources.length > 1 ? ` and ${fmtNumber(removal.sources.length - 1)} more` : '', ` · ${hostOf(deleted.url!)}`]
    : target
      ? [h('b', {}, [target.title ?? target.entry.source.dedup_url]), ` · ${hostOf(target.entry.source.dedup_url)}`]
      : [removal.moved_to ? `No longer in ${logSessionName(removal.moved_to.session_id, removal.moved_to.session_name)}` : 'No title or address kept'];
  const spoken = `${labels.slice(0, 6).join(', ')}${labels.length > 6 ? ` and ${fmtNumber(labels.length - 6)} more` : ''}`;
  const whatText = what.map((part) => (typeof part === 'string' ? part : part ? part.textContent : '')).join('');
  return h('li', {}, [
    h(
      'button',
      {
        class: 'src dl-row',
        attrs: {
          type: 'button',
          tabindex: '-1',
          'data-entry': removal.id,
          'aria-current': String(removal.id === removalId),
          'aria-label': `${time}, ${view.verb} ${spoken}${view.target ? ` to ${view.target}` : ''}, ${sessions.join(', ')}: ${whatText}`,
        },
        on: { click: () => openRemoval(removal.id, true) },
      },
      [
        h('span', { class: 'tl-time' }, [time]),
        h('span', { class: 'tl-body' }, [
          h('span', { class: 'dl-head' }, [
            h('span', { class: 'dl-verb' }, [view.verb]),
            ...labels.slice(0, 6).map((label) => h('span', { class: 'sid' }, [label])),
            labels.length > 6 ? h('span', { class: 'dl-more' }, [`+${fmtNumber(labels.length - 6)}`]) : null,
            view.target ? h('span', { class: 'dl-target' }, [`→ ${view.target}`]) : null,
            h('span', { class: 'dl-sess' }, [sessions.length > 1 ? count(sessions.length, 'session') : sessions[0]!]),
          ]),
          h('span', { class: 'dl-what' }, what),
        ]),
      ],
    ),
  ]);
}

/** Shows an entry of the deletion log in the reader. */
function openRemoval(id: string, userAction: boolean): void {
  const narrow = userAction && !wide.matches;
  if (narrow) setReading(true);
  removalId = id;
  $('reader-col').scrollTop = 0;
  markSelected();
  writeHash();
  renderReader();
  if (narrow) $('back-button').focus();
}

function renderRemoval(reader: HTMLElement): void {
  const removal = data.removals.find((r) => r.id === removalId);
  if (!removal) {
    const message = removalId ? 'This entry is no longer in the deletion log.' : 'Select an entry to see what was removed.';
    reader.replaceChildren(h('div', { class: 'empty' }, [h('p', {}, [message])]));
    return;
  }
  const view = removalView(removal);
  const sessions = removalSessions(removal);
  const target = movedTo(removal);
  fill(reader, [
    h('div', { class: 'crumb' }, [
      h('span', {}, ['Deletion log']),
      h('span', {}, ['·']),
      h('span', {}, [sessions.join(', ')]),
      h('button', { class: 'btn-sm delete reader-actions', attrs: { id: 'remove-entry', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => void confirmRemoveEntry(removal) } }, [
        icon('trash'),
        'Remove from log…',
      ]),
    ]),
    h('h3', {}, [view.heading]),
    h('div', { class: 'status-line' }, [
      h('span', {}, [`${fmtTime(removal.removed_at)} · ${view.summary}${removal.moved_to && !target ? ` S${removal.moved_to.number} is no longer in ${removal.moved_to.session_name}.` : ''}`]),
    ]),
    target
      ? h('div', {}, [
          h(
            'button',
            {
              class: 'btn-sm',
              attrs: { id: 'open-moved', type: 'button' },
              on: { click: () => openMovedSource(target) },
            },
            [`Open ${target.label} in ${target.session.name}`],
          ),
        ])
      : null,
    h(
      'div',
      { class: 'dl-labels' },
      removal.sources.map((s) =>
        h('div', { class: 'dl-label' }, [
          h('span', { class: 'sid' }, [`S${s.number}`]),
          // A moved source is still in the library: its title there.
          h('span', { class: `dl-title${s.title || target ? '' : ' untitled'}` }, [
            s.title ?? (s.url ? '(title not captured)' : target ? (target.title ?? target.entry.source.dedup_url) : 'Title and address not kept'),
          ]),
          s.url ? h('span', { class: 'dl-url' }, [s.url]) : null,
          h('span', { class: 'dl-meta' }, [[count(s.captures, 'capture'), sessions.length > 1 ? logSessionName(s.session_id, s.session_name) : null].filter(Boolean).join(' · ')]),
        ]),
      ),
    ),
    h('p', { class: 'small' }, [REMOVAL_NOTE]),
  ]);
}

/** Opens the source a moved label went to, in its session's list of sources with no filter that could hide it. */
function openMovedSource(target: LibraryRow): void {
  if (mode === 'pivots') mode = 'sources';
  Object.assign(filter, { query: '', status: 'any', important: false, pivot: null });
  $<HTMLSelectElement>('status-filter').value = 'any';
  setView(target.session.id);
  openSource(target.entry.source.id, true);
  if (wide.matches) selectedButton()?.focus();
}

async function confirmRemoveEntry(removal: Removal): Promise<void> {
  const text = removalDeletionText(removal, await getLastBackupAt());
  openDeletion('Remove this entry from the deletion log?', text, 'Remove entry', () => runDeletion(async () => {
    await deleteRemovals(db, removal.id);
    removalId = null;
    return 'Entry removed from the deletion log.';
  }, 'Entry not removed', 'Entry removed; refresh failed'), $('remove-entry'));
}

async function confirmClearLog(): Promise<void> {
  const text = logClearingText(data.removals.length, await getLastBackupAt());
  openDeletion('Clear the deletion log?', text, 'Clear log', () => runDeletion(async () => {
    await deleteRemovals(db);
    removalId = null;
    return 'Deletion log cleared.';
  }, 'Log not cleared', 'Log cleared; refresh failed'), $('clear-log'));
}

// ---------- The open source ----------

function editNote(kind: 'source' | 'capture', id: string, value: string, label: string): HTMLElement {
  return noteEditor({
    id: kind === 'source' ? `source-note-${id}` : `capture-note-${id}`,
    key: `library:${kind}:${id}`, label, value,
    hint: kind === 'source' ? 'Private. Exported only with Notes.' : 'Private. For this capture only.',
    read: () => loadNote(db, kind, id),
    write: (text) => kind === 'source' ? updateSourceNote(db, id, text) : updateCaptureNote(db, id, text),
    onEdit: (text) => {
      if (kind === 'source') {
        const source = data.sources.find((s) => s.source.id === id)?.source;
        if (source) source.note = text;
      } else {
        const capture = data.sources.flatMap((s) => s.captures).find((c) => c.capture.id === id)?.capture;
        if (capture) capture.note = text;
      }
      // Notes are searched: the list follows the edit after a pause in typing; the reader is not redrawn.
      if (parseSearch(filter.query).terms.length) {
        clearTimeout(noteSearchTimer);
        noteSearchTimer = setTimeout(() => {
          const restore = keepListFocus();
          renderList();
          restore();
        }, 300);
      }
    },
  });
}

function versionButton(version: Version, checked: boolean, compared: string | undefined, inComparison: boolean): HTMLButtonElement {
  const { capture, snapshot } = version.capture;
  const note = capture.note.trim();
  const meta = [fmtTime(capture.captured_at), captureLine(capture, snapshot), compared ?? '', note ? `note: “${note.length > 80 ? `${note.slice(0, 80)}…` : note}”` : '']
    .filter(Boolean)
    .join(' · ');
  return h(
    'button',
    {
      class: 'ver',
      attrs: { type: 'button', role: 'radio', 'data-id': capture.id, 'aria-checked': String(checked), tabindex: checked ? '0' : '-1' },
      on: { click: () => viewCapture(capture.id) },
    },
    [
      h('span', { class: 'radio', attrs: { 'aria-hidden': 'true' } }),
      h('span', {}, [h('span', { class: 'ver-title' }, [captureHead(capture, version.number - 1)]), h('span', { class: 'ver-meta' }, [meta])]),
      h('span', { class: 'ver-tags' }, [
        version.current ? h('span', { class: 'current-tag', attrs: { title: 'Research Jobs use this text' } }, ['Current text']) : null,
        inComparison ? h('span', { class: 'compare-tag' }, ['Compared']) : null,
      ]),
    ],
  );
}

function viewCapture(captureId: string, focus = true): void {
  if (comparing?.viewed !== captureId) setComparing(null);
  viewedCaptureId = captureId;
  renderReader();
  if (focus) document.querySelector<HTMLButtonElement>(`.ver[data-id="${CSS.escape(captureId)}"]`)?.focus();
}

async function loadText(snapshotId: string, box: HTMLElement): Promise<void> {
  try {
    const text = await loadSnapshotText(db, snapshotId);
    if (text !== undefined) texts.set(snapshotId, text);
    if (box.isConnected) box.textContent = text ?? 'The saved text is missing.';
  } catch (error) {
    if (box.isConnected) box.textContent = `The saved text could not be read: ${errorText(error)}`;
  }
  box.removeAttribute('aria-busy');
  if (box.isConnected) highlightMatches();
}

/**
 * Marks the search words (in Pivots the value a source was opened for) in the texts and page code values shown in the
 * reader; after a source is opened from a search or a value, scrolls to the first.
 */
function highlightMatches(): void {
  const terms = mode === 'pivots' ? (pivotMark ? [fold(searchable(pivotMark))] : []) : parseSearch(filter.query).terms;
  const ranges: Range[] = [];
  const shown = '#reader .text-box:not([aria-busy]):not(.diff-box), #reader .page-code dd > span:first-child';
  for (const box of terms.length ? document.querySelectorAll<HTMLElement>(shown) : []) {
    const node = box.firstChild;
    if (!(node instanceof Text)) continue;
    for (const [start, end] of storedRanges(node.data, terms, MAX_HIGHLIGHTS)) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    if (ranges.length) CSS.highlights.set('search', new Highlight(...ranges));
    else CSS.highlights.delete('search');
  }
  const first = ranges[0];
  if (scrollToMatch && first) {
    const col = $('reader-col');
    col.scrollTop += first.getBoundingClientRect().top - col.getBoundingClientRect().top - col.clientHeight / 3;
  }
  // Once the text is shown, a later re-render of the same source keeps the reader where the user scrolled.
  if (first || !document.querySelector('#reader .text-box[aria-busy]')) scrollToMatch = false;
}

function viewedSection(viewed: Version, current: Version | undefined, versions: Version[], other: Version | undefined): HTMLElement {
  const { capture, snapshot } = viewed.capture;
  const head = (left: string, right?: string) => h('div', { class: 'text-head' }, [h('span', {}, [left]), right ? h('span', {}, [right]) : null]);
  const which = `Viewing capture ${viewed.number} of ${versions.length}`;
  const blocks: Child[] = [];
  if (snapshot?.status === 'ok' && other) {
    const [older, newer] = other.number < viewed.number ? [other, viewed] : [viewed, other];
    const key = compareKey(older, newer);
    const diff = diffOf(older, newer, key);
    const error = diff === undefined && compareError?.key === key ? compareError.message : null;
    const sums = diff ? ` · ${count(diff.changes, 'change')} · ${count(diff.added, 'character')} added, ${fmtNumber(diff.removed)} removed` : '';
    const title = `Changes from capture ${older.number} to capture ${newer.number}`;
    blocks.push(head(`${title}${sums}`));
    if (!viewed.current && current) blocks.push(earlierBanner(current));
    const message = compareMessage(older, newer, diff, error);
    blocks.push(compareBar(viewed, versions, other, diff), ...compareBody(older, newer, diff, message));
    if ((diff !== undefined || error) && announcedKey !== key) {
      announcedKey = key;
      say(message ?? `${title}: ${count(diff!.changes, 'change')}, ${count(diff!.added, 'character')} added, ${fmtNumber(diff!.removed)} removed.`);
    }
  } else if (snapshot?.status === 'ok') {
    const method = snapshot.extraction_method === 'readability' ? 'Readability' : 'visible page text';
    blocks.push(head(`${which} · Snapshot · ${fmtTime(snapshot.captured_at)} · ${method}`, `${fmtNumber(snapshot.character_count)} characters`));
    if (!viewed.current && current) blocks.push(earlierBanner(current));
    if (compareChoices(viewed, versions).some((c) => c.sameAs !== viewed.number)) blocks.push(compareBar(viewed, versions, undefined, undefined));
    const loaded = texts.has(snapshot.id);
    const box = h('pre', { class: 'text-box', attrs: { tabindex: '0', 'aria-label': `Saved text of capture ${viewed.number}`, ...(loaded ? {} : { 'aria-busy': 'true' }) } }, [
      texts.get(snapshot.id) ?? 'Loading text…',
    ]);
    blocks.push(box);
    if (!loaded) void loadText(snapshot.id, box);
    if (snapshot.truncated) {
      blocks.push(
        h('div', { class: 'text-cut' }, [
          `[Text cut at capture here. ${fmtNumber(snapshot.original_character_count - snapshot.character_count)} characters of the page were not saved.]`,
        ]),
      );
    }
  } else if (capture.fragment) {
    blocks.push(
      head(`${which} · Selection · ${fmtTime(capture.captured_at)}`, `${fmtNumber(capture.fragment.character_count)} characters${capture.fragment.truncated ? ' · partial' : ''}`),
      h('pre', { class: 'text-box', attrs: { tabindex: '0', 'aria-label': `Selection, capture ${viewed.number}` } }, [capture.fragment.text]),
    );
  } else {
    blocks.push(
      head(`${which} · ${fmtTime(capture.captured_at)}`),
      h('div', { class: 'no-text' }, [
        snapshot?.status === 'failed'
          ? `No text was saved: ${describeFailure(snapshot)}.`
          : capture.kind === 'tab'
            ? 'No text: only the tab address was saved, the page was not read.'
            : 'No text: the link was saved without opening the page.',
      ]),
    );
  }
  blocks.push(editNote('capture', capture.id, capture.note, `Capture note · Capture ${viewed.number}`));
  return h('div', { class: 'stack' }, blocks);
}

function earlierBanner(current: Version): HTMLElement {
  return h('div', { class: 'banner earlier', attrs: { role: 'note' } }, [
    h('span', {}, [`Earlier version, for reading only. Research Jobs use the current text from capture ${current.number} (${fmtTime(current.capture.capture.captured_at)}).`]),
    h('button', { attrs: { id: 'show-current', type: 'button' }, on: { click: () => viewCapture(current.capture.capture.id) } }, ['Show current text']),
  ]);
}

// ---------- Comparing two saved texts ----------

/** The capture the viewed one is compared with, if it is being compared and both have saved text. */
function comparedWith(viewed: Version, versions: Version[]): Version | undefined {
  if (comparing?.viewed !== viewed.capture.capture.id || textShaOf(viewed) === null) return undefined;
  return compareChoices(viewed, versions).find((c) => c.version.capture.capture.id === comparing!.other)?.version;
}

function setComparing(next: typeof comparing): void {
  comparing = next;
  changeAt = 1;
  unfolded = new Set();
  compareError = null;
  announcedKey = '';
}

/** A comparison by the snapshot IDs of its texts, older first. */
const snapshotIdOf = (v: Version) => (v.capture.snapshot?.status === 'ok' ? v.capture.snapshot.id : '');
const compareKey = (older: Version, newer: Version) => `${snapshotIdOf(older)} ${snapshotIdOf(newer)}`;

/** The changes from the older text to the newer one; undefined while a text is read. */
function diffOf(older: Version, newer: Version, key: string): TextDiff | null | undefined {
  if (lastDiff?.key === key) return lastDiff.diff;
  const ids = [snapshotIdOf(older), snapshotIdOf(newer)];
  const [a, b] = ids.map((id) => texts.get(id));
  if (a === undefined || b === undefined) {
    if (compareError?.key !== key) void readTexts(ids, key);
    return undefined;
  }
  lastDiff = { key, diff: compareTexts(a, b) };
  return lastDiff.diff;
}

/** Tells screen readers what a comparison found, which change Previous and Next moved to, or that a value was copied. */
function say(text: string): void {
  $('compare-said').textContent = text;
}

/** The texts being read for a comparison, by its key. */
let textsReading: string | null = null;
async function readTexts(ids: string[], key: string): Promise<void> {
  if (textsReading === key) return;
  textsReading = key;
  try {
    for (const id of ids) {
      if (texts.has(id)) continue;
      const text = await loadSnapshotText(db, id);
      if (text === undefined) throw new Error('A saved text is missing.');
      texts.set(id, text);
    }
  } catch (error) {
    compareError = { key, message: errorText(error) };
  }
  if (textsReading === key) textsReading = null;
  // Drawing the comparison replaces its controls; the one in use keeps focus.
  const focused = document.activeElement?.closest('.compare-bar') ? document.activeElement.id : '';
  renderReader();
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

/** Compare with…, and while comparing: Previous, Next and Close. A capture that would repeat another choice is shown but not offered. */
function compareBar(viewed: Version, versions: Version[], other: Version | undefined, diff: TextDiff | null | undefined): HTMLElement {
  const select = h(
    'select',
    { attrs: { id: 'compare-with', 'aria-label': 'Compare this text with another capture' }, on: { change: () => compareWithCapture(viewed, select.value) } },
    [
      h('option', { attrs: { value: '' } }, ['Compare with…']),
      ...compareChoices(viewed, versions).map(({ version: v, sameAs }) =>
        h('option', { attrs: { value: v.capture.capture.id, ...(sameAs === null || v === other ? {} : { disabled: '' }) } }, [
          `Capture ${v.number} · ${sameAs === null ? fmtTime(v.capture.capture.captured_at) : `same text as capture ${sameAs}`}`,
        ]),
      ),
    ],
  );
  select.value = other?.capture.capture.id ?? '';
  if (!other) return h('div', { class: 'compare-bar' }, [h('span', { class: 'grow' }), select]);
  const total = diff?.changes ?? 0;
  return h('div', { class: 'compare-bar' }, [
    select,
    h('span', { class: 'grow' }),
    // The buttons wrap to the next line together in a narrow window.
    h('span', { class: 'compare-nav' }, [
      total
        ? h('button', { class: 'btn-sm', attrs: { id: 'previous-change', type: 'button' }, on: { click: () => moveChange(-1, total) } }, ['↑ Previous'])
        : null,
      total ? h('span', { class: 'change-count', attrs: { id: 'change-count' } }, [`${changeAt} of ${total}`]) : null,
      total ? h('button', { class: 'btn-sm', attrs: { id: 'next-change', type: 'button' }, on: { click: () => moveChange(1, total) } }, ['↓ Next']) : null,
      h('button', { class: 'btn-sm', attrs: { id: 'close-compare', type: 'button' }, on: { click: () => compareWithCapture(viewed, '') } }, [icon('x'), 'Close']),
    ]),
  ]);
}

function compareWithCapture(viewed: Version, otherId: string): void {
  const { capture } = viewed.capture;
  setComparing(otherId ? { source: capture.source_id, viewed: capture.id, other: otherId } : null);
  if (!otherId) say('');
  renderReader();
  document.getElementById('compare-with')?.focus();
}

/** Marks the next or previous change, scrolls to it and says what changed there. */
function moveChange(step: number, total: number): void {
  changeAt = ((changeAt - 1 + step + total) % total) + 1;
  for (const mark of document.querySelectorAll('#reader .chg.now')) mark.classList.remove('now');
  const mark = document.querySelector(`#reader .chg[data-change="${changeAt}"]`);
  mark?.classList.add('now');
  mark?.scrollIntoView({ block: 'center' });
  $('change-count').textContent = `${changeAt} of ${total}`;
  const quote = (text: string | undefined) => `“${(text ?? '').trim().slice(0, 120)}”`;
  const removed = mark?.querySelector('del')?.textContent;
  const added = mark?.querySelector('ins')?.textContent;
  say(`Change ${changeAt} of ${total}: ${[removed ? `removed ${quote(removed)}` : '', added ? `added ${quote(added)}` : ''].filter(Boolean).join(', ')}.`);
}

const okSnapshotOfVersion = (v: Version) => (v.capture.snapshot?.status === 'ok' ? v.capture.snapshot : null);

/** What a comparison shows instead of marked text: an error, too many differences, or none; null when there are changes to mark or texts are read. */
function compareMessage(older: Version, newer: Version, diff: TextDiff | null | undefined, error: string | null): string | null {
  if (error) return `The saved texts could not be read: ${error}`;
  if (diff === null) {
    const [a, b] = [okSnapshotOfVersion(older)!, okSnapshotOfVersion(newer)!];
    return `The texts differ in too many places to mark the changes. Capture ${older.number} has ${count(a.character_count, 'character')}, capture ${newer.number} has ${fmtNumber(b.character_count)}.`;
  }
  return diff && !diff.changes ? 'The saved texts are the same.' : null;
}

function compareBody(older: Version, newer: Version, diff: TextDiff | null | undefined, message: string | null): Child[] {
  if (message) return [h('div', { class: 'no-text' }, [message])];
  if (!diff) return [h('div', { class: 'text-box', attrs: { 'aria-busy': 'true' } }, ['Loading texts…'])];
  const [a, b] = [okSnapshotOfVersion(older)!, okSnapshotOfVersion(newer)!];
  const cut = [[older, a], [newer, b]] as const;
  return [
    diffBox(diff, older, newer),
    h('p', { class: 'diff-legend' }, [
      h('ins', {}, ['Added']),
      ` since capture ${older.number} · `,
      h('del', {}, ['Removed']),
      ' · Every difference in the saved text is marked, including a date or a counter that changes on every visit.',
      ...cut
        .filter(([, s]) => s.truncated)
        .map(([v, s]) => ` Capture ${v.number} kept only the first ${fmtNumber(s.character_count)} characters of the page; text past that point shows as added or removed even where the page did not change.`),
    ]),
  ];
}

/** Both texts in one: unchanged paragraphs, removed and added words; unchanged paragraphs away from changes are folded. */
function diffBox(diff: TextDiff, older: Version, newer: Version): HTMLElement {
  const { blocks } = diff;
  const shown = blocks.map((b, i) => b.kind === 'changed' || blocks[i - 1]?.kind === 'changed' || blocks[i + 1]?.kind === 'changed' || unfolded.has(i));
  const children: Child[] = [];
  let n = 0;
  for (let i = 0; i < blocks.length; ) {
    if (i) children.push('\n\n');
    const block = blocks[i]!;
    let end = i;
    while (end < blocks.length && !shown[end]) end++;
    if (end - i >= 2) {
      const start = i;
      children.push(
        h('button', { class: 'diff-fold', attrs: { type: 'button', 'aria-label': `Show ${count(end - start, 'unchanged paragraph')}` }, on: { click: () => unfold(start, end) } }, [
          count(end - start, 'unchanged paragraph'),
        ]),
      );
      i = end;
      continue;
    }
    if (block.kind === 'same') children.push(block.text);
    else children.push(...block.parts.map((part) => ('same' in part ? part.same : changeMark(part, ++n))));
    i++;
  }
  return h('div', { class: 'text-box diff-box', attrs: { tabindex: '0', 'aria-label': `Changes from capture ${older.number} to capture ${newer.number}` } }, children);
}

function changeMark(part: Exclude<DiffPart, { same: string }>, n: number): HTMLElement {
  return h('span', { class: `chg${n === changeAt ? ' now' : ''}`, attrs: { 'data-change': String(n) } }, [
    part.removed ? h('del', {}, [part.removed]) : null,
    part.added ? h('ins', {}, [part.added]) : null,
  ]);
}

function unfold(start: number, end: number): void {
  for (let i = start; i < end; i++) unfolded.add(i);
  renderReader();
  document.querySelector<HTMLElement>('#reader .diff-box')?.focus({ preventScroll: true });
}

/** Capture goes to the active session, so filling a source of another session needs that session made active first. */
function activeSessionBanner(row: LibraryRow): Child {
  if (row.session.id === activeId || row.status === 'ok') return null;
  const active = sessionOf(activeId)?.name ?? 'Inbox';
  return h('div', { class: 'banner info' }, [
    h('span', {}, [
      'Clip page saves to the active session, ',
      h('b', {}, [active]),
      `. To add the text to ${row.label}, make `,
      h('b', {}, [row.session.name]),
      ' active, open the page and clip it.',
    ]),
    h('button', { attrs: { id: 'make-active', type: 'button' }, on: { click: () => void makeActive(row.session.id) } }, ['Make active']),
  ]);
}

async function makeActive(sessionId: string): Promise<void> {
  await setActiveSessionId(sessionId);
  activeId = sessionId;
  renderNav();
  renderReader();
  $('open-page')?.focus();
}

function renderNarrowTop(row: LibraryRow | undefined): void {
  $('back-button').textContent = `‹ ${viewName()}`;
  const index = row ? shown.indexOf(row) : -1;
  $('narrow-position').textContent = row && index >= 0 ? `${row.label} · ${fmtNumber(index + 1)} of ${fmtNumber(shown.length)}` : '';
}

function renderReader(): void {
  const restore = keepNoteFocus();
  renderReaderContents();
  restore();
  highlightMatches();
  if (scrollToCompare && selectedRow()) {
    scrollToCompare = false;
    document.querySelector('#reader .compare-bar')?.closest('.stack')?.scrollIntoView({ block: 'start' });
  }
}

function renderReaderContents(): void {
  const reader = $('reader');
  const row = selectedRow();
  renderNarrowTop(row);
  const actionSession = row?.session ?? sessionOf(filter.view);
  $('narrow-session-actions').hidden = !actionSession;
  expandButton.hidden = !row;
  applyLayout();
  if (logShown()) return renderRemoval(reader);
  if (!row && !selectedId && mode === 'pivots') return renderPivot(reader);
  if (!row) {
    reader.replaceChildren(
      h('div', { class: 'empty' }, [
        h('p', {}, [
          selectedId
            ? 'This source is no longer in the library. It was deleted, joined another source when it was moved, or its only capture was undone.'
            : 'Select a source to read its saved text and earlier versions.',
        ]),
      ]),
    );
    return;
  }
  const { entry, session } = row;
  if (comparing && comparing.source !== entry.source.id) setComparing(null);
  const versions = versionsOf(entry);
  const current = versions.find((v) => v.current);
  const viewed = versions.find((v) => v.capture.capture.id === viewedCaptureId) ?? current ?? versions[0]!;
  viewedCaptureId = viewed.capture.capture.id;
  const other = comparedWith(viewed, versions);
  const compared = textComparisons(entry.captures);
  const url = entry.source.dedup_url;
  const group = h(
    'div',
    { attrs: { role: 'radiogroup', 'aria-label': `Captures of ${row.label}` } },
    versions.map((v) => {
      const comparison = compared.get(v.capture.capture.id);
      return versionButton(v, v === viewed, comparison && comparisonLine(comparison), v === other);
    }),
  );
  group.addEventListener('keydown', (event) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = versions.indexOf(viewed);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? versions.length - 1 : (index + moves[event.key]! + versions.length) % versions.length;
    viewCapture(versions[next]!.capture.capture.id);
  });
  const pageCode = pageCodeView(viewed.capture.capture, viewed.capture.snapshot);
  const details = h('details', { on: { toggle: () => (detailsOpen = details.open) } }, [
    h('summary', {}, ['Details']),
    h(
      'dl',
      { class: 'details' },
      [...sourceRows(entry, session.name), ...captureDetailRows(viewed.capture.capture, viewed.capture.snapshot, url)].flatMap((r) => [
        h('dt', {}, [r.label]),
        h('dd', { class: r.mono ? 'mono' : '' }, [r.value]),
      ]),
    ),
    h('p', { class: 'small' }, [
      'The SHA-256 identifies the exact saved text, so a copy can be checked for changes. It does not prove what the page showed or who published it.',
    ]),
    pageCode ? pageCodeBlock(pageCode) : null,
  ]);
  details.open = detailsOpen;
  fill(reader, [
    h('div', { class: 'crumb' }, [
      h('span', { class: 'sid' }, [row.label]),
      h('span', {}, ['·']),
      h('button', { class: 'link', attrs: { type: 'button', title: `Show all sources of ${session.name}` }, on: { click: () => setView(session.id) } }, [session.name]),
      session.archived_at ? h('span', { class: 'chip pending' }, ['Archived']) : null,
      h(
        'button',
        {
          class: 'btn-sm reader-actions important-toggle',
          attrs: { id: 'important-source', type: 'button', 'aria-pressed': String(entry.source.important), title: entry.source.important ? 'Marked important. Click to unmark.' : 'Mark as important' },
          on: { click: () => void toggleImportant(row) },
        },
        [icon(entry.source.important ? 'star-fill' : 'star'), 'Important'],
      ),
      h('button', { class: 'btn-sm', attrs: { id: 'move-source', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => openMove(row) } }, [icon('folder-simple'), 'Move to…']),
      h('button', { class: 'btn-sm delete', attrs: { id: 'delete-source', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => void confirmDeleteSource(row) } }, [icon('trash'), 'Delete…']),
      expandButton,
    ]),
    h('h3', { class: row.title ? '' : 'untitled' }, [row.title ?? '(title not captured)']),
    readerThumb(entry, viewed.capture.capture.id),
    h('div', { class: 'url-row' }, [
      h('img', { class: 'fav-sm', attrs: { src: faviconUrl(url), alt: '' } }),
      h('span', { class: 'url' }, [url]),
      h('a', { class: 'btn-sm', attrs: { id: 'open-page', href: url, target: '_blank', rel: 'noopener noreferrer' } }, [icon('arrow-square-out'), 'Open page']),
    ]),
    h('div', { class: 'status-line' }, [chip(row.status), h('span', {}, [statusSentence(entry)])]),
    activeSessionBanner(row),
    editNote('source', entry.source.id, entry.source.note, 'Source note'),
    h('div', { class: 'versions' }, [
      h('div', { class: 'versions-head' }, [
        h('span', { class: 'section-title' }, ['Captures']),
        h('span', { class: 'small' }, [versions.length > 1 ? `${versions.length} · newest first` : '1']),
      ]),
      group,
    ]),
    ...pathBlocks(row),
    viewedSection(viewed, current, versions, other),
    details,
  ]);
}

/** The source's visits and the sources it led to, under its captures; nothing when there are none. */
function pathBlocks(row: LibraryRow): Child[] {
  const session = rows.filter((r) => r.session.id === row.session.id).map((r) => r.entry);
  const byAddress = sourcesByAddress(session);
  const led = ledTo(row.entry, session);
  const visits = row.entry.visits;
  return [
    visits.length
      ? h('div', { class: 'path-block' }, [
          h('span', { class: 'section-title' }, [`Visited again · ${visits.length}`]),
          ...visits.map((visit) => h('div', { class: 'visit-row' }, [h('span', { class: 'mono-t' }, [fmtTime(visit.captured_at)]), ' · ', ...withLabels(arrival(visit, byAddress) ?? '')])),
        ])
      : null,
    led.length
      ? h('div', { class: 'path-block' }, [
          h('span', { class: 'section-title' }, [`Led to · ${led.length}`]),
          ...led.map((target) => {
            const title = rows.find((r) => r.entry.source.id === target.source.id)?.title ?? target.source.dedup_url;
            return h('button', { class: 'led-to', attrs: { type: 'button' }, on: { click: () => openSource(target.source.id, true) } }, [
              h('span', { class: 'sid' }, [sourceLabel(target.source)]),
              h('span', {}, [title]),
            ]);
          }),
        ])
      : null,
  ];
}

/** Marks the open source important, or not; the list and the reader show it at once. */
async function toggleImportant(row: LibraryRow): Promise<void> {
  const source = row.entry.source;
  const important = !source.important;
  try {
    await setSourceImportant(db, source.id, important);
    source.important = important;
  } catch (error) {
    notice(`Not saved: ${errorText(error)}`);
  }
  const restore = keepListFocus();
  renderList();
  restore();
  renderReader();
  document.getElementById('important-source')?.focus();
}

// ---------- Organizing ----------

const dialog = $<HTMLDialogElement>('library-dialog');
let dialogOpener: HTMLElement | null = null;
/** False when a click elsewhere closed the dialog: focus then stays where the user clicked. */
let restoreDialogFocus = true;
/** True while a confirmation replaces the session menu it was opened from. */
let replacingMenu = false;

function notice(message: string): void {
  $('library-notice').textContent = message;
  $('library-notice').hidden = false;
}

function openDialog(title: string, body: Child[], opener: HTMLElement | null, sessionMenu = false): void {
  // Chrome cannot turn an open session menu into a modal dialog, so the menu closes first.
  if (dialog.open) {
    replacingMenu = true;
    dialog.close();
  }
  dialogOpener = opener;
  dialog.classList.toggle('session-dialog', sessionMenu);
  dialog.style.removeProperty('left');
  dialog.style.removeProperty('top');
  fill(dialog, [
    h('div', { class: 'row between' }, [h('h2', {}, [title]), h('button', { class: 'close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, [icon('x')])]),
    ...body,
    h('p', { class: 'dialog-error', attrs: { id: 'dialog-error', role: 'alert', hidden: '' } }),
  ]);
  if (sessionMenu && opener) {
    const rect = opener.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 268))}px`;
    dialog.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - 200))}px`;
  }
  // Moving focus to a dialog must not replace a note draft changed in another view.
  document.querySelectorAll<HTMLElement>('.note-editor').forEach((e) => { e.inert = true; });
  // A session menu is not modal: a click anywhere else closes it and still does its job.
  if (sessionMenu) opener?.setAttribute('aria-expanded', 'true');
  if (sessionMenu) dialog.show();
  else dialog.showModal();
}

/** Closes the dialog after a click outside it, leaving focus where the user clicked. */
function dismissDialog(): void {
  restoreDialogFocus = false;
  dialog.close();
}

function dialogFailure(message: string): void {
  $('dialog-error').textContent = message;
  $('dialog-error').hidden = false;
}

function openSessionActions(session: Session, opener: HTMLElement): void {
  if (dialog.open && dialogOpener === opener) return dialog.close();
  if (session.id === INBOX_SESSION_ID) {
    openDialog(session.name, [
      h('button', { class: 'delete', attrs: { type: 'button', id: 'empty-inbox' }, on: { click: () => void confirmEmptyInbox(opener) } }, ['Empty Inbox…']),
    ], opener, true);
    return;
  }
  const archive = session.archived_at === null;
  openDialog(session.name, [
    h('button', { attrs: { type: 'button', id: 'archive-session' }, on: { click: () => void archiveSession(session, archive) } }, [archive ? 'Archive session' : 'Unarchive session']),
    h('p', { class: 'small' }, [archive ? (session.id === activeId ? 'Keeps all data. New clips go to Inbox.' : 'Keeps all data in Archived.') : 'Returns to Sessions. Active session unchanged.']),
    h('button', { class: 'delete', attrs: { type: 'button', id: 'delete-session' }, on: { click: () => void confirmDeleteSession(session, opener) } }, ['Delete session…']),
  ], opener, true);
}

async function archiveSession(session: Session, archive: boolean): Promise<void> {
  const button = $<HTMLButtonElement>('archive-session');
  button.disabled = true;
  let changed = false;
  try {
    await finishNoteWrites();
    await setSessionArchived(db, session.id, archive);
    changed = true;
    if (archive && await getActiveSessionId() === session.id) await setActiveSessionId(INBOX_SESSION_ID);
    activeId = await getActiveSessionId();
    if (archive) archivedOpen = true;
    await reload();
    dialog.close();
    notice(`Session "${session.name}" ${archive ? 'archived' : 'unarchived'}.`);
  } catch (error) {
    dialogFailure(`${changed ? 'Session changed; refresh or active-session update failed' : 'Session not changed'}: ${errorText(error)}`);
  } finally { button.disabled = false; }
}

// ---------- Deleting ----------

/** A deletion confirmation. Cancel has focus, so Enter never deletes by accident. */
function openDeletion(title: string, text: DeletionText, confirmLabel: string, run: () => Promise<void>, opener: HTMLElement | null): void {
  const cancel = h('button', { attrs: { type: 'button' }, on: { click: () => dialog.close() } }, ['Cancel']);
  openDialog(title, [
    ...text.main.map((line) => h('p', {}, [line])),
    ...text.small.map((line) => h('p', { class: 'small' }, [line])),
    h('div', { class: 'row' }, [h('button', { class: 'danger', attrs: { type: 'button', id: 'confirm-delete' }, on: { click: () => void run() } }, [confirmLabel]), cancel]),
  ], opener);
  cancel.focus();
}

/** Runs a deletion from the open confirmation and reports what happened, also when only the refresh failed. */
async function runDeletion(work: () => Promise<string>, failed: string, refreshFailed: string): Promise<void> {
  const button = $<HTMLButtonElement>('confirm-delete');
  button.disabled = true;
  let done = false;
  try {
    // Note edits finish first; a note that failed to save does not block deleting it.
    await finishNoteWrites().catch(() => undefined);
    const message = await work();
    done = true;
    writeHash();
    await reload();
    dialog.close();
    notice(message);
  } catch (error) {
    dialogFailure(`${done ? refreshFailed : failed}: ${errorText(error)}`);
  } finally { button.disabled = false; }
}

async function confirmDeleteSource(row: LibraryRow, opener: HTMLElement = $('delete-source')): Promise<void> {
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, row.session.id, row.entry.source.id), getLastBackupAt()]);
  const text = sourceDeletionText(row.label, row.title ?? row.entry.source.dedup_url, counts, lastBackupAt);
  openDeletion(`Delete ${row.label}?`, text, `Delete ${row.label}`, () => runDeletion(async () => {
    await deleteSource(db, row.entry.source.id);
    selectedId = null;
    viewedCaptureId = null;
    await dropExcludedSources(row.session.id, [row.entry.source.id]).catch(() => undefined);
    return `${row.label} deleted.`;
  }, `${row.label} not deleted`, `${row.label} deleted; refresh failed`), opener);
}

async function confirmDeleteSelected(): Promise<void> {
  const chosen = shown.filter((r) => picked.has(r.entry.source.id));
  if (chosen.length === 1) return confirmDeleteSource(chosen[0]!, $('delete-selected'));
  if (!chosen.length) return;
  const ids = chosen.map((r) => r.entry.source.id);
  const sessionIds = [...new Set(chosen.map((r) => r.session.id))];
  const labels = chosen.map((r) => r.entry.source.number).sort((a, b) => a - b).map((n) => `S${n}`);
  const [counts, lastBackupAt] = await Promise.all([countSourcesForDeletion(db, ids), getLastBackupAt()]);
  const what = count(chosen.length, 'source');
  openDeletion(`Delete ${what}?`, sourcesDeletionText(labels, sessionIds.length, counts, lastBackupAt), `Delete ${what}`, () => runDeletion(async () => {
    await deleteSources(db, ids);
    clearPicked();
    if (selectedId && ids.includes(selectedId)) {
      selectedId = null;
      viewedCaptureId = null;
    }
    for (const sessionId of sessionIds) {
      await dropExcludedSources(sessionId, chosen.filter((r) => r.session.id === sessionId).map((r) => r.entry.source.id)).catch(() => undefined);
    }
    return `${what} deleted.`;
  }, 'Sources not deleted', 'Sources deleted; refresh failed'), $('delete-selected'));
}

async function confirmDeleteSession(session: Session, opener: HTMLElement): Promise<void> {
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, session.id), getLastBackupAt()]);
  const active = session.id === activeId;
  openDeletion(`Delete session "${session.name}"?`, sessionDeletionText(session.name, counts, active, lastBackupAt), 'Delete session', () => runDeletion(async () => {
    await deleteSession(db, session.id);
    await removeJobSettings(session.id).catch(() => undefined);
    if (await getActiveSessionId() === session.id) await setActiveSessionId(INBOX_SESSION_ID);
    activeId = await getActiveSessionId();
    if (filter.view === session.id) filter.view = ALL_SOURCES;
    if (selectedRow()?.session.id === session.id) {
      selectedId = null;
      viewedCaptureId = null;
    }
    return `Session "${session.name}" deleted.${active ? ' New clips go to the Inbox.' : ''}`;
  }, 'Session not deleted', 'Session deleted; refresh failed'), opener);
}

async function confirmEmptyInbox(opener: HTMLElement): Promise<void> {
  const inbox = sessionOf(INBOX_SESSION_ID);
  if (!inbox) return;
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, INBOX_SESSION_ID), getLastBackupAt()]);
  if (!counts.sources && !counts.jobs) {
    dialog.close();
    notice('The Inbox is empty.');
    return;
  }
  openDeletion('Empty Inbox?', inboxEmptyingText(counts, inbox.next_source_number, lastBackupAt), 'Empty Inbox', () => runDeletion(async () => {
    await emptyInbox(db);
    await dropExcludedSources(INBOX_SESSION_ID, 'all').catch(() => undefined);
    if (selectedRow()?.session.id === INBOX_SESSION_ID) {
      selectedId = null;
      viewedCaptureId = null;
    }
    return 'Inbox emptied.';
  }, 'Inbox not emptied', 'Inbox emptied; refresh failed'), opener);
}

function openMove(row: LibraryRow): void {
  const targets = data.sessions.filter((s) => s.id !== row.session.id);
  openDialog(`Move ${row.label} to another session`, [
    h('p', {}, [`All captures move. ${row.label} is retired here. The target assigns a label or joins the same address.`]),
    h('div', { class: 'move-targets' }, targets.map((s) => h('button', {
      attrs: { type: 'button', 'data-target': s.id }, on: { click: () => void moveSelected(row, s) },
    }, [h('span', {}, [`${s.name}${s.archived_at ? ' (archived)' : ''}`]), h('span', { class: 'small' }, [count(rows.filter((r) => r.session.id === s.id).length, 'source')])]))),
    targets.length ? null : h('p', { class: 'small' }, ['Create another session in the side panel first.']),
    h('button', { attrs: { type: 'button' }, on: { click: () => dialog.close() } }, ['Cancel']),
  ], $('move-source'));
}

async function moveSelected(row: LibraryRow, target: Session): Promise<void> {
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-target]'));
  buttons.forEach((b) => { b.disabled = true; });
  let moved = false;
  try {
    await finishNoteWrites();
    const fresh = await loadLibrary(db);
    const source = fresh.sources.find((s) => s.source.id === row.entry.source.id)?.source;
    if (!source || source.session_id !== row.session.id) throw new Error('Source changed elsewhere. Close and retry.');
    const result = await moveSource(db, source.id, target.id);
    moved = true;
    selectedId = result.source.id;
    filter.view = target.id;
    filter.query = '';
    filter.status = 'any';
    // The sources a value was in are not the moved source's, which can have joined another.
    filter.pivot = null;
    showSearch();
    $<HTMLSelectElement>('status-filter').value = 'any';
    writeHash();
    // Settings belong to the source session, which need not be the active session.
    let cleanupError: unknown;
    try {
      const settings = await getJobSettings(source.session_id);
      if (settings.excluded_source_ids.includes(source.id)) {
        await saveJobSettings(source.session_id, { ...settings, excluded_source_ids: settings.excluded_source_ids.filter((id) => id !== source.id) });
      }
    } catch (error) { cleanupError = error; }
    await reload();
    dialog.close();
    notice(`Moved ${row.label} to ${target.name} ${result.joined ? '· joined' : 'as'} S${result.source.number}.${cleanupError ? ` Job settings not updated: ${errorText(cleanupError)}` : ''}`);
  } catch (error) {
    dialogFailure(`${moved ? 'Source moved; refresh failed' : 'Source not moved'}: ${errorText(error)}`);
  } finally { buttons.forEach((b) => { b.disabled = false; }); }
}

// ---------- Loading and live updates ----------

/** Reads the library again after a change elsewhere, keeping the open source, focus and scroll positions. */
async function reload(): Promise<void> {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focus = active?.dataset.id ? { id: active.dataset.id, capture: active.dataset.capture, inRows: !!active.closest('#rows') } : null;
  const restoreRow = keepListFocus();
  // Reader controls such as Next keep focus by their ID; notes keep it with their caret below.
  const control = !focus && active?.id && active.closest('#reader') && active.tagName !== 'TEXTAREA' ? active.id : '';
  const restoreNote = keepNoteFocus();
  const scroll = [$('list-col').scrollTop, $('reader-col').scrollTop] as const;
  [data, thumbIds] = await Promise.all([loadLibrary(db), thumbnailIds(db)]);
  rows = libraryRows(data);
  if (filter.view !== ALL_SOURCES && !logShown() && !sessionOf(filter.view)) filter.view = ALL_SOURCES;
  renderNav();
  renderList();
  renderReader();
  $('list-col').scrollTop = scroll[0];
  $('reader-col').scrollTop = scroll[1];
  restoreNote();
  if (control) document.getElementById(control)?.focus({ preventScroll: true });
  // A value of Pivots and an entry of the deletion log keep focus by their keys.
  if (active?.dataset.pivot !== undefined || active?.dataset.entry !== undefined) restoreRow();
  if (focus) {
    const where = focus.inRows ? '#rows' : '#reader';
    const event = focus.capture ? document.querySelector<HTMLElement>(`${where} [data-capture="${CSS.escape(focus.capture)}"]`) : null;
    (event ?? document.querySelector<HTMLElement>(`${where} [data-id="${CSS.escape(focus.id)}"]`))?.focus({ preventScroll: true });
  }
}

function bind(): void {
  const sort = $<HTMLSelectElement>('sort');
  sort.replaceChildren(...Object.entries(SORT_LABELS).map(([value, label]) => h('option', { attrs: { value } }, [label])));
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      clearPicked();
      const value = (event.target as HTMLInputElement).value;
      if (logShown()) logFilter.query = value;
      else if (mode === 'pivots') pivotFilter.query = value;
      else filter.query = value;
      renderList();
      highlightMatches();
    }, 120);
  });
  $<HTMLSelectElement>('status-filter').addEventListener('change', (event) => {
    clearPicked();
    filter.status = (event.target as HTMLSelectElement).value as LibraryFilter['status'];
    renderList();
  });
  sort.addEventListener('change', () => {
    filter.sort = sort.value as LibrarySort;
    renderList();
  });
  $('important-filter').addEventListener('click', () => {
    clearPicked();
    filter.important = !filter.important;
    renderList();
  });
  $('mode-sources').addEventListener('click', () => setMode('sources'));
  $('mode-timeline').addEventListener('click', () => setMode('timeline'));
  $('mode-pivots').addEventListener('click', () => setMode('pivots'));
  const kind = $<HTMLSelectElement>('pivot-kind');
  const kinds: Array<[string, string]> = [['all', 'All kinds'], ...Object.entries(PIVOT_GROUPS)];
  kind.replaceChildren(...kinds.map(([value, label]) => h('option', { attrs: { value } }, [label])));
  kind.addEventListener('change', () => {
    pivotFilter.group = kind.value as PivotFilter['group'];
    renderList();
  });
  $('shared-only').addEventListener('click', () => {
    pivotFilter.shared = !pivotFilter.shared;
    renderList();
  });
  const logSession = $<HTMLSelectElement>('log-session');
  logSession.addEventListener('change', () => {
    logFilter.session = logSession.value;
    renderList();
  });
  $('clear-log').addEventListener('click', () => void confirmClearLog());
  $('pivot-filter').addEventListener('click', () => {
    clearPicked();
    filter.pivot = null;
    renderList();
    $('search').focus();
  });
  $('clear-filters').addEventListener('click', clearFilters);
  $<HTMLInputElement>('select-all').addEventListener('change', (event) => {
    if ((event.target as HTMLInputElement).checked) for (const row of shown) picked.add(row.entry.source.id);
    else clearPicked();
    renderSelection();
  });
  $('clear-selection').addEventListener('click', () => {
    clearPicked();
    renderSelection();
    rowButtons().find((b) => b.tabIndex === 0)?.focus();
  });
  $('delete-selected').addEventListener('click', () => void confirmDeleteSelected());
  $('hide-sessions').addEventListener('click', () => changeLayout({ sessions_hidden: true }, $('show-sessions')));
  $('show-sessions').addEventListener('click', () => changeLayout({ sessions_hidden: false }, $('hide-sessions')));
  bindResize($('resize-nav'), 'nav_width', NAV_WIDTH, () => 0);
  bindResize($('resize-list'), 'list_width', LIST_WIDTH, () => (layout.sessions_hidden ? 0 : layout.nav_width));
  expandButton.addEventListener('click', () => changeLayout({ reader_expanded: !document.body.classList.contains('reader-expanded') }));
  $<HTMLSelectElement>('view-select').addEventListener('change', (event) => setView((event.target as HTMLSelectElement).value));
  $('back-button').addEventListener('click', () => {
    setReading(false);
    selectedButton()?.focus();
  });
  // Arrow keys move through the list; in a wide window the source under focus opens next to it.
  $('rows').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = rowButtons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const button = buttons[next]!;
    setTabStop(button);
    button.focus();
    if (!wide.matches) return;
    if (button.dataset.entry !== undefined) return openRemoval(button.dataset.entry, false);
    if (button.dataset.pivot !== undefined) openPivot(button.dataset.pivot, false);
    if (!button.dataset.id) return;
    if (button.dataset.capture) openEvent(button.dataset.id, button.dataset.capture, false);
    else openSource(button.dataset.id, false);
  });
  window.addEventListener('hashchange', () => {
    readHash();
    showSearch();
    // A capture and comparison from the side panel are opened once, so the same link works again.
    writeHash();
    renderNav();
    renderList();
    renderReader();
    selectedButton()?.scrollIntoView({ block: 'nearest' });
  });
  browser.storage.onChanged.addListener((changes, area) => {
    const id = changes.activeSessionId?.newValue;
    if (area !== 'local' || typeof id !== 'string') return;
    activeId = id;
    renderNav();
    renderReader();
  });
  onDataChange(() => void reload().catch((error) => notice(`Refresh failed: ${errorText(error)}`)));
  $('narrow-session-actions').addEventListener('click', (event) => {
    const session = selectedRow()?.session ?? sessionOf(filter.view);
    if (session) openSessionActions(session, event.currentTarget as HTMLElement);
  });
  dialog.addEventListener('close', () => {
    document.querySelectorAll('[aria-haspopup][aria-expanded="true"]').forEach((b) => b.removeAttribute('aria-expanded'));
    if (replacingMenu) return void (replacingMenu = false);
    document.querySelectorAll<HTMLElement>('.note-editor').forEach((e) => { e.inert = false; });
    // An opener the action removed or disabled, such as Clear log on an empty log, cannot take focus back.
    const opener = dialogOpener?.isConnected && !(dialogOpener as HTMLButtonElement).disabled ? dialogOpener : null;
    if (restoreDialogFocus) (opener ?? document.getElementById('move-source') ?? $('search')).focus({ preventScroll: true });
    restoreDialogFocus = true;
  });
  // A session menu closes on a press anywhere else (its own ··· button toggles it instead).
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node;
    if (dialog.open && !dialog.contains(target) && !dialogOpener?.contains(target)) dismissDialog();
  }, true);
  // A click on the backdrop of a modal dialog cancels it, like Cancel.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  document.addEventListener('keydown', (event) => {
    // "/" jumps to the search field, as in many web apps.
    const target = event.target as HTMLElement;
    if (event.key === '/' && !dialog.open && !target.closest('input, textarea, select, [contenteditable]')) {
      event.preventDefault();
      $('search').focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    // Escape closes a modal dialog by itself; the session menu needs this.
    if (event.key === 'Escape' && dialog.open && dialog.classList.contains('session-dialog')) dialog.close();
  });
}

async function init(): Promise<void> {
  hydrateIcons();
  bind();
  try {
    db = await openDb();
    setWriteListener(announceDataChange);
    activeId = await getActiveSessionId();
    layout = await getLibraryLayout();
    [data, thumbIds] = await Promise.all([loadLibrary(db), thumbnailIds(db)]);
    rows = libraryRows(data);
    readHash();
    writeHash();
    renderNav();
    renderList();
    renderReader();
    selectedButton()?.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    $('reader').replaceChildren(h('div', { class: 'empty' }, [h('p', {}, [`ClipGrail could not load its data: ${errorText(error)}`])]));
  }
}

void init();
