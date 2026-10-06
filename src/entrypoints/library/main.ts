import './style.css';
import { browser } from 'wxt/browser';
import { announceDataChange, onDataChange } from '../../lib/changes';
import { countForDeletion, countSourcesForDeletion, deleteSession, deleteSource, deleteSources, emptyInbox, loadLibrary, loadSnapshotText, loadThumbnail, thumbnailIds, openDb, loadNote, moveSource, setSessionArchived, setWriteListener, updateSourceNote, updateCaptureNote } from '../../lib/db';
import type { LibraryData } from '../../lib/db';
import type { DeletionText } from '../../lib/describe';
import {
  STATUS_LABELS,
  captureDetailRows,
  captureHead,
  captureLine,
  fmtNumber,
  fmtTime,
  hostOf,
  inboxEmptyingText,
  sessionDeletionText,
  sourceDeletionText,
  sourcesDeletionText,
  sourceMeta,
  sourceRows,
  statusSentence,
} from '../../lib/describe';
import { $, fill, h } from '../../lib/dom';
import { faviconTile, faviconUrl } from '../../lib/favicon';
import { hydrateIcons, icon } from '../../lib/icons';
import type { Child } from '../../lib/dom';
import { ALL_SOURCES, SORT_LABELS, filterRows, libraryRows, versionsOf } from '../../lib/library';
import type { LibraryFilter, LibraryRow, LibrarySort, Version } from '../../lib/library';
import { INBOX_SESSION_ID } from '../../lib/model';
import type { Session } from '../../lib/model';
import type { SourceStatus } from '../../lib/selection';
import { describeFailure } from '../../lib/selection';
import { LIST_WIDTH, NAV_WIDTH, clampWidth, getActiveSessionId, setActiveSessionId, getJobSettings, saveJobSettings, getLibraryLayout, saveLibraryLayout, getLastBackupAt, dropExcludedSources, removeJobSettings } from '../../lib/settings';
import type { LibraryLayout, WidthRange } from '../../lib/settings';

import { finishNoteWrites, keepNoteFocus, noteEditor } from '../../lib/note-editor';

let db: IDBDatabase;
let data: LibraryData = { sessions: [], sources: [] };
let rows: LibraryRow[] = [];
let shown: LibraryRow[] = [];
let activeId = INBOX_SESSION_ID;
const filter: LibraryFilter = { view: ALL_SOURCES, query: '', status: 'any', sort: 'last-desc' };
let selectedId: string | null = null;
let viewedCaptureId: string | null = null;
let archivedOpen = false;
let detailsOpen = false;
/** Snapshot texts already read. A saved text never changes, so they can be kept. */
const texts = new Map<string, string>();
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
const viewName = () => (filter.view === ALL_SOURCES ? 'All sources' : (sessionOf(filter.view)?.name ?? 'All sources'));
const selectedRow = () => rows.find((r) => r.entry.source.id === selectedId);

// ---------- Address: #view=<session ID or all>&source=<source ID> (identifiers only) ----------

function readHash(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const view = params.get('view');
  filter.view = view && (view === ALL_SOURCES || sessionOf(view)) ? view : ALL_SOURCES;
  const source = params.get('source');
  if (source !== selectedId) viewedCaptureId = null;
  selectedId = source;
  setReading(!!selectedId);
}

function writeHash(): void {
  const params = new URLSearchParams({ view: filter.view });
  if (selectedId) params.set('source', selectedId);
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
      icon(key === ALL_SOURCES ? 'stack' : key === INBOX_SESSION_ID ? 'tray' : 'folder-simple'),
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
  ]);
  const option = (s: Session) => h('option', { attrs: { value: s.id } }, [`${s.name}${s.id === activeId ? ' · active' : ''} (${fmtNumber(counts.get(s.id) ?? 0)})`]);
  const select = $<HTMLSelectElement>('view-select');
  fill(select, [
    h('option', { attrs: { value: ALL_SOURCES } }, [`All sources (${fmtNumber(rows.length)})`]),
    ...current.map(option),
    archived.length ? h('optgroup', { attrs: { label: 'Archived' } }, archived.map(option)) : null,
  ]);
  select.value = filter.view;
}

function setView(view: string): void {
  clearPicked();
  filter.view = view;
  if (selectedId && view !== ALL_SOURCES && selectedRow()?.session.id !== view) {
    selectedId = null;
    viewedCaptureId = null;
  }
  setReading(false);
  writeHash();
  renderNav();
  renderList();
  renderReader();
  $('list-col').scrollTop = 0;
}

// ---------- Sources ----------

