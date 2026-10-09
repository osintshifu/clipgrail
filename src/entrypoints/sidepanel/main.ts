import './style.css';
import { browser } from 'wxt/browser';
import { MAX_BACKUP_BYTES, backupFileName, restoreBackup, validateBackup, writeBackup } from '../../lib/backup';
import type { Backup } from '../../lib/backup';
import { announceDataChange, onDataChange } from '../../lib/changes';
import { $, h } from '../../lib/dom';
import type { Child } from '../../lib/dom';
import {
  commitCaptures,
  countForDeletion,
  countSourcesBySession,
  createSession,
  deleteSession,
  deleteSource,
  emptyInbox,
  latestJob,
  listSessions,
  loadSavedPages,
  loadSessionView,
  loadNote,
  moveSource,
  openDb,
  visitAllData,
  renameSession,
  replaceAllData,
  saveJob,
  setSessionArchived,
  setSourceImportant,
  setWriteListener,
  summarizeData,
  undoCapture,
  undoSavedCaptures,
  updateCaptureNote,
  updateSessionText,
  updateSourceNote,
} from '../../lib/db';
import type { SavedCapture, SavedPage, SessionView, SourceEntry } from '../../lib/db';
import type { DeliveryEnvironment, DestinationId } from '../../lib/destinations';
import { DESTINATIONS, deliverJob } from '../../lib/destinations';
import type { ClipRequest, ClipResponse, RecordRequest, RecordResponse } from '../../lib/messages';
import type { Recording } from '../../lib/recording';
import { RECORDING_KEY, isRecording } from '../../lib/recording';
import { INBOX_SESSION_ID, sourceLabel } from '../../lib/model';
import { arrival, ledTo, sourcesByAddress } from '../../lib/timeline';
import type { Session } from '../../lib/model';
import type { Notice } from '../../lib/notice';
import { NOTICE_KEY } from '../../lib/notice';
import type { ContextMode, JobSettings, ResearchJob } from '../../lib/research-job';
import { buildResearchJob, isJobOutdated } from '../../lib/research-job';
import type { SourceStatus } from '../../lib/selection';
import { capturedTitle, chooseSnapshot, okSnapshotOf } from '../../lib/selection';
import { openLibrary } from '../../lib/library-tab';
import { pageCodeBlock } from '../../lib/page-code-block';
import { faviconTile, faviconUrl } from '../../lib/favicon';
import { hydrateIcons, icon } from '../../lib/icons';
import type { OpenMode, Preset } from '../../lib/settings';
import {
  OPEN_MODE_KEY,
  dropExcludedSources,
  getActiveSessionId,
  getJobSettings,
  getAllJobSettings,
  getExcludedSites,
  getLastBackupAt,
  getOpenMode,
  getPresets,
  removeJobSettings,
  saveJobSettings,
  saveExcludedSites,
  parseSiteList,
  replaceAllJobSettings,
  resolveActiveSessionId,
  savePresets,
  setActiveSessionId,
  setLastBackupAt,
  setOpenMode,
} from '../../lib/settings';
import { savedTabsMessage, tabDrafts } from '../../lib/tabs';
import { plural } from '../../lib/text';
import { finishNoteWrites, noteEditor } from '../../lib/note-editor';
import type { DeletionText } from '../../lib/describe';
import {
  STATUS_LABELS,
  backupLine,
  captureExtra,
  captureHead,
  captureLine,
  comparisonLine,
  detailRows,
  fmtBytes,
  fmtMegabytes,
  fmtNumber,
  fmtTime,
  hostOf,
  inboxEmptyingText,
  pageCodeCapture,
  pageCodeView,
  sessionDeletionText,
  sourceDeletionText,
  sourceMeta,
  statusSentence,
  storageLines,
  textComparisons,
} from '../../lib/describe';

// ---------- Helpers ----------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens the library in a tab; Chrome can refuse, for example while a tab is being dragged. */
function showLibrary(params: Record<string, string>): void {
  openLibrary(params, windowId).catch((error: unknown) => showToast(`Library not opened: ${errorText(error)}`, { level: 'error' }));
}
/**
 * Edits are written on every change, without a delay: IndexedDB runs read-write
 * transactions on the same store in the order they were created and
 * chrome.storage applies writes in call order, so the last edit always wins and
 * nothing waits in a timer when the panel closes or the session changes.
 */
function reportSaveError(what: string): (error: unknown) => void {
  return (error) => showToast(`${what} not saved: ${errorText(error)}`, { level: 'error' });
}

const chip = (status: SourceStatus) => h('span', { class: `chip ${status}` }, [STATUS_LABELS[status]]);

/** Arrow keys, Home and End move between the buttons of a tablist or radiogroup and activate them. */
function rovingKeys(container: HTMLElement, activate: (button: HTMLButtonElement) => void): void {
  container.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.disabled);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + step + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
    if (items[next]) activate(items[next]);
  });
}

function setSelected(buttons: HTMLButtonElement[], selected: HTMLButtonElement | undefined, attr: 'aria-selected' | 'aria-checked'): void {
  for (const button of buttons) {
    const on = button === selected;
    button.setAttribute(attr, String(on));
    button.tabIndex = on ? 0 : -1;
  }
}

// ---------- State ----------

type DetailTab = 'text' | 'captures' | 'details';
type Stage = 'prepare' | 'result';

let db: IDBDatabase;
let windowId: number | undefined;
let sessions: Session[] = [];
let activeId = INBOX_SESSION_ID;
let view: SessionView | null = null;
let currentView: 'collect' | 'job' = 'collect';
let detailSourceId: string | null = null;
let detailTab: DetailTab = 'text';
let stage: Stage = 'prepare';
let presets: Preset[] = [];
let settings: JobSettings;
let job: ResearchJob | undefined;
let draft: ResearchJob | undefined;
let pendingRestore: Backup | null = null;
let shortcut = '';
let modifier = 'Ctrl';
let lastNoticeId = '';
let previousPrompt: string | null = null;
let notesOpen = false;
/** The recording of any window, from session storage. */
let recording: Recording | null = null;
let optionsOpen = false;
let tabCounts = { selected: 1, all: 0 };
/** Session loads: a newer load supersedes an older one, and a refresh waits for the latest. */
let loadSeq = 0;
let loadedSeq = 0;

/**
 * Edits of the prompt, the session notes and the Research Job settings. A
 * re-read never replaces an edit that is not saved yet or was made while
 * the re-read ran.
 */
interface EditState {
  revision: number;
  saved: number;
}
const edits: Record<'prompt' | 'notes' | 'settings', EditState> = {
  prompt: { revision: 0, saved: 0 },
  notes: { revision: 0, saved: 0 },
  settings: { revision: 0, saved: 0 },
};

/** Starts an edit and returns the callback that marks it saved. */
function startEdit(state: EditState): () => void {
  const revision = ++state.revision;
  return () => {
    state.saved = Math.max(state.saved, revision);
  };
}

// ---------- Toast ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastUndo: (() => Promise<void>) | null = null;
/**
 * A popup opened by the shortcut or the page menu gets no focus, so a click
 * on the page does not close it. A popup without focus closes with its
 * message instead, unless it was used.
 */
let closeWithToast = false;

function showToast(text: string, options: { level?: 'info' | 'error'; undo?: () => Promise<void> } = {}): void {
  const toast = $('toast');
  $('toast-text').textContent = text;
  toast.classList.toggle('error', options.level === 'error');
  $('toast-text').setAttribute('role', options.level === 'error' ? 'alert' : 'status');
  toastUndo = options.undo ?? null;
  $('toast-undo').hidden = !toastUndo;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, options.level === 'error' ? 15_000 : 8_000);
}
function hideToast(): void {
  $('toast').hidden = true;
  toastUndo = null;
  if (closeWithToast && !document.hasFocus()) window.close();
}

async function undoCaptureWithToast(captureId: string): Promise<void> {
  try {
    const result = await undoCapture(db, captureId);
    if (!result.removed) showToast('That capture was already removed.');
    else showToast(result.sourceRemoved ? 'Capture removed. Its source label will not be reused.' : 'Capture removed. Earlier captures are kept.');
  } catch (error) {
    showToast(`Undo failed: ${errorText(error)}`, { level: 'error' });
  }
  await refreshData();
}

/** Undo for captures saved together: saved tabs or a recording. Pages with a note, or moved since, stay. */
async function undoBatchWithToast(saved: SavedCapture[], removed: string, gone: string): Promise<void> {
  try {
    const result = await undoSavedCaptures(db, saved);
    const kept = result.kept ? `${plural(result.kept, 'page')} you added notes to, marked important or moved ${result.kept === 1 ? 'is' : 'are'} kept.` : '';
    if (result.removed) showToast(kept ? `${removed} ${kept}` : removed);
    else showToast(kept ? `Nothing removed: ${kept}` : gone);
  } catch (error) {
    showToast(`Undo failed: ${errorText(error)}`, { level: 'error' });
  }
  await refreshData();
}

function handleNotice(notice: Notice | undefined): void {
  if (!notice || notice.id === lastNoticeId) return;
  if (notice.window_id !== null && windowId !== undefined && notice.window_id !== windowId) return;
  lastNoticeId = notice.id;
  const captureId = notice.capture_id;
  showToast(notice.text, {
    level: notice.level,
    undo: captureId ? () => undoCaptureWithToast(captureId) : undefined,
  });
  void refreshData();
}

// ---------- Sheets and menus ----------

let sheetKind: string | null = null;
let sheetOpener: HTMLElement | null = null;

/** Where focus returns after a sheet: items of a menu are hidden by then, so their menu button takes focus. */
function sheetOpenerFor(active: Element | null): HTMLElement {
  if (active?.closest('#presets-menu')) return $('presets-button');
  if (!(active instanceof HTMLElement) || active === document.body || active.closest('#menu') || active.id === 'restore-file') return $('menu-button');
  return active;
}

/**
 * Shows a bottom sheet (modal dialog). The rest of the panel is inert while it
 * is open; closing returns focus to the control that opened the first sheet.
 */
function openSheet(kind: string, title: string, body: Child[], focus?: HTMLElement): void {
  toggleMenu(false);
  togglePresetsMenu(false);
  if (!sheetKind) sheetOpener = sheetOpenerFor(document.activeElement);
  sheetKind = kind;
  $('sheet-title').textContent = title;
  $('sheet-body').replaceChildren(...body.filter((c): c is Node | string => !!c));
  $('sheet-layer').hidden = false;
  for (const id of ['top', 'main', 'bar']) $(id).inert = true;
  const first = focus ?? $('sheet-body').querySelector<HTMLElement>('input, textarea, button:not(:disabled)') ?? $('sheet-close');
  first.focus();
}

function closeSheet(restoreFocus = true): void {
  if (!sheetKind) return;
  sheetKind = null;
  pendingRestore = null;
  $('sheet-layer').hidden = true;
  for (const id of ['top', 'main', 'bar']) $(id).inert = false;
  const opener = sheetOpener;
  sheetOpener = null;
  if (restoreFocus && opener && document.contains(opener)) opener.focus();
}

/** Shows an error inside the open sheet (toasts sit behind it). */
function sheetError(text: string): void {
  const body = $('sheet-body');
  const existing = body.querySelector('.alert-text');
  const message = h('p', { class: 'alert-text', attrs: { role: 'alert' } }, [text]);
  if (existing) existing.replaceWith(message);
  else body.append(message);
}

