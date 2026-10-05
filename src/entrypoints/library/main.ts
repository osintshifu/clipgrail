import './style.css';
import { browser } from 'wxt/browser';
import { announceDataChange, onDataChange } from '../../lib/changes';
import { loadLibrary, loadSnapshotText, openDb, loadNote, moveSource, setSessionArchived, setWriteListener, updateSourceNote, updateCaptureNote } from '../../lib/db';
import type { LibraryData } from '../../lib/db';
import {
  STATUS_LABELS,
  captureDetailRows,
  captureHead,
  captureLine,
  fmtNumber,
  fmtTime,
  hostOf,
  sourceMeta,
  sourceRows,
  statusSentence,
} from '../../lib/describe';
import { $, fill, h } from '../../lib/dom';
import type { Child } from '../../lib/dom';
import { ALL_SOURCES, SORT_LABELS, filterRows, libraryRows, versionsOf } from '../../lib/library';
import type { LibraryFilter, LibraryRow, LibrarySort, Version } from '../../lib/library';
import { INBOX_SESSION_ID } from '../../lib/model';
import type { Session } from '../../lib/model';
import type { SourceStatus } from '../../lib/selection';
import { describeFailure } from '../../lib/selection';
import { getActiveSessionId, setActiveSessionId, getJobSettings, saveJobSettings, getLibraryLayout, saveLibraryLayout } from '../../lib/settings';
import type { LibraryLayout } from '../../lib/settings';

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
const wide = window.matchMedia('(min-width: 901px)');
let layout: LibraryLayout = { sessions_hidden: false, reader_expanded: false };
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

// ---------- Sessions ----------

function renderNav(): void {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.session.id, (counts.get(row.session.id) ?? 0) + 1);
  const current = data.sessions.filter((s) => s.archived_at === null);
  const archived = data.sessions.filter((s) => s.archived_at !== null);
  if (archived.some((s) => s.id === filter.view)) archivedOpen = true;
  const item = (key: string, name: string, n: number, session?: Session) => {
    const button = h('button', { class: 'nav-item', attrs: { type: 'button', 'aria-current': String(filter.view === key) }, on: { click: () => setView(key) } }, [
      h('span', { class: 'name', attrs: { title: name } }, [name]),
      session?.id === activeId ? h('span', { class: 'active-tag', attrs: { title: 'Active session: new clips go here' } }, ['Active']) : null,
      h('span', { class: 'count' }, [fmtNumber(n)]),
    ]);
    if (!session || session.id === INBOX_SESSION_ID) return button;
    return h('div', { class: 'nav-row' }, [button,
      h('button', { class: 'session-actions', attrs: { type: 'button', 'data-session': session.id, 'aria-label': `Actions for ${name}`, 'aria-haspopup': 'dialog' }, on: { click: (event) => openSessionActions(session, event.currentTarget as HTMLElement) } }, ['···']),
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
    [h('span', { class: 'name' }, [`${archivedOpen ? '▾' : '▸'} Archived`]), h('span', { class: 'count' }, [fmtNumber(archived.length)])],
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
  return h('li', {}, [
    h(
      'button',
      {
        class: 'src',
        attrs: {
          type: 'button',
          tabindex: '-1',
          'data-id': entry.source.id,
          'aria-current': String(entry.source.id === selectedId),
          'aria-label': `${row.label}${mixed ? ` in ${row.session.name}` : ''}: ${name}, ${STATUS_LABELS[row.status]}`,
        },
        on: { click: () => openSource(entry.source.id, true) },
      },
      [
        h('span', { class: 'sid' }, [row.label]),
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
  const focusable = buttons.find((b) => b.dataset.id === selectedId) ?? buttons[0];
  for (const button of buttons) {
    button.setAttribute('aria-current', String(button.dataset.id === selectedId));
    button.tabIndex = button === focusable ? 0 : -1;
  }
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
}

function clearFilters(): void {
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
  $('narrow-session-actions').hidden = !actionSession || actionSession.id === INBOX_SESSION_ID;
  expandButton.hidden = !row;
  applyLayout();
  if (!row) {
    reader.replaceChildren(
      h('div', { class: 'empty' }, [
        h('p', {}, [
          selectedId
            ? 'This source is no longer in the library. It joined another source when it was moved, or its only capture was undone.'
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
      h('button', { class: 'btn-sm reader-actions', attrs: { id: 'move-source', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => openMove(row) } }, ['Move to…']),
      expandButton,
    ]),
    h('h3', { class: row.title ? '' : 'untitled' }, [row.title ?? '(title not captured)']),
    h('div', { class: 'url-row' }, [
      h('span', { class: 'url' }, [url]),
      h('a', { class: 'btn-sm', attrs: { id: 'open-page', href: url, target: '_blank', rel: 'noopener noreferrer' } }, ['Open page ↗']),
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

function notice(message: string): void {
  $('library-notice').textContent = message;
  $('library-notice').hidden = false;
}

function openDialog(title: string, body: Child[], opener: HTMLElement | null, sessionMenu = false): void {
  dialogOpener = opener;
  dialog.classList.toggle('session-dialog', sessionMenu);
  dialog.style.removeProperty('left');
  dialog.style.removeProperty('top');
  fill(dialog, [
    h('div', { class: 'row between' }, [h('h2', {}, [title]), h('button', { class: 'close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => dialog.close() } }, ['×'])]),
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
  dialog.showModal();
}

function dialogFailure(message: string): void {
  $('dialog-error').textContent = message;
  $('dialog-error').hidden = false;
}

function openSessionActions(session: Session, opener: HTMLElement): void {
  if (session.id === INBOX_SESSION_ID) return;
  const archive = session.archived_at === null;
  openDialog(session.name, [
    h('button', { attrs: { type: 'button', id: 'archive-session' }, on: { click: () => void archiveSession(session, archive) } }, [archive ? 'Archive session' : 'Unarchive session']),
    h('p', { class: 'small' }, [archive ? (session.id === activeId ? 'Keeps all data. New clips go to Inbox.' : 'Keeps all data in Archived.') : 'Returns to Sessions. Active session unchanged.']),
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
  data = await loadLibrary(db);
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
      filter.query = (event.target as HTMLInputElement).value;
      renderList();
      renderNarrowTop(selectedRow());
    }, 120);
  });
  $<HTMLSelectElement>('status-filter').addEventListener('change', (event) => {
    filter.status = (event.target as HTMLSelectElement).value as LibraryFilter['status'];
    renderList();
  });
  sort.addEventListener('change', () => {
    filter.sort = sort.value as LibrarySort;
    renderList();
  });
  $('clear-filters').addEventListener('click', clearFilters);
  $('hide-sessions').addEventListener('click', () => changeLayout({ sessions_hidden: true }, $('show-sessions')));
  $('show-sessions').addEventListener('click', () => changeLayout({ sessions_hidden: false }, $('hide-sessions')));
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
    for (const b of buttons) b.tabIndex = b === button ? 0 : -1;
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
    document.querySelectorAll<HTMLElement>('.note-editor').forEach((e) => { e.inert = false; });
    (dialogOpener?.isConnected ? dialogOpener : document.getElementById('move-source') ?? $('search')).focus({ preventScroll: true });
  });
}

async function init(): Promise<void> {
  bind();
  try {
    db = await openDb();
    setWriteListener(announceDataChange);
    activeId = await getActiveSessionId();
    layout = await getLibraryLayout();
    data = await loadLibrary(db);
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