function listItem(row: LibraryRow, mixed: boolean): HTMLLIElement {
  const { entry } = row;
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
          'aria-label': `${row.label}${mixed ? ` in ${row.session.name}` : ''}: ${name}, ${STATUS_LABELS[row.status]}`,
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
          h('span', { class: `src-title${row.title ? '' : ' untitled'}` }, [name]),
          h('span', { class: 'src-meta' }, [
            mixed ? h('span', { class: 'sess', attrs: { title: row.session.name } }, [row.session.name]) : null,
            chip(row.status),
            h('span', { class: 'src-host' }, [hostOf(entry.source.dedup_url)]),
            h('span', {}, [meta]),
          ]),
        ]),
      ],
    ),
  ]);
}

const rowButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .src'));

/** One row is reachable with Tab: the open source if it is listed, else the first. */
function markSelected(): void {
  const buttons = rowButtons();
  for (const button of buttons) button.setAttribute('aria-current', String(button.dataset.id === selectedId));
  setTabStop(buttons.find((b) => b.dataset.id === selectedId) ?? buttons[0]);
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

function renderList(): void {
  shown = filterRows(rows, filter);
  const inView = filter.view === ALL_SOURCES ? rows.length : rows.filter((r) => r.session.id === filter.view).length;
  const narrowed = filter.query.trim() !== '' || filter.status !== 'any';
  $('list-title').textContent = viewName();
  $('result-count').textContent = narrowed ? `${fmtNumber(shown.length)} of ${count(inView, 'source')}` : count(inView, 'source');
  $('clear-filters').hidden = !narrowed;
  $('status-filter').classList.toggle('filter-on', filter.status !== 'any');
  $('search').classList.toggle('filter-on', filter.query.trim() !== '');
  const mixed = filter.view === ALL_SOURCES;
  $('rows').replaceChildren(...shown.map((row) => listItem(row, mixed)));
  const empty = $('list-empty');
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    fill(empty, [
      inView === 0
        ? h('p', {}, [filter.view === ALL_SOURCES ? 'No sources yet. Clip pages from the side panel and they appear here.' : 'This session has no sources yet.'])
        : h('p', {}, ['No sources match the search and status filter.']),
      inView > 0 ? h('button', { class: 'link', attrs: { type: 'button' }, on: { click: clearFilters } }, ['Clear filters']) : null,
    ]);
  }
  markSelected();
  renderSelection();
}

function clearFilters(): void {
  clearPicked();
  filter.query = '';
  filter.status = 'any';
  $<HTMLInputElement>('search').value = '';
  $<HTMLSelectElement>('status-filter').value = 'any';
  renderList();
  $('search').focus();
}

function openSource(id: string, userAction: boolean): void {
  if (selectedId !== id) {
    viewedCaptureId = null;
    $('reader-col').scrollTop = 0;
  }
  selectedId = id;
  markSelected();
  writeHash();
  renderReader();
  if (userAction && !wide.matches) {
    setReading(true);
    $('back-button').focus();
  }
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
    },
  });
}

function versionButton(version: Version, checked: boolean): HTMLButtonElement {
  const { capture, snapshot } = version.capture;
  const note = capture.note.trim();
  const meta = [fmtTime(capture.captured_at), captureLine(capture, snapshot), note ? `note: “${note.length > 80 ? `${note.slice(0, 80)}…` : note}”` : '']
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
      version.current ? h('span', { class: 'current-tag', attrs: { title: 'Research Jobs use this text' } }, ['Current text']) : h('span'),
    ],
  );
}

function viewCapture(captureId: string, focus = true): void {
  viewedCaptureId = captureId;
  renderReader();
  if (focus) document.querySelector<HTMLButtonElement>(`.ver[data-id="${captureId}"]`)?.focus();
}

async function loadText(snapshotId: string, box: HTMLElement): Promise<void> {
  try {
    const text = await loadSnapshotText(db, snapshotId);
    if (text !== undefined) texts.set(snapshotId, text);
    if (box.isConnected) box.textContent = text ?? 'The saved text is missing.';
  } catch (error) {
    if (box.isConnected) box.textContent = `The saved text could not be read: ${errorText(error)}`;
  }
}