function toggleMenu(open: boolean): void {
  $('menu').hidden = !open;
  $('menu-button').setAttribute('aria-expanded', String(open));
  if (!open) return;
  togglePresetsMenu(false);
  Array.from($('menu').querySelectorAll('button')).find((b) => !b.hidden && !b.disabled)?.focus();
  void renderStorageSummary();
  // Turn off tab access is offered only while ClipGrail has the permission.
  browser.permissions.contains({ permissions: ['tabs'] }).then(
    (has) => ($('tab-access-button').hidden = !has),
    () => ($('tab-access-button').hidden = true),
  );
}

function renderOpenMode(mode: OpenMode): void {
  $('open-in-panel').setAttribute('aria-checked', String(mode === 'panel'));
  $('open-in-popup').setAttribute('aria-checked', String(mode === 'popup'));
}

/** Sets what the toolbar button opens; the background applies it to the button. */
async function chooseOpenMode(mode: OpenMode): Promise<void> {
  toggleMenu(false);
  $('menu-button').focus();
  if ($(mode === 'panel' ? 'open-in-panel' : 'open-in-popup').getAttribute('aria-checked') === 'true') return;
  try {
    await setOpenMode(mode);
    renderOpenMode(mode);
    showToast(mode === 'popup' ? 'The toolbar button now opens a popup.' : 'The toolbar button now opens the side panel.');
  } catch (error) {
    showToast(`Setting not saved: ${errorText(error)}`, { level: 'error' });
  }
}

/** What ClipGrail stores, roughly how much space it takes (Chrome's estimate) and when the last backup was made. */
async function renderStorageSummary(): Promise<void> {
  const box = $('storage-summary');
  try {
    const [summary, lastBackupAt, estimate] = await Promise.all([
      summarizeData(db),
      getLastBackupAt(),
      (navigator.storage?.estimate?.() ?? Promise.resolve(undefined)).catch(() => undefined),
    ]);
    const [what, size] = storageLines(summary, typeof estimate?.usage === 'number' ? estimate.usage : null);
    box.replaceChildren(what, h('br'), size, h('br'), backupLine(lastBackupAt));
  } catch {
    box.textContent = 'Stored data could not be counted.';
  }
}

function togglePresetsMenu(open: boolean): void {
  $('presets-menu').hidden = !open;
  $('presets-button').setAttribute('aria-expanded', String(open));
  if (open) $('presets-menu').querySelector('button')?.focus();
}

// ---------- Sessions ----------

function renderHeader(): void {
  const session = sessions.find((s) => s.id === activeId) ?? view?.session;
  const name = session?.name ?? '';
  $('session-name').textContent = name;
  $('session-archived').hidden = !session?.archived_at;
  $('session-button').setAttribute('aria-label', `Session: ${name}. Switch or manage sessions`);
}

async function openSessionsSheet(): Promise<void> {
  const counts = await countSourcesBySession(db).catch(() => new Map<string, number>());
  sessions = await listSessions(db);
  const isInbox = activeId === INBOX_SESSION_ID;
  const active = sessions.find((s) => s.id === activeId);
  const row = (s: Session) =>
    h('li', {}, [
      h(
        'button',
        {
          class: `pick${s.archived_at ? ' archived' : ''}`,
          attrs: { type: 'button', 'aria-current': String(s.id === activeId) },
          on: {
            click: () => {
              closeSheet();
              if (s.id !== activeId) void switchSession(s.id);
            },
          },
        },
        [h('span', { class: 'name' }, [s.name]), h('span', { class: 'meta' }, [plural(counts.get(s.id) ?? 0, 'source')])],
      ),
    ]);
  const current = sessions.filter((s) => s.archived_at === null);
  const archived = sessions.filter((s) => s.archived_at !== null);
  const rename = h('button', { attrs: { type: 'button' }, on: { click: () => openSessionForm('rename') } }, ['Rename']);
  rename.disabled = isInbox;
  if (isInbox) rename.title = 'The Inbox keeps its name';
  const archive = h('button', { attrs: { type: 'button' }, on: { click: () => void setArchived(!active?.archived_at) } }, [
    active?.archived_at ? 'Unarchive' : 'Archive session',
  ]);
  archive.disabled = isInbox;
  if (isInbox) archive.title = 'The Inbox cannot be archived';
  const activeCounts = await countForDeletion(db, activeId).catch(() => null);
  const remove = h('button', { class: 'delete', attrs: { type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => void (isInbox ? openEmptyInboxSheet() : openDeleteSessionSheet()) } }, [
    isInbox ? 'Empty Inbox…' : 'Delete session…',
  ]);
  if (isInbox && activeCounts && !activeCounts.sources && !activeCounts.jobs) {
    remove.disabled = true;
    remove.title = 'The Inbox is empty';
  }
  openSheet('sessions', 'Sessions', [
    h('ul', { class: 'pick-list' }, current.map(row)),
    archived.length ? h('div', { class: 'section-title' }, ['Archived']) : null,
    archived.length ? h('ul', { class: 'pick-list' }, archived.map(row)) : null,
    h('div', { class: 'sheet-actions divided' }, [
      h('button', { class: 'primary', attrs: { type: 'button' }, on: { click: () => openSessionForm('create') } }, ['New session']),
      rename,
      archive,
      remove,
    ]),
    h('p', { class: 'small' }, ['New captures go to the selected session. Archived sessions stay available here and still accept captures.']),
  ]);
}

function openSessionForm(mode: 'create' | 'rename'): void {
  const input = h('input', {
    attrs: { id: 'session-name-input', type: 'text', maxlength: '120', required: '', autocomplete: 'off', placeholder: mode === 'create' ? 'New session name' : 'Session name' },
  });
  input.value = mode === 'rename' ? (view?.session.name ?? '') : '';
  const submit = (event: Event) => {
    event.preventDefault();
    void submitSessionForm(mode, input.value);
  };
  const form = h('form', { class: 'stack', on: { submit } }, [
    h('label', { class: 'form-field' }, [h('span', {}, ['Session name']), input]),
    h('div', { class: 'sheet-actions' }, [
      h('button', { class: 'primary', attrs: { type: 'submit' } }, [mode === 'create' ? 'Create' : 'Save']),
      h('button', { attrs: { type: 'button' }, on: { click: () => void openSessionsSheet() } }, ['Cancel']),
    ]),
  ]);
  openSheet('session-form', mode === 'create' ? 'New session' : 'Rename session', [form], input);
  input.select();
}

async function submitSessionForm(mode: 'create' | 'rename', name: string): Promise<void> {
  try {
    if (mode === 'create') {
      const session = await createSession(db, name);
      closeSheet();
      await switchSession(session.id);
      showToast(`Session "${session.name}" created. New captures go here.`);
    } else {
      await renameSession(db, activeId, name);
      closeSheet();
      await loadActiveSession();
    }
  } catch (error) {
    sheetError(errorText(error));
  }
}

async function switchSession(id: string): Promise<void> {
  activeId = id;
  detailSourceId = null;
  stage = 'prepare';
  await setActiveSessionId(id);
  await loadActiveSession();
}

async function setArchived(archived: boolean): Promise<void> {
  const session = sessions.find((s) => s.id === activeId);
  if (!session) return;
  try {
    await setSessionArchived(db, session.id, archived);
    closeSheet();
    if (archived) {
      await switchSession(INBOX_SESSION_ID);
      showToast(`Session "${session.name}" archived. Find it under Archived in the session list.`);
    } else {
      await loadActiveSession();
      showToast(`Session "${session.name}" unarchived.`);
    }
  } catch (error) {
    sheetError(errorText(error));
  }
}

// ---------- Deleting ----------

/** A deletion confirmation. Cancel has focus, so Enter never deletes by accident. */
function openDeletionSheet(kind: string, title: string, text: DeletionText, confirmLabel: string, confirm: () => void): void {
  const cancel = h('button', { attrs: { type: 'button' }, on: { click: () => closeSheet() } }, ['Cancel']);
  openSheet(
    kind,
    title,
    [
      ...text.main.map((line) => h('p', {}, [line])),
      ...text.small.map((line) => h('p', { class: 'small' }, [line])),
      h('div', { class: 'sheet-actions' }, [h('button', { class: 'danger', attrs: { id: 'confirm-delete', type: 'button' }, on: { click: confirm } }, [confirmLabel]), cancel]),
    ],
    cancel,
  );
}

async function openDeleteSourceSheet(entry: SourceEntry): Promise<void> {
  const label = sourceLabel(entry.source);
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, entry.source.session_id, entry.source.id), getLastBackupAt()]);
  const text = sourceDeletionText(label, capturedTitle(entry) ?? entry.source.dedup_url, counts, lastBackupAt);
  openDeletionSheet('delete-source', `Delete ${label}?`, text, `Delete ${label}`, () => void deleteDetailSource(entry));
}

async function deleteDetailSource(entry: SourceEntry): Promise<void> {
  const label = sourceLabel(entry.source);
  try {
    // Edits of this source's notes finish first; a note that failed to save does not block deleting it.
    await finishNoteWrites().catch(() => undefined);
    await deleteSource(db, entry.source.id);
  } catch (error) {
    sheetError(`${label} not deleted: ${errorText(error)}`);
    return;
  }
  await dropExcludedSources(entry.source.session_id, [entry.source.id]).catch(() => undefined);
  closeSheet(false);
  detailSourceId = null;
  await refreshData({ external: true });
  showToast(`${label} deleted.`);
  (document.querySelector<HTMLButtonElement>('#source-list .src') ?? $('clip-page')).focus();
}

async function openDeleteSessionSheet(): Promise<void> {
  const session = sessions.find((s) => s.id === activeId);
  if (!session || session.id === INBOX_SESSION_ID) return;
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, session.id), getLastBackupAt()]);
  const text = sessionDeletionText(session.name, counts, true, lastBackupAt);
  openDeletionSheet('delete-session', `Delete session "${session.name}"?`, text, 'Delete session', () => void removeActiveSession(session));
}

async function removeActiveSession(session: Session): Promise<void> {
  try {
    await finishNoteWrites().catch(() => undefined);
    await deleteSession(db, session.id);
  } catch (error) {
    sheetError(`Session not deleted: ${errorText(error)}`);
    return;
  }
  await removeJobSettings(session.id).catch(() => undefined);
  closeSheet();
  await switchSession(INBOX_SESSION_ID);
  showToast(`Session "${session.name}" deleted. New clips go to the Inbox.`);
}

async function openEmptyInboxSheet(): Promise<void> {
  const inbox = sessions.find((s) => s.id === INBOX_SESSION_ID);
  if (!inbox) return;
  const [counts, lastBackupAt] = await Promise.all([countForDeletion(db, INBOX_SESSION_ID), getLastBackupAt()]);
  openDeletionSheet('empty-inbox', 'Empty Inbox?', inboxEmptyingText(counts, inbox.next_source_number, lastBackupAt), 'Empty Inbox', () => void clearInbox());
}

async function clearInbox(): Promise<void> {
  try {
    await finishNoteWrites().catch(() => undefined);
    await emptyInbox(db);
  } catch (error) {
    sheetError(`Inbox not emptied: ${errorText(error)}`);
    return;
  }
  await dropExcludedSources(INBOX_SESSION_ID, 'all').catch(() => undefined);
  closeSheet();
  detailSourceId = null;
  await refreshData({ external: true });
  showToast('Inbox emptied.');
}

// ---------- Loading ----------

/**
 * Reads the active session and shows it. State changes only after every read,
 * so an edit made meanwhile is saved for the session still shown.
 */
async function loadActiveSession(): Promise<void> {
  const seq = ++loadSeq;
  const list = await listSessions(db);
  // The stored session can be missing after a restore stopped early: the Inbox replaces it.
  const id = list.some((s) => s.id === activeId) ? activeId : await resolveActiveSessionId(db);
  const nextView = await loadSessionView(db, id);
  const nextSettings = await getJobSettings(id);
  const nextJob = await latestJob(db, id);
  if (seq !== loadSeq) return;
  loadedSeq = seq;
  sessions = list;
  activeId = id;
  view = nextView;
  settings = nextSettings;
  job = nextJob;
  previousPrompt = null;
  $<HTMLTextAreaElement>('prompt').value = view.session.prompt;
  $<HTMLTextAreaElement>('session-notes').value = view.session.notes;
  fillJobForm();
  $('delivery-status').hidden = true;
  renderHeader();
  renderCollect();
  renderJobSources();
  renderJob();
}

/**
 * Remembers focus, caret and scroll position before the panel is rendered
 * again and restores them afterwards. A field being typed in keeps its text:
 * every keystroke is already saved, and a re-read may predate the last one.
 */
function keepFocus(): () => void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const id = active?.id || null;
  const focusKey = active?.dataset.focus ?? null;
  const field = active instanceof HTMLTextAreaElement ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  const scroll = $('main').scrollTop;
  return () => {
    $('main').scrollTop = scroll;
    const el = id
      ? document.getElementById(id)
      : focusKey
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-focus]')).find((e) => e.dataset.focus === focusKey)
        : null;
    if (!el || (el === active && document.activeElement === el)) return;
    if (field && el instanceof HTMLTextAreaElement) {
      el.value = field.value;
      el.setSelectionRange(field.start, field.end);
    }
    el.focus({ preventScroll: true });
  };
}

/**
 * Reads the active session again and renders it. `external` marks changes
 * made in another ClipGrail page: sessions and the latest job are read again
 * too, and an open source that disappeared is explained instead of just closed.
 */
async function refreshData(options: { external?: boolean } = {}): Promise<void> {
  // A session load in progress shows fresh data itself.
  if (!db || !view || loadedSeq !== loadSeq) return;
  const seq = loadSeq;
  const sessionId = view.session.id;
  const startRevisions = { prompt: edits.prompt.revision, notes: edits.notes.revision, settings: edits.settings.revision };
  const restore = keepFocus();
  let fresh: SessionView;
  let freshSettings: JobSettings;
  let freshSessions: Session[] | undefined;
  let freshJob: ResearchJob | undefined;
  try {
    fresh = await loadSessionView(db, sessionId);
    freshSettings = await getJobSettings(sessionId);
    if (options.external) {
      freshSessions = await listSessions(db);
      freshJob = await latestJob(db, sessionId);
    }
  } catch {
    await loadActiveSession();
    return;
  }
  if (seq !== loadSeq) return;
  if (freshSessions) sessions = freshSessions;
  if (options.external) job = freshJob;
  const lost =
    options.external && detailSourceId !== null && !fresh.sources.some((s) => s.source.id === detailSourceId)
      ? view.sources.find((s) => s.source.id === detailSourceId)
      : undefined;
  // Another window may have changed the prompt, notes or settings. Text being typed, not yet
  // saved, or edited during this read stays: the read may predate the last keystroke.
  const kept = (key: keyof typeof edits, field?: HTMLElement) =>
    document.activeElement === field || edits[key].revision !== edits[key].saved || edits[key].revision !== startRevisions[key];
  const promptField = $<HTMLTextAreaElement>('prompt');
  const notesField = $<HTMLTextAreaElement>('session-notes');
  const prompt = kept('prompt', promptField) ? view.session.prompt : fresh.session.prompt;
  const notes = kept('notes', notesField) ? view.session.notes : fresh.session.notes;
  if (promptField.value !== prompt) promptField.value = prompt;
  if (notesField.value !== notes) notesField.value = notes;
  view = { ...fresh, session: { ...fresh.session, prompt, notes } };
  if (!kept('settings') && JSON.stringify(freshSettings) !== JSON.stringify(settings)) {
    settings = freshSettings;
    fillJobForm();
  }
  if (lost) void explainLostSource(lost);
  if (options.external) renderHeader();
  renderCollect();
  renderJobSources();
  renderJob();
  restore();
}

/** The open source left this session in another window: moved (its captures still exist) or deleted. */
async function explainLostSource(lost: SourceEntry): Promise<void> {
  const label = sourceLabel(lost.source);
  const captureId = lost.captures[0]?.capture.id;
  const moved = captureId !== undefined && (await loadNote(db, 'capture', captureId).catch(() => undefined)) !== undefined;
  showToast(
    moved
      ? `${label} is no longer in this session. It was moved, or its capture was undone, in another ClipGrail window.`
      : `${label} was deleted in another ClipGrail window.`,
  );
}

// ---------- Collect: source list ----------

function renderNotesToggle(): void {
  const empty = !(view?.session.notes.trim() ?? '');
  $('notes-label').textContent = `Session notes${empty ? ' · empty' : ''}`;
  $('notes-toggle').setAttribute('aria-expanded', String(notesOpen));
  $('session-notes').hidden = !notesOpen;
}

function renderCollect(): void {
  if (!view) return;
  const has = view.sources.length > 0;
  $('sources-heading').textContent = `Sources · ${view.sources.length}`;
  $('sources-heading').hidden = !has;
  $('source-list').hidden = !has;
  $('source-list').replaceChildren(
    ...view.sources.map((entry) => {
      const label = sourceLabel(entry.source);
      const title = capturedTitle(entry);
      const status = chooseSnapshot(entry).status;
      const meta = sourceMeta(entry);
      return h('li', {}, [
        h(
          'button',
          {
            class: 'src',
            attrs: {
              type: 'button',
              'data-focus': `src:${entry.source.id}`,
              'aria-label': `${label}: ${title ?? entry.source.dedup_url}, ${STATUS_LABELS[status]}${entry.source.important ? ', important' : ''}, open details`,
            },
            on: { click: () => openDetail(entry.source.id) },
          },
          [
            faviconTile(entry.source.dedup_url),
            h('span', { class: 'src-body' }, [
              h('span', { class: `src-title${title ? '' : ' untitled'}` }, [entry.source.important ? starMark() : null, title ?? entry.source.dedup_url]),
              h('span', { class: 'src-meta' }, [
                chip(status),
                h('span', { class: 'src-host' }, [hostOf(entry.source.dedup_url)]),
                // In a narrow panel the line breaks between its parts, never inside one.
                meta ? h('span', {}, meta.split(' · ').flatMap((part, i) => [i ? ' · ' : null, h('span', { class: 'nowrap' }, [part])])) : null,
              ]),
            ]),
          ],
        ),
      ]);
    }),
  );
  $('sources-empty').hidden = has;
  $('empty-session').textContent = view.session.name;
  $('empty-shortcut').hidden = !shortcut;
  $('empty-shortcut-key').textContent = shortcut;
  renderNotesToggle();
  if (detailSourceId && !view.sources.some((s) => s.source.id === detailSourceId)) detailSourceId = null;
  $('sources-panel').hidden = detailSourceId !== null;
  $('detail-panel').hidden = detailSourceId === null;
  if (detailSourceId) renderDetail();
  renderBars();
}

function openDetail(sourceId: string): void {
  detailSourceId = sourceId;
  detailTab = 'text';
  renderCollect();
  $('main').scrollTop = 0;
  $('detail-back')?.focus();
}

function closeDetail(): void {
  const id = detailSourceId;
  detailSourceId = null;
  renderCollect();
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('#source-list .src'));
  const index = view?.sources.findIndex((s) => s.source.id === id) ?? -1;
  (items[index] ?? items[0])?.focus();
}

// ---------- Collect: source details ----------

function textSection(entry: SourceEntry): Child[] {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const selections = entry.captures.filter((c) => c.capture.kind === 'selection' && c.capture.fragment);
  const blocks: Child[] = [];
  // The panel shows the text Research Jobs use; earlier texts are read in the library.
  const earlier = entry.captures.filter((c) => c.snapshot?.status === 'ok' && c.snapshot !== ok).length;
  if (earlier) {
    blocks.push(
      h('div', { class: 'versions-hint' }, [
        h('span', {}, [`${plural(earlier, 'earlier text version')} kept.`]),
        h(
          'button',
          { class: 'link', attrs: { id: 'open-versions', type: 'button' }, on: { click: () => showLibrary({ view: entry.source.session_id, source: entry.source.id }) } },
          ['Open in library', icon('arrow-up-right')],
        ),
      ]),
    );
  }
  if (ok) {
    blocks.push(
      h('div', { class: 'stack' }, [
        h('div', { class: 'text-head' }, [
          h('span', {}, [`Snapshot · ${fmtTime(ok.captured_at)}${ok.extraction_method === 'page-text' ? ' · page text' : ''}`]),
          h('span', {}, [`${fmtNumber(ok.character_count)} characters`]),
        ]),
        h('pre', { class: 'text-box', attrs: { tabindex: '0', 'aria-label': 'Saved text' } }, [ok.text]),
        ok.truncated
          ? h('div', { class: 'text-cut' }, [
              `[Text cut at capture here. ${fmtNumber(ok.original_character_count - ok.character_count)} characters of the page were not saved.]`,
            ])
          : null,
      ]),
    );
  }
  selections.forEach(({ capture }, i) => {
    const fragment = capture.fragment!;
    blocks.push(
      h('div', { class: 'stack' }, [
        h('div', { class: 'text-head' }, [
          `Selection ${i + 1} of ${selections.length} · ${fmtTime(capture.captured_at)} · ${fmtNumber(fragment.character_count)} characters${fragment.truncated ? ' · partial' : ''}`,
        ]),
        h('pre', { class: 'text-box selection', attrs: { tabindex: '0', 'aria-label': `Selection ${i + 1}` } }, [fragment.text]),
      ]),
    );
  });
  if (!ok && !selections.length) {
    blocks.push(
      h('div', { class: 'no-text' }, [
        choice.status === 'failed' ? 'No text was saved. Open the page and clip it again to retry.' : 'No text yet. Open the page and clip it to save its text.',
      ]),
    );
  }
  return blocks;
}

function capturesSection(entry: SourceEntry): Child[] {
  return [...captureCards(entry), ...pathBlocks(entry)];
}

/** The filled star of a source marked important. */
const starMark = () => h('span', { class: 'star' }, [icon('star-fill', 'Important')]);

/** A line of generated words with the S-labels in it shown as labels. */
function withLabels(text: string): Child[] {
  return text.split(/\b(S[1-9]\d*)\b/).map((part, i) => (i % 2 ? h('span', { class: 'sid' }, [part]) : part));
}