function viewedSection(viewed: Version, current: Version | undefined, total: number): HTMLElement {
  const { capture, snapshot } = viewed.capture;
  const head = (left: string, right?: string) => h('div', { class: 'text-head' }, [h('span', {}, [left]), right ? h('span', {}, [right]) : null]);
  const which = `Viewing capture ${viewed.number} of ${total}`;
  const blocks: Child[] = [];
  if (snapshot?.status === 'ok') {
    const method = snapshot.extraction_method === 'readability' ? 'Readability' : 'visible page text';
    blocks.push(head(`${which} · Snapshot · ${fmtTime(snapshot.captured_at)} · ${method}`, `${fmtNumber(snapshot.character_count)} characters`));
    if (!viewed.current && current) {
      blocks.push(
        h('div', { class: 'banner earlier', attrs: { role: 'note' } }, [
          h('span', {}, [`Earlier version, for reading only. Research Jobs use the current text from capture ${current.number} (${fmtTime(current.capture.capture.captured_at)}).`]),
          h('button', { attrs: { id: 'show-current', type: 'button' }, on: { click: () => viewCapture(current.capture.capture.id) } }, ['Show current text']),
        ]),
      );
    }
    const box = h('pre', { class: 'text-box', attrs: { tabindex: '0', 'aria-label': `Saved text of capture ${viewed.number}` } }, [texts.get(snapshot.id) ?? 'Loading text…']);
    blocks.push(box);
    if (!texts.has(snapshot.id)) void loadText(snapshot.id, box);
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
}

function renderReaderContents(): void {
  const reader = $('reader');
  const row = selectedRow();
  renderNarrowTop(row);
  const actionSession = row?.session ?? sessionOf(filter.view);
  $('narrow-session-actions').hidden = !actionSession;
  expandButton.hidden = !row;
  applyLayout();
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
  const versions = versionsOf(entry);
  const current = versions.find((v) => v.current);
  const viewed = versions.find((v) => v.capture.capture.id === viewedCaptureId) ?? current ?? versions[0]!;
  viewedCaptureId = viewed.capture.capture.id;
  const url = entry.source.dedup_url;
  const group = h(
    'div',
    { attrs: { role: 'radiogroup', 'aria-label': `Captures of ${row.label}` } },
    versions.map((v) => versionButton(v, v === viewed)),
  );
  group.addEventListener('keydown', (event) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = versions.indexOf(viewed);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? versions.length - 1 : (index + moves[event.key]! + versions.length) % versions.length;
    viewCapture(versions[next]!.capture.capture.id);
  });
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
  ]);
  details.open = detailsOpen;
  fill(reader, [
    h('div', { class: 'crumb' }, [
      h('span', { class: 'sid' }, [row.label]),
      h('span', {}, ['·']),
      h('button', { class: 'link', attrs: { type: 'button', title: `Show all sources of ${session.name}` }, on: { click: () => setView(session.id) } }, [session.name]),
      session.archived_at ? h('span', { class: 'chip pending' }, ['Archived']) : null,
      h('button', { class: 'btn-sm reader-actions', attrs: { id: 'move-source', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => openMove(row) } }, [icon('folder-simple'), 'Move to…']),
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
    viewedSection(viewed, current, versions.length),
    details,
  ]);
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
    $<HTMLInputElement>('search').value = '';
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
  const focus = active?.dataset.id ? { id: active.dataset.id, inRows: !!active.closest('#rows') } : null;
  const restoreNote = keepNoteFocus();
  const scroll = [$('list-col').scrollTop, $('reader-col').scrollTop] as const;
  [data, thumbIds] = await Promise.all([loadLibrary(db), thumbnailIds(db)]);
  rows = libraryRows(data);
  if (filter.view !== ALL_SOURCES && !sessionOf(filter.view)) filter.view = ALL_SOURCES;
  renderNav();
  renderList();
  renderReader();
  $('list-col').scrollTop = scroll[0];
  $('reader-col').scrollTop = scroll[1];
  restoreNote();
  if (focus) document.querySelector<HTMLElement>(`${focus.inRows ? '#rows' : '#reader'} [data-id="${focus.id}"]`)?.focus({ preventScroll: true });
}

function bind(): void {
  const sort = $<HTMLSelectElement>('sort');
  sort.replaceChildren(...Object.entries(SORT_LABELS).map(([value, label]) => h('option', { attrs: { value } }, [label])));
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      clearPicked();
      filter.query = (event.target as HTMLInputElement).value;
      renderList();
      renderNarrowTop(selectedRow());
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
    rowButtons().find((b) => b.dataset.id === selectedId)?.focus();
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
    if (wide.matches && button.dataset.id) openSource(button.dataset.id, false);
  });
  window.addEventListener('hashchange', () => {
    readHash();
    renderNav();
    renderList();
    renderReader();
    rowButtons().find((b) => b.dataset.id === selectedId)?.scrollIntoView({ block: 'nearest' });
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
    if (restoreDialogFocus) (dialogOpener?.isConnected ? dialogOpener : document.getElementById('move-source') ?? $('search')).focus({ preventScroll: true });
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
    rowButtons().find((b) => b.dataset.id === selectedId)?.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    $('reader').replaceChildren(h('div', { class: 'empty' }, [h('p', {}, [`ClipGrail could not load its data: ${errorText(error)}`])]));
  }
}

void init();