/** Under the captures: the recorded returns to the page and the sources it led to; nothing when there are none. */
function pathBlocks(entry: SourceEntry): Child[] {
  const sources = view?.sources ?? [];
  const byAddress = sourcesByAddress(sources);
  const led = ledTo(entry, sources);
  return [
    entry.visits.length
      ? h('div', { class: 'path-block' }, [
          h('span', { class: 'section-title' }, [`Visited again · ${entry.visits.length}`]),
          ...entry.visits.map((visit) => h('div', { class: 'visit-row' }, [h('span', { class: 'mono-t' }, [fmtTime(visit.captured_at)]), ' · ', ...withLabels(arrival(visit, byAddress) ?? '')])),
        ])
      : null,
    led.length
      ? h('div', { class: 'path-block' }, [
          h('span', { class: 'section-title' }, [`Led to · ${led.length}`]),
          ...led.map((target) =>
            h('button', { class: 'led-to', attrs: { type: 'button' }, on: { click: () => openDetail(target.source.id) } }, [
              h('span', { class: 'sid' }, [sourceLabel(target.source)]),
              h('span', {}, [capturedTitle(target) ?? target.source.dedup_url]),
            ]),
          ),
        ])
      : null,
  ];
}

function captureCards(entry: SourceEntry): Child[] {
  const compared = textComparisons(entry.captures);
  return entry.captures.map(({ capture, snapshot }, i) => {
    const head = captureHead(capture, i);
    const line = captureLine(capture, snapshot);
    const comparison = compared.get(capture.id);
    const extra = captureExtra(capture, entry.source.dedup_url);
    const note = noteEditor({
      id: `note-${capture.id}`, key: `panel:capture:${capture.id}`,
      label: `Capture note · Capture ${i + 1}`, value: capture.note,
      hint: 'Private. For this capture only.',
      read: () => loadNote(db, 'capture', capture.id),
      write: (value) => updateCaptureNote(db, capture.id, value),
      onEdit: (value) => { capture.note = value; renderJob(); },
    });
    return h('div', { class: 'capture-card' }, [
      h('div', { class: 'head' }, [h('span', { class: 'capture-title' }, [head]), h('span', { class: 'muted' }, [fmtTime(capture.captured_at)])]),
      line ? h('div', { class: 'line' }, [line]) : null,
      comparison
        ? h('div', { class: 'line' }, [
            comparisonLine(comparison),
            ...(comparison.same
              ? []
              : [
                  ' · ',
                  h(
                    'button',
                    {
                      class: 'link compare-link',
                      attrs: { type: 'button' },
                      on: { click: () => showLibrary({ view: entry.source.session_id, source: entry.source.id, capture: capture.id, compare: comparison.earlier.id }) },
                    },
                    ['Compare in library', icon('arrow-up-right')],
                  ),
                ]),
          ])
        : null,
      capture.fragment ? h('pre', { class: 'text-box excerpt' }, [capture.fragment.text]) : null,
      extra ? h('div', { class: 'line' }, [extra]) : null,
      note,
    ]);
  });
}

function detailsSection(entry: SourceEntry): Child[] {
  return [
    h(
      'dl',
      { class: 'details' },
      detailRows(entry, view?.session.name ?? '').flatMap((row) => [
        h('dt', {}, [row.label]),
        h('dd', { class: row.mono ? 'mono' : '' }, [row.value]),
      ]),
    ),
    h('p', { class: 'small' }, [
      'The SHA-256 identifies the exact saved text, so a copy can be checked for changes. It does not prove what the page showed or who published it.',
    ]),
    pageCodeOf(entry),
  ];
}

/** The page code of the newest capture that read it, else what Readability read with the current text. */
function pageCodeOf(entry: SourceEntry): Child {
  const shown = pageCodeCapture(entry);
  const code = shown && pageCodeView(shown.capture, shown.snapshot);
  return code ? pageCodeBlock(code, `Capture ${shown.number} · ${fmtTime(shown.capture.captured_at)}`) : null;
}

function renderDetail(): void {
  const entry = view?.sources.find((s) => s.source.id === detailSourceId);
  const panel = $('detail-panel');
  if (!entry) {
    panel.replaceChildren();
    return;
  }
  const label = sourceLabel(entry.source);
  const title = capturedTitle(entry);
  const url = entry.source.dedup_url;
  const note = noteEditor({
    id: 'source-note', key: `panel:source:${entry.source.id}`,
    label: 'Source note', value: entry.source.note,
    hint: 'Private. Exported only with Notes.',
    read: () => loadNote(db, 'source', entry.source.id),
    write: (value) => updateSourceNote(db, entry.source.id, value),
    onEdit: (value) => { entry.source.note = value; renderJob(); },
  });
  const tabs: Array<[DetailTab, string]> = [['text', 'Text'], ['captures', `Captures · ${entry.captures.length}`], ['details', 'Details']];
  const buttons = tabs.map(([tab, text]) =>
    h('button', { attrs: { id: `detail-tab-${tab}`, type: 'button', role: 'tab', 'aria-controls': 'detail-section' }, on: { click: () => setDetailTab(tab) } }, [text]),
  );
  setSelected(buttons, buttons[tabs.findIndex(([tab]) => tab === detailTab)], 'aria-selected');
  const seg = h('div', { class: 'seg', attrs: { role: 'tablist', 'aria-label': 'Source sections' } }, buttons);
  rovingKeys(seg, (button) => setDetailTab(button.id.replace('detail-tab-', '') as DetailTab, true));
  const section = detailTab === 'text' ? textSection(entry) : detailTab === 'captures' ? capturesSection(entry) : detailsSection(entry);
  panel.replaceChildren(
    h('div', { class: 'detail-top' }, [
      h('button', { class: 'back', attrs: { id: 'detail-back', type: 'button' }, on: { click: closeDetail } }, [icon('arrow-left'), 'Sources']),
      h('span', { class: 'detail-actions' }, [
        h(
          'button',
          {
            class: 'important-toggle',
            attrs: {
              id: 'important-button',
              type: 'button',
              'aria-pressed': String(entry.source.important),
              'aria-label': 'Important',
              title: entry.source.important ? 'Marked important. Click to unmark.' : 'Mark as important',
            },
            on: { click: () => void toggleImportant(entry) },
          },
          [icon(entry.source.important ? 'star-fill' : 'star')],
        ),
        h('button', { attrs: { id: 'move-button', type: 'button', 'aria-haspopup': 'dialog' }, on: { click: () => void openMoveSheet(entry) } }, [icon('folder-simple'), 'Move to…']),
        h('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open page', 'aria-label': 'Open page' } }, [icon('arrow-square-out')]),
        h('button', { class: 'delete', attrs: { id: 'delete-source', type: 'button', 'aria-haspopup': 'dialog', title: 'Delete source', 'aria-label': 'Delete…' }, on: { click: () => void openDeleteSourceSheet(entry) } }, [icon('trash')]),
      ]),
    ]),
    h('div', {}, [
      h('div', { class: 'detail-title' }, [h('span', { class: 'sid' }, [label]), h('h3', { class: title ? '' : 'untitled' }, [title ?? '(title not captured)'])]),
      h('a', { class: 'detail-url', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } }, [h('img', { class: 'fav-sm', attrs: { src: faviconUrl(url), alt: '' } }), url]),
    ]),
    h('div', { class: 'card status-card' }, [chip(chooseSnapshot(entry).status), h('span', {}, [statusSentence(entry)])]),
    note,
    seg,
    h('div', { class: 'detail-section', attrs: { id: 'detail-section', role: 'tabpanel', 'aria-labelledby': `detail-tab-${detailTab}` } }, section),
  );
}

/** Marks the open source important, or not; the list and the details show it at once. */
async function toggleImportant(entry: SourceEntry): Promise<void> {
  const important = !entry.source.important;
  try {
    await setSourceImportant(db, entry.source.id, important);
    entry.source.important = important;
  } catch (error) {
    showToast(`Not saved: ${errorText(error)}`, { level: 'error' });
  }
  renderCollect();
  document.getElementById('important-button')?.focus();
}

function setDetailTab(tab: DetailTab, focus = false): void {
  detailTab = tab;
  renderDetail();
  if (focus) $(`detail-tab-${tab}`).focus();
}

async function openMoveSheet(entry: SourceEntry): Promise<void> {
  const counts = await countSourcesBySession(db).catch(() => new Map<string, number>());
  sessions = await listSessions(db);
  const label = sourceLabel(entry.source);
  const others = sessions.filter((s) => s.id !== entry.source.session_id);
  const targets = [...others.filter((s) => s.archived_at === null), ...others.filter((s) => s.archived_at !== null)];
  openSheet('move', `Move ${label} to another session`, [
    h('p', {}, [
      `All captures of ${label} move with it. It gets the next free label in the target session; ${label} is not reused here. If the target already has this address, the captures join that source.`,
    ]),
    targets.length
      ? h(
          'ul',
          { class: 'pick-list' },
          targets.map((s) =>
            h('li', {}, [
              h('button', { class: 'pick boxed', attrs: { type: 'button' }, on: { click: () => void moveDetailSource(entry, s.id) } }, [
                h('span', { class: 'name' }, [`${s.name}${s.archived_at ? ' (archived)' : ''}`]),
                h('span', { class: 'meta' }, [plural(counts.get(s.id) ?? 0, 'source')]),
              ]),
            ]),
          ),
        )
      : h('p', {}, ['There is no other session yet. Create one in the session list first.']),
  ]);
}

async function moveDetailSource(entry: SourceEntry, targetId: string): Promise<void> {
  const target = sessions.find((s) => s.id === targetId);
  if (!target || !view) return;
  const label = sourceLabel(entry.source);
  const from = view.session.name;
  try {
    await finishNoteWrites();
    const result = await moveSource(db, entry.source.id, target.id);
    // The source has left this session, so it no longer belongs in this session's job selection.
    if (settings.excluded_source_ids.includes(entry.source.id)) {
      settings = { ...settings, excluded_source_ids: settings.excluded_source_ids.filter((id) => id !== entry.source.id) };
      persistSettings(entry.source.session_id, settings);
    }
    closeSheet(false);
    detailSourceId = null;
    await refreshData();
    const where = result.joined
      ? `${target.name}: it joined ${sourceLabel(result.source)}, which has the same address`
      : `${target.name} as ${sourceLabel(result.source)}`;
    showToast(`Moved ${label} to ${where}. ${label} is not reused in ${from}.`);
    (document.querySelector<HTMLButtonElement>('#source-list .src') ?? $('clip-page')).focus();
  } catch (error) {
    sheetError(`Source not moved: ${errorText(error)}`);
  }
}

// ---------- Collect: capture ----------

async function clip(what: 'page' | 'selection'): Promise<void> {
  const buttons = [$<HTMLButtonElement>('clip-page'), $<HTMLButtonElement>('clip-selection')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (windowId === undefined) throw new Error('Unknown window.');
    const request: ClipRequest = { type: 'clip', what, windowId, sessionId: activeId };
    const response = (await browser.runtime.sendMessage(request)) as ClipResponse | undefined;
    if (!response) showToast('Capture failed: no response from ClipGrail.', { level: 'error' });
  } catch (error) {
    showToast(`Capture failed: ${errorText(error)}`, { level: 'error' });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

const selectedTabsLabel = () => (tabCounts.selected > 1 ? `${tabCounts.selected} selected tabs` : 'This tab');

/** Counts the selected and open tabs of this window (no permission needed for counts). */
async function updateTabCounts(): Promise<void> {
  if (windowId === undefined) return;
  try {
    const [all, selected] = await Promise.all([
      browser.tabs.query({ windowId }),
      browser.tabs.query({ windowId, highlighted: true }),
    ]);
    tabCounts = { selected: selected.length, all: all.length };
  } catch {
    // The counts are only labels; saving queries the tabs again.
    return;
  }
  const selectedLabel = document.getElementById('save-selected-label');
  if (selectedLabel) selectedLabel.textContent = selectedTabsLabel();
  const allCount = document.getElementById('save-all-count');
  if (allCount) allCount.textContent = plural(tabCounts.all, 'tab');
}

function openTabsSheet(): void {
  const save = (which: 'selected' | 'all') => () => {
    closeSheet();
    void saveTabs(which);
  };
  openSheet('tabs', 'Save tabs as addresses', [
    h('p', {}, [
      'Saves the address and title of open tabs as sources marked ',
      h('b', {}, ['Address only']),
      '. Pages are not read; open a tab and clip it to save its text. Chrome asks once for permission to read tab addresses.',
    ]),
    h('button', { class: 'option-button', attrs: { id: 'save-selected', type: 'button' }, on: { click: save('selected') } }, [
      h('span', { class: 'name', attrs: { id: 'save-selected-label' } }, [selectedTabsLabel()]),
      h('span', { class: 'meta' }, [`${modifier}+click tabs to select several`]),
    ]),
    h('button', { class: 'option-button', attrs: { id: 'save-all', type: 'button' }, on: { click: save('all') } }, [
      h('span', { class: 'name' }, ['All tabs in this window']),
      h('span', { class: 'meta', attrs: { id: 'save-all-count' } }, [plural(tabCounts.all, 'tab')]),
    ]),
  ]);
  void updateTabCounts();
}

/**
 * Saves the address and title of the selected tabs (the current tab unless
 * several are selected) or of all tabs in this window, without reading the
 * pages. Needs the optional tabs permission, which Chrome asks for once.
 */
async function saveTabs(which: 'selected' | 'all'): Promise<void> {
  let granted: boolean;
  try {
    // Requested first, inside the click: Chrome shows its permission prompt only during a user action.
    granted = await browser.permissions.request({ permissions: ['tabs'] });
  } catch (error) {
    showToast(`Tabs not saved: ${errorText(error)}`, { level: 'error' });
    return;
  }
  if (!granted) {
    showToast("Tabs not saved: ClipGrail needs Chrome's permission to read tab addresses.", { level: 'error' });
    return;
  }
  const button = $<HTMLButtonElement>('tabs-button');
  button.disabled = true;
  try {
    if (windowId === undefined) throw new Error('Unknown window.');
    const tabs = await browser.tabs.query(which === 'all' ? { windowId } : { windowId, highlighted: true });
    tabs.sort((a, b) => a.index - b.index);
    const { drafts, skipped } = tabDrafts(tabs, activeId, new Date().toISOString());
    if (!drafts.length) {
      const what = which === 'all' ? 'none of the tabs in this window is' : tabs.length === 1 ? 'this tab is not' : 'none of the selected tabs is';
      showToast(`No tabs saved: ${what} an http or https page.`, { level: 'error' });
      return;
    }
    const results = await commitCaptures(db, drafts);
    const saved = results.map((r) => ({ capture_id: r.capture.id, session_id: r.capture.session_id }));
    showToast(savedTabsMessage(results, skipped), {
      undo: () => undoBatchWithToast(saved, 'Saved tabs removed. Earlier captures are kept.', 'Those tabs were already removed.'),
    });
    await refreshData();
  } catch (error) {
    showToast(`Tabs not saved: ${errorText(error)}`, { level: 'error' });
  } finally {
    button.disabled = false;
  }
}

// ---------- Research Job: Prepare ----------

const MODE_HINTS: Record<ContextMode, string> = {
  links: 'Title, address and basic page metadata only. No page text is sent.',
  selections: 'Only the text you selected on each page. Sources without a selection are listed as missing.',
  full: 'Saved page text plus selections. Sources without text are listed as missing, partial text is marked.',
};
const modeButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [data-mode]'));

function fillJobForm(): void {
  const buttons = modeButtons();
  setSelected(buttons, buttons.find((b) => b.dataset.mode === settings.context_mode), 'aria-checked');
  $('mode-hint').textContent = MODE_HINTS[settings.context_mode];
  $<HTMLInputElement>('limit').value = settings.max_chars_per_source ? String(settings.max_chars_per_source) : '';
  $<HTMLInputElement>('inc-notes').checked = settings.include_notes;
  $<HTMLInputElement>('inc-links').checked = settings.include_link_context;
  $<HTMLInputElement>('inc-times').checked = settings.include_capture_times;
  $<HTMLInputElement>('inc-urls').checked = settings.include_original_urls;
  renderOptionsToggle();
}

function renderOptionsToggle(): void {
  const privateCount = [settings.include_notes, settings.include_link_context, settings.include_capture_times, settings.include_original_urls].filter(Boolean).length;
  const limit = settings.max_chars_per_source ? `limit ${fmtNumber(settings.max_chars_per_source)} chars/source` : 'no limit';
  $('options-summary').textContent = ` · ${limit}, ${privateCount} of 4 private fields`;
  $('options-toggle').setAttribute('aria-expanded', String(optionsOpen));
  $('options-body').hidden = !optionsOpen;
}

/** Settings live in chrome.storage, so other ClipGrail pages are told about the change. */
function persistSettings(sessionId: string, value: JobSettings): void {
  const done = startEdit(edits.settings);
  saveJobSettings(sessionId, value).then(() => {
    done();
    announceDataChange();
  }, reportSaveError('Settings'));
}

/** Edits apply to the session shown, also while another session is being loaded. */
function changeSettings(changes: Partial<JobSettings>): void {
  if (!view) return;
  settings = { ...settings, ...changes };
  persistSettings(view.session.id, settings);
  renderOptionsToggle();
  renderJob();
}

function setMode(mode: ContextMode): void {
  changeSettings({ context_mode: mode });
  fillJobForm();
}

function persistPrompt(sessionId: string, prompt: string): void {
  const done = startEdit(edits.prompt);
  updateSessionText(db, sessionId, { prompt }).then(done, reportSaveError('Prompt'));
}

function setPrompt(prompt: string): void {
  if (!view) return;
  view = { ...view, session: { ...view.session, prompt } };
  persistPrompt(view.session.id, prompt);
  scheduleJobRender();
}

function applyPreset(preset: Preset): void {
  togglePresetsMenu(false);
  const area = $<HTMLTextAreaElement>('prompt');
  const before = area.value;
  area.value = preset.text;
  setPrompt(preset.text);
  renderJob();
  area.focus();
  if (before.trim() && before !== preset.text) {
    previousPrompt = before;
    showToast(`Prompt replaced with the ${preset.name} preset.`, {
      undo: async () => {
        if (previousPrompt === null) return;
        area.value = previousPrompt;
        setPrompt(previousPrompt);
        renderJob();
        previousPrompt = null;
        hideToast();
      },
    });
  }
}

function renderPresetsMenu(): void {
  $('presets-menu').replaceChildren(
    ...presets.map((preset) =>
      h('button', { attrs: { type: 'button', role: 'menuitem', title: preset.text || 'Empty preset: write your own prompt' }, on: { click: () => applyPreset(preset) } }, [preset.name]),
    ),
    h('div', { class: 'menu-sep', attrs: { role: 'separator' } }),
    h('button', { attrs: { type: 'button', role: 'menuitem' }, on: { click: openPresetsSheet } }, ['Edit presets…']),
  );
}

function openPresetsSheet(): void {
  const areas = presets.map((preset) => {
    const area = h('textarea', { attrs: { rows: '3' } });
    area.value = preset.text;
    return area;
  });
  const save = async () => {
    try {
      await savePresets(presets.map((p, i) => ({ ...p, text: areas[i]!.value })));
      presets = await getPresets();
      renderPresetsMenu();
      closeSheet();
      showToast('Presets saved.');
    } catch (error) {
      sheetError(`Presets not saved: ${errorText(error)}`);
    }
  };
  openSheet('presets', 'Edit presets', [
    h('p', {}, ['Four presets, fixed names. Edited text is kept in this browser.']),
    ...presets.map((preset, i) => h('label', { class: 'preset-field' }, [h('span', {}, [preset.name]), areas[i]!])),
    h('div', { class: 'sheet-actions' }, [
      h('button', { class: 'primary', attrs: { type: 'button' }, on: { click: () => void save() } }, ['Save presets']),
      h('button', { attrs: { type: 'button' }, on: { click: () => closeSheet() } }, ['Cancel']),
    ]),
  ]);
}

/** Rebuilds the source checklist; a single checkbox change only updates the counts and summary. */
function renderJobSources(): void {
  if (!view) return;
  const excluded = new Set(settings.excluded_source_ids);
  $('job-sources').replaceChildren(
    ...view.sources.map((entry) => {
      const title = capturedTitle(entry);
      const box = h('input', { attrs: { type: 'checkbox', 'data-focus': `job:${entry.source.id}` } });
      box.checked = !excluded.has(entry.source.id);
      box.addEventListener('change', () => {
        const set = new Set(settings.excluded_source_ids);
        if (box.checked) set.delete(entry.source.id);
        else set.add(entry.source.id);
        changeSettings({ excluded_source_ids: [...set] });
      });
      return h('li', {}, [
        h('label', {}, [
          box,
          h('span', { class: 'sid' }, [sourceLabel(entry.source)]),
          h('span', { class: `title${title ? '' : ' untitled'}` }, [title ?? entry.source.dedup_url]),
          chip(chooseSnapshot(entry).status),
        ]),
      ]);
    }),
  );
}

// ---------- Research Job: Result ----------

function setStage(next: Stage, focus = false): void {
  if (next === 'result' && !job) return;
  stage = next;
  renderJob();
  if (focus) $(next === 'prepare' ? 'stage-prepare' : 'stage-result').focus();
}

let jobRenderTimer: ReturnType<typeof setTimeout> | undefined;
/** Pause in typing after which the Research Job draft is rebuilt. */
const JOB_RENDER_DELAY_MS = 250;

/** Rebuilds the draft after a pause in typing: building it reads all selected text, which takes long in large sessions. */
function scheduleJobRender(): void {
  clearTimeout(jobRenderTimer);
  if (currentView === 'job') jobRenderTimer = setTimeout(renderJob, JOB_RENDER_DELAY_MS);
}

/**
 * Renders the Research Job view. The draft is built only while the view is
 * shown; selectTab renders it when the view opens, and Copy, Open in and
 * Export re-read the session and rebuild it before delivering.
 */
function renderJob(): void {
  clearTimeout(jobRenderTimer);
  if (!view || currentView !== 'job') return;
  const excluded = new Set(settings.excluded_source_ids);
  const selectedCount = view.sources.filter((s) => !excluded.has(s.source.id)).length;
  $('job-sources-heading').textContent = `Sources · ${selectedCount} of ${view.sources.length}`;
  $('job-sources-empty').hidden = view.sources.length > 0;

  draft = buildResearchJob({ view, settings, id: 'draft', createdAt: '' });
  const stats = draft.stats;
  const jobSources = draft.sources;
  const statusOrder: SourceStatus[] = ['ok', 'partial', 'pending', 'failed', 'none'];
  const statusCounts = statusOrder
    .map((status) => [status, jobSources.filter((s) => s.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${STATUS_LABELS[status]} ${n}`)
    .join(' · ');
  const missingSources = jobSources.filter((s) => s.material === 'missing');
  const partial = jobSources.filter((s) => s.material === 'partial').map((s) => s.label);
  const missingWhat = settings.context_mode === 'selections' ? 'selection' : 'text';
  // Without text, why it is missing tells what to do: clip the page, or try it again.
  const missing =
    settings.context_mode === 'full'
      ? statusOrder
          .map((status) => missingSources.filter((s) => s.status === status).map((s) => s.label))
          .map((labels, i) => (labels.length ? `${labels.join(', ')} (${STATUS_LABELS[statusOrder[i]!]})` : ''))
          .filter(Boolean)
          .join(' · ')
      : missingSources.map((s) => s.label).join(', ');
  const issues = [missing ? `Missing ${missingWhat}: ${missing}` : '', partial.length ? `Partial: ${partial.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  $('summary').replaceChildren(
    h('div', {}, [
      h('b', {}, [`${plural(stats.source_count, 'source')} · ${fmtNumber(stats.character_count)} characters`]),
      h('span', { class: 'muted' }, [` · ~${fmtBytes(stats.utf8_bytes)} UTF-8`]),
    ]),
    statusCounts ? h('div', { class: 'muted' }, [statusCounts]) : '',
    issues ? h('div', { class: 'issues' }, [issues]) : '',
    !issues && stats.source_count > 0 ? h('div', { class: 'muted' }, ['All selected sources have the requested material.']) : '',
  );

  const reasons: string[] = [];
  if (!view.session.prompt.trim()) reasons.push('Write a prompt to generate.');
  if (stats.source_count === 0) reasons.push('Select at least one source.');
  $<HTMLButtonElement>('generate').disabled = reasons.length > 0;
  $('generate-hint').textContent = reasons.join(' ');
  $('generate-hint').hidden = reasons.length === 0;

  if (!job) stage = 'prepare';
  const outdated = !!job && isJobOutdated(job, draft);
  const prepareTab = $<HTMLButtonElement>('stage-prepare');
  const resultTab = $<HTMLButtonElement>('stage-result');
  resultTab.disabled = !job;
  resultTab.textContent = !job ? 'Result · not generated' : outdated ? 'Result · outdated' : 'Result';
  setSelected([prepareTab, resultTab], stage === 'prepare' ? prepareTab : resultTab, 'aria-selected');
  $('prepare').hidden = stage !== 'prepare';
  $('result').hidden = stage !== 'result';
  $('view-job').classList.toggle('fill', stage === 'result');

  if (job) {
    $('job-result-title').textContent = `Generated ${fmtTime(job.created_at)}`;
    $('job-result-meta').textContent = `${plural(job.stats.source_count, 'source')} · ${fmtNumber(job.stats.character_count)} chars · ~${fmtBytes(job.stats.utf8_bytes)}`;
    $('job-stale').hidden = !outdated;
    if ($('job-preview').textContent !== job.text) $('job-preview').textContent = job.text;
    $('job-preview').classList.toggle('outdated', outdated);
  }
  for (const id of ['copy-job', 'export-button']) $<HTMLButtonElement>(id).disabled = !job || outdated;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#bar-result .service')) button.disabled = !job || outdated;
  renderBars();
}

async function generateJob(): Promise<void> {
  // Re-read first: another window may have changed the prompt, notes, settings or sources.
  await refreshData();
  if (!view) return;
  try {
    const fresh = buildResearchJob({ view, settings, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    job = await saveJob(db, fresh);
    $('delivery-status').hidden = true;
    stage = 'result';
    renderJob();
    $('job-preview').focus();
  } catch (error) {
    showToast(`Research Job not saved: ${errorText(error)}`, { level: 'error' });
  }
}

function saveFile(name: string, mime: string, content: string | Blob): Promise<void> {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { attrs: { href: url, download: name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Promise.resolve();
}

const deliveryEnvironment: DeliveryEnvironment = {
  copyText: (text) => navigator.clipboard.writeText(text),
  openUrl: async (url) => {
    await browser.tabs.create({ url, windowId });
  },
  saveFile,
};

async function deliver(id: DestinationId): Promise<void> {
  const status = $('delivery-status');
  // Re-read the session first: notes or captures may have changed here or in another window.
  await refreshData();
  if (!job || !draft || isJobOutdated(job, draft)) {
    status.textContent = 'Settings changed. Generate a new Research Job.';
    status.classList.add('error');
    status.setAttribute('role', 'alert');
    status.hidden = false;
    return;
  }
  const result = await deliverJob(id, job, deliveryEnvironment);
  status.textContent = result.message;
  status.classList.toggle('error', !result.ok);
  status.setAttribute('role', result.ok ? 'status' : 'alert');
  status.hidden = false;
  if (DESTINATIONS[id].kind === 'chat' && result.ok) showToast(result.message);
}

function deliverFromSheet(id: DestinationId): () => void {
  return () => {
    closeSheet();
    void deliver(id);
  };
}

function exportSheet(): void {
  openSheet('export', 'Export the Research Job', [
    h('p', {}, ['Both files contain the Research Job exactly as shown in the preview. This is not a backup of your data; use Back up all data for that.']),
    h('button', { class: 'option-button', attrs: { type: 'button', 'data-destination': 'markdown' }, on: { click: deliverFromSheet('markdown') } }, [
      h('span', { class: 'name' }, ['Markdown']),
      h('span', { class: 'file' }, ['clipgrail-session.md']),
    ]),
    h('button', { class: 'option-button', attrs: { type: 'button', 'data-destination': 'json' }, on: { click: deliverFromSheet('json') } }, [
      h('span', {}, [h('span', { class: 'name' }, ['JSON']), h('span', { class: 'meta' }, [' · text plus structured sources and settings'])]),
      h('span', { class: 'file' }, ['clipgrail-session.json']),
    ]),
  ]);
}

// ---------- Backup, restore and help ----------

async function backup(): Promise<void> {
  toggleMenu(false);
  try {
    const createdAt = new Date().toISOString();
    const allJobSettings = await getAllJobSettings();
    const written = await writeBackup(
      (visit) => visitAllData(db, visit),
      (sessionIds) => ({
        active_session_id: activeId,
        presets,
        job_settings: Object.fromEntries(Object.entries(allJobSettings).filter(([id]) => sessionIds.has(id))),
      }),
      createdAt,
    );
    if (written.bytes > MAX_BACKUP_BYTES) {
      showToast(`Backup not made: your data (about ${fmtMegabytes(written.bytes)}) is larger than a backup can hold (${fmtMegabytes(MAX_BACKUP_BYTES)}). Nothing was saved.`, { level: 'error' });
      return;
    }
    const name = backupFileName(createdAt);
    await saveFile(name, 'application/json;charset=utf-8', new Blob(written.parts));
    await setLastBackupAt(createdAt).catch(() => undefined);
    const s = written.summary;
    showToast(`Backup export started: ${name} (${plural(s.sessions, 'session')}, ${plural(s.sources, 'source')}, ${plural(s.captures, 'capture')}).`);
  } catch (error) {
    showToast(`Backup failed: ${errorText(error)}`, { level: 'error' });
  }
}

function showRestoreSheet(text: string, canConfirm: boolean): void {
  const backupToRestore = pendingRestore;
  const cancel = h('button', { attrs: { id: 'restore-cancel', type: 'button' }, on: { click: () => closeSheet() } }, [canConfirm ? 'Cancel' : 'Close']);
  openSheet(
    'restore',
    'Restore from backup',
    [
      h('p', { class: canConfirm ? 'plain-text' : 'plain-text alert-text' }, [text]),
      h('div', { class: 'sheet-actions' }, [
        canConfirm ? h('button', { class: 'danger', attrs: { id: 'restore-confirm', type: 'button' }, on: { click: () => void confirmRestore() } }, ['Replace current data']) : null,
        cancel,
      ]),
    ],
    cancel,
  );
  pendingRestore = backupToRestore;
}

async function checkRestoreFile(file: File): Promise<void> {
  if (file.size > MAX_BACKUP_BYTES) {
    pendingRestore = null;
    showRestoreSheet(`This file is larger than a ClipGrail backup can be (${fmtMegabytes(MAX_BACKUP_BYTES)}). It was not read; your data is unchanged.`, false);
    return;
  }
  const check = await validateBackup(await file.text());
  if (!check.ok) {
    pendingRestore = null;
    showRestoreSheet(`Backup rejected: ${check.error}\nCurrent data is unchanged.`, false);
    return;
  }
  pendingRestore = check.backup;
  const current = await summarizeData(db);
  const s = check.summary;
  showRestoreSheet(
    `Backup from ${fmtTime(s.created_at)} is valid: ${plural(s.sessions, 'session')}, ${plural(s.sources, 'source')}, ${plural(s.captures, 'capture')}, ${plural(s.jobs, 'job')}; all texts match their SHA-256.\n` +
      `Restoring replaces all current data (${plural(current.sessions, 'session')}, ${plural(current.sources, 'source')}, ${plural(current.captures, 'capture')}). The deletion log keeps its entries and notes the sources the backup does not have. Back up the current data first if you may need it.`,
    true,
  );
}

async function confirmRestore(): Promise<void> {
  const backupData = pendingRestore;
  if (!backupData) return;
  closeSheet();
  const result = await restoreBackup(backupData, {
    replaceData: (data) => replaceAllData(db, data),
    applySettings: async (s) => {
      await savePresets(s.presets);
      await replaceAllJobSettings(s.job_settings);
      await setActiveSessionId(s.active_session_id);
    },
  });
  detailSourceId = null;
  stage = 'prepare';
  try {
    presets = await getPresets();
    activeId = await getActiveSessionId();
    renderPresetsMenu();
    await loadActiveSession();
  } catch (error) {
    const state = !result.ok && !result.dataReplaced ? 'Restore failed and current data is unchanged' : 'The backup was restored';
    showToast(`${state}, but the panel could not show the data: ${errorText(error)}. Close and reopen the panel.`, { level: 'error' });
    return;
  }
  showToast(result.message, { level: result.ok ? 'info' : 'error' });
}

async function turnOffTabAccess(): Promise<void> {
  toggleMenu(false);
  try {
    // Also ends a recording, which needs both.
    const removed = await browser.permissions.remove({ permissions: ['tabs', 'webNavigation'] });
    // Chrome keeps the earlier consent, so the next Save tabs or Record gets the permission back without a prompt.
    if (removed) showToast('Tab access turned off. Save tabs and Record turn it on again.');
    else showToast('Tab access could not be turned off.', { level: 'error' });
  } catch (error) {
    showToast(`Tab access could not be turned off: ${errorText(error)}`, { level: 'error' });
  }
}

function helpSheet(): void {
  const item = (term: string, ...description: Child[]) => [h('dt', {}, [term]), h('dd', {}, description)];
  openSheet('help', 'How capture works', [
    h('dl', { class: 'help' }, [
      ...item(
        'Clip page',
        'Saves the readable text of the current page with the time, extraction method and SHA-256. ',
        shortcut ? h('kbd', {}, [shortcut]) : null,
        shortcut ? ' or right-click › Clip page to ClipGrail does the same.' : 'Right-click › Clip page to ClipGrail does the same.',
      ),
      ...item('Selection', 'Saves the text you selected on the page. Also in the right-click menu.'),
      ...item('Links', 'Right-click a link › Save link to ClipGrail (not opened). The address is saved as Address only; the page is not visited.'),
      ...item('Tabs', 'Saves addresses and titles of open tabs without reading them.'),
      ...item(
        'Record',
        'While recording, every page you open in this window is saved as Address only, with the page whose link led to it and how you reached it. The pages are not read; clip the ones you need. After Stop, you can remove the pages you do not need and mark the important ones. A page the session already has is noted as visited again when a new page load returns to it 30 minutes or more after it was last saved or visited; reloads, Back and Forward are not. Addresses with a sign-in or access token, such as a password-reset link, are skipped. Pages on sites listed under ··· › Sites not recorded are skipped too. Recording runs in one window at a time: starting it in another window moves it there.',
      ),
      ...item(
        "Can't read this tab?",
        "Chrome lets ClipGrail read a tab only after you act on it: click the toolbar icon, press the shortcut or use the right-click menu on that tab. Browser pages and the Chrome Web Store can't be clipped.",
      ),
    ]),
  ]);
}

// ---------- Recording ----------

async function excludedSitesSheet(): Promise<void> {
  let sites: string[];
  try {
    sites = await getExcludedSites();
  } catch (error) {
    showToast(`Sites not read: ${errorText(error)}`, { level: 'error' });
    return;
  }
  const area = h('textarea', { attrs: { id: 'excluded-sites', rows: '6', placeholder: 'mail.google.com\nonline.mybank.example', spellcheck: 'false', autocomplete: 'off' } });
  area.value = sites.join('\n');
  const save = async () => {
    const parsed = parseSiteList(area.value);
    if ('invalid' in parsed) {
      sheetError(`Not a site: ${parsed.invalid}. Write a site such as example.org, one per line.`);
      return;
    }
    try {
      await saveExcludedSites(parsed.sites);
      closeSheet();
      const n = parsed.sites.length;
      showToast(n ? `${plural(n, 'site')} ${n === 1 ? 'is' : 'are'} not recorded.` : 'All sites are recorded.');
    } catch (error) {
      sheetError(`Sites not saved: ${errorText(error)}`);
    }
  };
  openSheet(
    'excluded-sites',
    'Sites not recorded',
    [
      h('p', {}, ['Recording skips pages on these sites and their subdomains, and never saves them as the page where another was found. One site per line.']),
      h('label', { class: 'preset-field' }, [h('span', {}, ['Sites']), area]),
      h('p', { class: 'small' }, ['Kept in this browser. Not part of backups.']),
      h('div', { class: 'sheet-actions' }, [
        h('button', { class: 'primary', attrs: { type: 'button' }, on: { click: () => void save() } }, ['Save']),
        h('button', { attrs: { type: 'button' }, on: { click: () => closeSheet() } }, ['Cancel']),
      ]),
    ],
    area,
  );
}

function renderRecording(): void {
  const here = recording !== null && recording.window_id === windowId;
  const button = $<HTMLButtonElement>('record-button');
  button.setAttribute('aria-pressed', String(here));
  button.setAttribute('aria-label', here ? 'Stop recording' : 'Record');
  button.title = here
    ? `Recording: ${plural(recording!.captures.length, 'page')} saved${recording!.failed ? `, ${recording!.failed} could not be saved` : ''}. Click to stop.`
    : recording
      ? 'Recording in another window; record this window instead'
      : 'Record the address of every page you open in this window';
}

async function startRecording(): Promise<void> {
  let granted: boolean;
  try {
    // Asked in the click itself: Chrome shows its permission prompt only for a user action.
    granted = await browser.permissions.request({ permissions: ['tabs', 'webNavigation'] });
  } catch (error) {
    showToast(`Recording not started: ${errorText(error)}`, { level: 'error' });
    return;
  }
  if (!granted) {
    showToast("Recording not started: ClipGrail needs Chrome's permission to see the pages you open.", { level: 'error' });
    return;
  }
  if (windowId === undefined) return;
  const request: RecordRequest = { type: 'record', action: 'start', windowId };
  const response = await recordMessage(request);
  if (response.error !== undefined) {
    showToast(`Recording not started: ${response.error}`, { level: 'error' });
    return;
  }
  const target = view?.session.name ?? 'the active session';
  const moved = response.moved;
  showToast(
    moved
      ? `Recording moved to this window from another one${moved.saved ? `, where it saved ${plural(moved.saved, 'page')}` : ''}. Pages you open here are saved to ${target} as addresses.`
      : `Recording. Pages you open in this window are saved to ${target} as addresses.`,
  );
}

/** Sends a start or stop to the background; a failure to reach it comes back as an error. */
async function recordMessage(request: RecordRequest): Promise<RecordResponse> {
  try {
    const response = (await browser.runtime.sendMessage(request)) as RecordResponse | undefined;
    return response ?? { captures: [], failed: 0, error: 'ClipGrail did not answer.' };
  } catch (error) {
    return { captures: [], failed: 0, error: errorText(error) };
  }
}

async function stopRecording(): Promise<void> {
  if (windowId === undefined) return;
  const request: RecordRequest = { type: 'record', action: 'stop', windowId };
  const response = await recordMessage(request);
  if (response.error !== undefined) {
    showToast(`Recording not stopped: ${response.error}`, { level: 'error' });
    return;
  }
  const visits = response.visits ?? [];
  if (response.captures.length) await reviewRecording(response.captures, visits, response.failed);
  else showRecordingEnded('Recording stopped.', '', response.captures, visits, response.failed, 'Recording stopped. No new pages.');
}

/**
 * After Stop: the pages the recording saved, all kept; the ones the user
 * unchecks are removed with Remove, under the rules of Undo, with their
 * visits. A star marks a page important, which keeps it. Closing the sheet
 * keeps every page. Visits to pages the session already had stay.
 */
async function reviewRecording(saved: SavedCapture[], visits: SavedCapture[], failed: number): Promise<void> {
  let pages: SavedPage[] = [];
  let visited: SavedPage[] = [];
  try {
    [pages, visited] = await Promise.all([loadSavedPages(db, saved), loadSavedPages(db, visits)]);
  } catch {
    // The message with Undo below still lets the user remove the recording.
  }
  if (!pages.length) {
    showRecordingEnded('Recording stopped.', '', saved, visits, failed, 'Recording stopped. No new pages.');
    return;
  }
  const newSources = new Set(pages.map((page) => page.source.id));
  const earlier = new Set(visited.map((page) => page.source.id).filter((id) => !newSources.has(id))).size;
  const n = pages.length;
  const names = [...new Set(pages.map((page) => page.saved.session_id))].map((id) => sessions.find((s) => s.id === id)?.name ?? 'a session');
  const where = names.length === 1 ? names[0] : plural(names.length, 'session');
  const lost = failed ? `; ${failed} could not be saved` : '';

  const rows = pages.map((page) => {
    const box = h('input', { attrs: { type: 'checkbox' } });
    box.checked = true;
    const title = page.capture.tab_title.trim();
    const host = hostOf(page.source.dedup_url);
    const meta = page.capture.found_on ? `${host} · from ${hostOf(page.capture.found_on)}` : host;
    const star = h('button', { class: 'review-star', attrs: { type: 'button', 'aria-label': `Mark ${sourceLabel(page.source)} important` } });
    const label = h('label', {}, [
      box,
      h('span', { class: 'sid' }, [sourceLabel(page.source)]),
      h('span', { class: `title${title ? '' : ' untitled'}` }, [title || page.source.dedup_url]),
      h('span', { class: 'meta' }, [meta]),
      star,
    ]);
    return { page, box, label, star };
  });
  type Row = (typeof rows)[number];
  /** An important page is kept: its checkbox stays checked. */
  const showStar = (row: Row) => {
    const on = row.page.source.important;
    row.star.replaceChildren(icon(on ? 'star-fill' : 'star'));
    row.star.setAttribute('aria-pressed', String(on));
    row.star.classList.toggle('on', on);
    // Not disabled: a disabled checkbox drops the keyboard focus and the arrow keys skip it.
    if (on) row.box.checked = true;
    row.box.setAttribute('aria-disabled', String(on));
    row.box.title = on ? 'Important pages are kept' : '';
  };
  const toggleStar = (row: Row) => {
    const important = !row.page.source.important;
    setSourceImportant(db, row.page.source.id, important).then(
      () => {
        row.page.source.important = important;
        showStar(row);
        update();
        void refreshData();
      },
      (error: unknown) => sheetError(`Not saved: ${errorText(error)}`),
    );
  };
  const all = h('input', { attrs: { type: 'checkbox' } });
  const remove = h('button', { class: 'primary', attrs: { type: 'button' } });
  const unchecked = () => rows.filter((row) => !row.box.checked);
  const update = () => {
    const count = unchecked().length;
    for (const row of rows) row.label.classList.toggle('removed', !row.box.checked);
    all.checked = count === 0;
    all.indeterminate = count > 0 && count < n;
    remove.textContent = `Remove ${plural(count, 'page')}`;
    remove.disabled = count === 0;
  };
  all.addEventListener('change', () => {
    for (const row of rows) row.box.checked = all.checked || row.page.source.important;
    update();
  });
  for (const row of rows) {
    row.box.addEventListener('change', () => {
      if (row.page.source.important) row.box.checked = true;
      update();
    });
    row.star.addEventListener('click', () => toggleStar(row));
    showStar(row);
  }

  const list = h('ul', { class: 'checklist review-list', attrs: { 'aria-label': 'Recorded pages' } }, rows.map((row) => h('li', {}, [row.label])));
  list.addEventListener('keydown', (event) => {
    const at = rows.findIndex((row) => row.box === event.target || row.star === event.target);
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      rows[Math.min(n - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.box.focus();
    } else if (event.key === 'i' || event.key === 'I') {
      toggleStar(rows[at]!);
    } else if (event.key === 'o' || event.key === 'O') {
      // A new active tab would close the toolbar popup, and the review with it.
      const active = !document.documentElement.classList.contains('popup');
      browser.tabs.create({ url: rows[at]!.page.source.dedup_url, windowId, active }).catch((error: unknown) => sheetError(`Page not opened: ${errorText(error)}`));
    } else return;
    event.preventDefault();
  });

  remove.addEventListener('click', () => {
    const chosen = unchecked().map((row) => row.page.saved);
    remove.disabled = true;
    undoSavedCaptures(db, chosen, 'review').then(
      (result) => {
        if (sheetKind === 'review-recording') closeSheet();
        const gone = result.removed - result.stayed;
        const kept = n - chosen.length + result.kept + result.stayed;
        const reasons = [
          result.kept ? `${plural(result.kept, 'page')} you added notes to, marked important or moved ${result.kept === 1 ? 'is' : 'are'} kept.` : '',
          result.stayed ? `${plural(result.stayed, 'page')} you clipped ${result.stayed === 1 ? 'is' : 'are'} kept.` : '',
        ].filter(Boolean).join(' ');
        if (gone) showToast(`${plural(gone, 'recorded page')} removed. ${kept} kept.${reasons ? ` ${reasons}` : ''}`);
        else showToast(reasons ? `Nothing removed: ${reasons}` : 'Those pages were already removed.');
        void refreshData();
      },
      (error: unknown) => {
        sheetError(`Pages not removed: ${errorText(error)}`);
        update();
      },
    );
  });
  update();

  openSheet(
    'review-recording',
    'Review recorded pages',
    [
      h('p', {}, [
        `${plural(n, 'page')} ${n === 1 ? 'was' : 'were'} saved to ${where} as ${n === 1 ? 'an address' : 'addresses'}${lost}. `,
        earlier ? `${plural(earlier, 'page')} the session already had ${earlier === 1 ? 'was' : 'were'} visited again. ` : '',
        n === 1 ? 'Uncheck it if you do not need it; it is removed when you click Remove.' : 'Uncheck the ones you do not need; they are removed when you click Remove.',
        ' Pages you mark important stay.',
      ]),
      h('p', { class: 'small' }, ['↑ ↓ move · Space keeps or removes · I marks important · O opens the page in a new tab']),
      h('label', { class: 'review-all' }, [all, 'All pages']),
      list,
      h('div', { class: 'sheet-actions review-actions' }, [
        remove,
        h('button', { attrs: { type: 'button' }, on: { click: () => closeSheet() } }, ['Keep all']),
      ]),
    ],
    rows[0]!.box,
  );
}

/** The message after this window's recording ends, with Undo for the pages it saved and its visits. */
function showRecordingEnded(start: string, where: string, saved: SavedCapture[], visits: SavedCapture[], failed: number, nothing: string): void {
  const lost = failed ? `; ${failed} could not be saved` : '';
  const again = visits.length ? ` ${plural(visits.length, 'visit')} to pages the session already had ${visits.length === 1 ? 'was' : 'were'} noted.` : '';
  showToast(saved.length || lost ? `${start} ${plural(saved.length, 'page')} saved${where}${lost}.${again}` : `${nothing}${again}`, {
    level: lost ? 'error' : 'info',
    undo: saved.length ? () => undoBatchWithToast([...saved, ...visits], 'Recorded pages removed. Earlier captures are kept.', 'Those pages were already removed.') : undefined,
  });
}

// ---------- Views and action bar ----------

function renderBars(): void {
  $('bar-collect').hidden = !(currentView === 'collect' && detailSourceId === null);
  $('bar-prepare').hidden = !(currentView === 'job' && stage === 'prepare');
  $('bar-result').hidden = !(currentView === 'job' && stage === 'result');
}

function selectTab(name: 'collect' | 'job', focus = false): void {
  currentView = name;
  const tabs = { collect: $<HTMLButtonElement>('tab-collect'), job: $<HTMLButtonElement>('tab-job') };
  setSelected([tabs.collect, tabs.job], tabs[name], 'aria-selected');
  $('view-collect').hidden = name !== 'collect';
  $('view-job').hidden = name !== 'job';
  if (focus) tabs[name].focus();
  if (name === 'job') renderJob();
  renderBars();
}

// ---------- Wiring ----------

function bind(): void {
  $('tab-collect').addEventListener('click', () => selectTab('collect'));
  $('tab-job').addEventListener('click', () => selectTab('job'));
  rovingKeys($('tab-collect').parentElement!, (button) => selectTab(button.id === 'tab-collect' ? 'collect' : 'job'));

  $('session-button').addEventListener('click', () => void openSessionsSheet());
  $('library-button').addEventListener('click', () => showLibrary({ view: activeId }));

  $('clip-page').addEventListener('click', () => void clip('page'));
  $('clip-selection').addEventListener('click', () => void clip('selection'));
  $('tabs-button').addEventListener('click', openTabsSheet);
  for (const event of [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onHighlighted, browser.tabs.onAttached, browser.tabs.onDetached]) {
    event.addListener(() => void updateTabCounts());
  }

  $('notes-toggle').addEventListener('click', () => {
    notesOpen = !notesOpen;
    renderNotesToggle();
    if (notesOpen) $('session-notes').focus();
  });
  $<HTMLTextAreaElement>('session-notes').addEventListener('input', (event) => {
    const notes = (event.target as HTMLTextAreaElement).value;
    if (!view) return;
    view = { ...view, session: { ...view.session, notes } };
    const done = startEdit(edits.notes);
    updateSessionText(db, view.session.id, { notes }).then(done, reportSaveError('Notes'));
    renderNotesToggle();
    renderJob();
  });

  $('stage-prepare').addEventListener('click', () => setStage('prepare'));
  $('stage-result').addEventListener('click', () => setStage('result'));
  rovingKeys($('stage-prepare').parentElement!, (button) => setStage(button.id === 'stage-prepare' ? 'prepare' : 'result'));
  $<HTMLTextAreaElement>('prompt').addEventListener('input', (event) => setPrompt((event.target as HTMLTextAreaElement).value));
  $('presets-button').addEventListener('click', () => togglePresetsMenu($('presets-menu').hidden === true));
  for (const button of modeButtons()) button.addEventListener('click', () => setMode(button.dataset.mode as ContextMode));
  rovingKeys($('mode-links').parentElement!, (button) => setMode(button.dataset.mode as ContextMode));
  $('options-toggle').addEventListener('click', () => {
    optionsOpen = !optionsOpen;
    renderOptionsToggle();
  });
  $('limit').addEventListener('input', () => {
    const limit = Number.parseInt($<HTMLInputElement>('limit').value, 10);
    changeSettings({ max_chars_per_source: Number.isInteger(limit) && limit > 0 ? limit : null });
  });
  const privateFields: Array<[string, keyof JobSettings]> = [
    ['inc-notes', 'include_notes'],
    ['inc-links', 'include_link_context'],
    ['inc-times', 'include_capture_times'],
    ['inc-urls', 'include_original_urls'],
  ];
  for (const [id, key] of privateFields) {
    $(id).addEventListener('change', () => changeSettings({ [key]: $<HTMLInputElement>(id).checked }));
  }
  $('select-all').addEventListener('click', () => {
    changeSettings({ excluded_source_ids: [] });
    renderJobSources();
  });
  $('select-none').addEventListener('click', () => {
    changeSettings({ excluded_source_ids: view?.sources.map((s) => s.source.id) ?? [] });
    renderJobSources();
  });
  $('generate').addEventListener('click', () => void generateJob());
  $('generate-again').addEventListener('click', () => void generateJob());
  $('copy-job').addEventListener('click', () => void deliver('clipboard'));
  for (const button of document.querySelectorAll<HTMLButtonElement>('#bar-result .service')) {
    button.addEventListener('click', () => void deliver(button.dataset.destination as DestinationId));
  }
  $('export-button').addEventListener('click', exportSheet);

  $('menu-button').addEventListener('click', () => toggleMenu($('menu').hidden === true));
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (!$('menu').hidden && !target.closest('#menu, #menu-button')) toggleMenu(false);
    if (!$('presets-menu').hidden && !target.closest('#presets-menu, #presets-button')) togglePresetsMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (sheetKind) {
      closeSheet();
    } else if (!$('menu').hidden) {
      toggleMenu(false);
      $('menu-button').focus();
    } else if (!$('presets-menu').hidden) {
      togglePresetsMenu(false);
      $('presets-button').focus();
    } else return;
    event.preventDefault();
  });
  $('backup-button').addEventListener('click', () => void backup());
  $('excluded-sites-button').addEventListener('click', () => void excludedSitesSheet());
  $('restore-button').addEventListener('click', () => {
    toggleMenu(false);
    const input = $<HTMLInputElement>('restore-file');
    input.value = '';
    input.click();
  });
  $<HTMLInputElement>('restore-file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void checkRestoreFile(file).catch((error: unknown) => showRestoreSheet(`Backup rejected: ${errorText(error)}\nCurrent data is unchanged.`, false));
  });
  $('tab-access-button').addEventListener('click', () => void turnOffTabAccess());
  $('record-button').addEventListener('click', () => void (recording?.window_id === windowId ? stopRecording() : startRecording()));
  $('open-in-panel').addEventListener('click', () => void chooseOpenMode('panel'));
  $('open-in-popup').addEventListener('click', () => void chooseOpenMode('popup'));
  $('help-button').addEventListener('click', helpSheet);
  $('sheet-close').addEventListener('click', () => closeSheet());
  $('sheet-scrim').addEventListener('click', () => closeSheet());

  $('toast-undo').addEventListener('click', () => {
    const undo = toastUndo;
    hideToast();
    if (undo) void undo();
  });
  $('toast-close').addEventListener('click', hideToast);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[NOTICE_KEY]) handleNotice(changes[NOTICE_KEY].newValue as Notice | undefined);
    if (area === 'session' && changes[RECORDING_KEY]) {
      const value: unknown = changes[RECORDING_KEY].newValue;
      const before = recording;
      recording = isRecording(value) ? value : null;
      renderRecording();
      // Another window started recording, which ended the recording here.
      if (before && before.window_id === windowId && recording && recording.window_id !== windowId) {
        showRecordingEnded('Recording moved to another window.', ' here', before.captures, before.visits ?? [], before.failed, 'Recording moved to another window. No new pages here.');
      }
    }
    if (area === 'local' && changes[OPEN_MODE_KEY]) renderOpenMode(changes[OPEN_MODE_KEY].newValue === 'popup' ? 'popup' : 'panel');
    if (area === 'local' && changes.activeSessionId) {
      const id = changes.activeSessionId.newValue;
      if (typeof id === 'string' && id !== activeId) {
        activeId = id;
        detailSourceId = null;
        stage = 'prepare';
        void loadActiveSession();
      }
    }
  });
}

async function init(): Promise<void> {
  hydrateIcons();
  // The same page serves as the side panel and as the toolbar popup.
  const popup = new URLSearchParams(location.search).get('view') === 'popup';
  document.documentElement.classList.toggle('popup', popup);
  if (popup) {
    closeWithToast = true;
    for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => (closeWithToast = false), { capture: true, once: true });
  }
  bind();
  modifier = /Mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  // Edits here refresh other panels and the library; their edits and captures refresh this panel.
  setWriteListener(announceDataChange);
  onDataChange(() => void refreshData({ external: true }));
  try {
    db = await openDb();
    windowId = (await browser.windows.getCurrent()).id;
    presets = await getPresets();
    activeId = await getActiveSessionId();
    renderOpenMode(await getOpenMode());
    const storedRecording: unknown = (await browser.storage.session.get(RECORDING_KEY))[RECORDING_KEY];
    recording = isRecording(storedRecording) ? storedRecording : null;
    renderRecording();
    const commands = await browser.commands.getAll();
    shortcut = commands.find((c) => c.name === 'clip-page')?.shortcut ?? '';
    renderPresetsMenu();
    await loadActiveSession();
    void updateTabCounts();
    // Show a capture result that arrived while the panel was opening.
    const stored = await browser.storage.session.get(NOTICE_KEY);
    const notice = stored[NOTICE_KEY] as Notice | undefined;
    if (notice && Date.now() - notice.at < 10_000) handleNotice(notice);
  } catch (error) {
    showToast(`ClipGrail could not load its data: ${errorText(error)}`, { level: 'error' });
  }
}

void init();
