import './style.css';
import { browser } from 'wxt/browser';
import { backupFileName, createBackup, restoreBackup, summarize, validateBackup } from '../../lib/backup';
import type { Backup } from '../../lib/backup';
import {
  createSession,
  latestJob,
  listSessions,
  loadSessionView,
  openDb,
  readAllData,
  renameSession,
  replaceAllData,
  saveJob,
  undoCapture,
  updateCaptureNote,
  updateSessionText,
} from '../../lib/db';
import type { SessionView, SourceEntry } from '../../lib/db';
import type { DeliveryEnvironment, DestinationId } from '../../lib/destinations';
import { DESTINATIONS, deliverJob } from '../../lib/destinations';
import type { ClipRequest, ClipResponse } from '../../lib/messages';
import { INBOX_SESSION_ID, sourceLabel } from '../../lib/model';
import type { Capture, Session } from '../../lib/model';
import type { Notice } from '../../lib/notice';
import { NOTICE_KEY } from '../../lib/notice';
import type { ContextMode, JobSettings, ResearchJob } from '../../lib/research-job';
import { buildResearchJob, isJobOutdated } from '../../lib/research-job';
import type { SourceStatus } from '../../lib/selection';
import { capturedTitle, chooseSnapshot, describeFailure, failedSnapshotOf, okSnapshotOf } from '../../lib/selection';
import type { Preset } from '../../lib/settings';
import {
  getActiveSessionId,
  getJobSettings,
  getAllJobSettings,
  getPresets,
  saveJobSettings,
  replaceAllJobSettings,
  savePresets,
  setActiveSessionId,
} from '../../lib/settings';

// ---------- DOM helpers (page content is only ever inserted as text) ----------

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; attrs?: Record<string, string>; on?: Partial<Record<string, (event: Event) => void>> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(k, fn);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

const nf = new Intl.NumberFormat('en-US');
const fmtNumber = (n: number) => nf.format(n);
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtBytes(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

const STATUS_LABELS: Record<SourceStatus, string> = {
  ok: 'OK',
  partial: 'Partial',
  failed: 'Failed',
  pending: 'Pending',
  none: 'No snapshot',
};
const badge = (status: SourceStatus) => h('span', { class: `badge ${status}` }, [STATUS_LABELS[status]]);

// ---------- State ----------

let db: IDBDatabase;
let windowId: number | undefined;
let sessions: Session[] = [];
let activeId = INBOX_SESSION_ID;
let view: SessionView | null = null;
let detailSourceId: string | null = null;
let presets: Preset[] = [];
let settings: JobSettings;
let job: ResearchJob | undefined;
let draft: ResearchJob | undefined;
let pendingRestore: Backup | null = null;
let sessionFormMode: 'create' | 'rename' = 'create';
let shortcut = '';
let lastNoticeId = '';
let previousPrompt: string | null = null;

// ---------- Toast ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastUndo: (() => Promise<void>) | null = null;

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

// ---------- Sessions ----------

function renderSessions(): void {
  const select = $<HTMLSelectElement>('session-select');
  select.replaceChildren(...sessions.map((s) => h('option', { attrs: { value: s.id } }, [s.name])));
  select.value = activeId;
  $<HTMLButtonElement>('rename-session').disabled = activeId === INBOX_SESSION_ID;
  $<HTMLButtonElement>('rename-session').title = activeId === INBOX_SESSION_ID ? 'The Inbox keeps its name' : '';
}

function openSessionForm(mode: 'create' | 'rename'): void {
  sessionFormMode = mode;
  const input = $<HTMLInputElement>('session-name');
  input.value = mode === 'rename' ? (view?.session.name ?? '') : '';
  input.placeholder = mode === 'create' ? 'New session name' : 'Session name';
  $('session-save').textContent = mode === 'create' ? 'Create' : 'Save';
  $('session-form').hidden = false;
  input.focus();
  input.select();
}
function closeSessionForm(): void {
  $('session-form').hidden = true;
}

async function switchSession(id: string): Promise<void> {
  activeId = id;
  detailSourceId = null;
  await setActiveSessionId(id);
  await loadActiveSession();
}

// ---------- Loading ----------

async function loadActiveSession(): Promise<void> {
  sessions = await listSessions(db);
  if (!sessions.some((s) => s.id === activeId)) activeId = INBOX_SESSION_ID;
  view = await loadSessionView(db, activeId);
  settings = await getJobSettings(activeId);
  job = await latestJob(db, activeId);
  previousPrompt = null;
  $<HTMLTextAreaElement>('prompt').value = view.session.prompt;
  $<HTMLTextAreaElement>('session-notes').value = view.session.notes;
  fillJobForm();
  $('delivery-status').hidden = true;
  renderSessions();
  renderCollect();
  renderJob();
}

async function refreshData(): Promise<void> {
  if (!db) return;
  try {
    const fresh = await loadSessionView(db, activeId);
    // Keep text being typed: the prompt and notes fields are the source of truth while edited.
    view = { ...fresh, session: { ...fresh.session, prompt: view?.session.prompt ?? fresh.session.prompt, notes: view?.session.notes ?? fresh.session.notes } };
  } catch {
    await loadActiveSession();
    return;
  }
  renderCollect();
  renderJob();
}

// ---------- Collect view ----------

function sourceMeta(entry: SourceEntry): Child[] {
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  const selections = entry.captures.filter((c) => c.capture.kind === 'selection').length;
  const parts: string[] = [];
  if (ok) parts.push(ok.truncated ? `${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} chars` : `${fmtNumber(ok.character_count)} chars`);
  if (failed) parts.push(describeFailure(failed));
  if (choice.status === 'pending') parts.push('link saved, not opened');
  parts.push(`${entry.captures.length} ${entry.captures.length === 1 ? 'capture' : 'captures'}`);
  if (selections) parts.push(`${selections} ${selections === 1 ? 'selection' : 'selections'}`);
  return [
    badge(choice.status),
    ok?.extraction_method === 'page-text' ? h('span', { class: 'badge fallback' }, ['Page text']) : null,
    parts.join(' · '),
  ];
}

function renderCollect(): void {
  if (!view) return;
  const list = $('source-list');
  list.replaceChildren(
    ...view.sources.map((entry) =>
      h('li', {}, [
        h(
          'button',
          {
            class: 'src',
            attrs: { type: 'button', 'aria-label': `${sourceLabel(entry.source)}: ${capturedTitle(entry) ?? entry.source.dedup_url}, open details` },
            on: { click: () => openDetail(entry.source.id) },
          },
          [
            h('span', { class: 'sid' }, [sourceLabel(entry.source)]),
            h('span', { class: 'title' }, [capturedTitle(entry) ?? entry.source.dedup_url]),
            h('span', { class: 'url' }, [entry.source.dedup_url.replace(/^https?:\/\//, '')]),
            h('span', { class: 'meta' }, sourceMeta(entry)),
          ],
        ),
      ]),
    ),
  );
  $('sources-heading').textContent = `Sources · ${view.sources.length}`;
  $('sources-empty').hidden = view.sources.length > 0;
  if (detailSourceId && !view.sources.some((s) => s.source.id === detailSourceId)) detailSourceId = null;
  $('sources-panel').hidden = detailSourceId !== null;
  $('detail-panel').hidden = detailSourceId === null;
  if (detailSourceId) renderDetail();
}

function openDetail(sourceId: string): void {
  detailSourceId = sourceId;
  renderCollect();
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


function captureBlock(capture: Capture, entry: SourceEntry, index: number): HTMLElement {
  const snapshot = entry.captures[index]?.snapshot;
  let status = '';
  if (capture.kind === 'selection' && capture.fragment) {
    status = `${fmtNumber(capture.fragment.character_count)} chars${capture.fragment.truncated ? ', partial' : ''}`;
  } else if (snapshot?.status === 'ok') status = snapshot.truncated ? 'Partial' : 'OK';
  else if (snapshot?.status === 'failed') status = `Failed: ${describeFailure(snapshot)}`;
  else if (snapshot?.status === 'pending') status = 'Pending';
  const noteId = `note-${capture.id}`;
  return h('li', { class: 'capture' }, [
    h('div', { class: 'head' }, [`Capture ${index + 1} · ${capture.kind} · ${fmtTime(capture.captured_at)}${status ? ` · ${status}` : ''}`]),
    capture.fragment ? h('pre', { class: 'text-box small-box' }, [capture.fragment.text]) : null,
    capture.kind === 'link'
      ? h('div', { class: 'line' }, [
          `Found on: ${capture.found_on ?? 'unknown page'}`,
          capture.anchor_text ? ` · Link text: "${capture.anchor_text}"` : '',
        ])
      : null,
    capture.original_url !== entry.source.dedup_url ? h('div', { class: 'line' }, [`Original URL: ${capture.original_url}`]) : null,
    snapshot?.status === 'failed' ? h('div', { class: 'line' }, [snapshot.error_message]) : null,
    h('label', { class: 'visually-hidden', attrs: { for: noteId } }, [`Note for capture ${index + 1}`]),
    (() => {
      const area = h('textarea', { attrs: { id: noteId, rows: '2', placeholder: 'Add a private note…' } });
      area.value = capture.note;
      area.addEventListener('input', () => {
        capture.note = area.value;
        updateCaptureNote(db, capture.id, area.value).catch(reportSaveError('Note'));
        renderJob();
      });
      return area;
    })(),
  ]);
}

function renderDetail(): void {
  const entry = view?.sources.find((s) => s.source.id === detailSourceId);
  const panel = $('detail-panel');
  if (!entry) {
    panel.replaceChildren();
    return;
  }
  const choice = chooseSnapshot(entry);
  const ok = okSnapshotOf(choice);
  const failed = failedSnapshotOf(choice);
  const title = capturedTitle(entry);
  let snapshotInfo: Child[];
  if (ok) {
    const which = choice.total === 1 ? 'only capture' : `capture ${choice.position} of ${choice.total}, latest successful`;
    snapshotInfo = [
      `Snapshot ${fmtTime(ok.captured_at)} · ${ok.extraction_method}${ok.fallback_reason ? ` (${ok.fallback_reason.replace(/_/g, ' ')})` : ''} · ${fmtNumber(ok.character_count)} characters · ${which}`,
      h('br'),
      'SHA-256 ',
      h('code', { attrs: { title: ok.sha256 } }, [`${ok.sha256.slice(0, 12)}…${ok.sha256.slice(-6)}`]),
      ok.truncated ? h('div', { class: 'alert' }, [`Partial snapshot: cut at capture to ${fmtNumber(ok.character_count)} of ${fmtNumber(ok.original_character_count)} characters.`]) : null,
    ];
  } else if (failed) {
    snapshotInfo = [`No text saved. Latest attempt ${fmtTime(failed.captured_at)} failed: ${describeFailure(failed)}.`];
  } else if (choice.status === 'pending') {
    snapshotInfo = ['Pending: the link was saved without opening the page. Open it and clip the page to capture its text.'];
  } else {
    snapshotInfo = ['No page snapshot: only selections were captured for this source.'];
  }
  panel.replaceChildren(
    h('div', { class: 'detail' }, [
      h('button', { class: 'link', attrs: { id: 'detail-back', type: 'button' }, on: { click: closeDetail } }, ['‹ Back to sources']),
      h('h3', {}, [h('span', { class: 'sid' }, [sourceLabel(entry.source)]), ' ', title ?? '(title not captured)']),
      h('a', { class: 'url-link', attrs: { href: entry.source.dedup_url, target: '_blank', rel: 'noopener noreferrer' } }, [entry.source.dedup_url]),
      h('div', { class: 'snapmeta' }, [badge(choice.status), ' ', ...snapshotInfo]),
      ok ? h('pre', { class: 'text-box', attrs: { tabindex: '0', 'aria-label': 'Snapshot text' } }, [ok.text]) : null,
      h('ul', {}, entry.captures.map((c, i) => captureBlock(c.capture, entry, i))),
    ]),
  );
}

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

// ---------- Research Job view ----------

function fillJobForm(): void {
  $<HTMLInputElement>(`mode-${settings.context_mode}`).checked = true;
  $<HTMLInputElement>('limit').value = settings.max_chars_per_source ? String(settings.max_chars_per_source) : '';
  $<HTMLInputElement>('inc-notes').checked = settings.include_notes;
  $<HTMLInputElement>('inc-links').checked = settings.include_link_context;
  $<HTMLInputElement>('inc-times').checked = settings.include_capture_times;
  $<HTMLInputElement>('inc-urls').checked = settings.include_original_urls;
}

function readJobForm(): void {
  const mode = document.querySelector<HTMLInputElement>('input[name="context"]:checked')?.value as ContextMode | undefined;
  const limit = Number.parseInt($<HTMLInputElement>('limit').value, 10);
  settings = {
    ...settings,
    context_mode: mode ?? 'full',
    max_chars_per_source: Number.isInteger(limit) && limit > 0 ? limit : null,
    include_notes: $<HTMLInputElement>('inc-notes').checked,
    include_link_context: $<HTMLInputElement>('inc-links').checked,
    include_capture_times: $<HTMLInputElement>('inc-times').checked,
    include_original_urls: $<HTMLInputElement>('inc-urls').checked,
  };
}

function persistSettings(sessionId: string, value: JobSettings): void {
  saveJobSettings(sessionId, value).catch(reportSaveError('Settings'));
}

function settingsChanged(): void {
  readJobForm();
  persistSettings(activeId, settings);
  renderJob();
}

function persistPrompt(sessionId: string, prompt: string): void {
  updateSessionText(db, sessionId, { prompt }).catch(reportSaveError('Prompt'));
}

function setPrompt(prompt: string): void {
  if (!view) return;
  view = { ...view, session: { ...view.session, prompt } };
  persistPrompt(activeId, prompt);
  renderJob();
}

function renderPresets(): void {
  $('preset-chips').replaceChildren(
    ...presets.map((preset) =>
      h(
        'button',
        {
          attrs: { type: 'button', title: preset.text || 'Empty preset: write your own prompt' },
          on: {
            click: () => {
              const area = $<HTMLTextAreaElement>('prompt');
              const before = area.value;
              area.value = preset.text;
              setPrompt(preset.text);
              area.focus();
              if (before.trim() && before !== preset.text) {
                previousPrompt = before;
                showToast(`Prompt replaced with the ${preset.name} preset.`, {
                  undo: async () => {
                    if (previousPrompt === null) return;
                    area.value = previousPrompt;
                    setPrompt(previousPrompt);
                    previousPrompt = null;
                    hideToast();
                  },
                });
              }
            },
          },
        },
        [preset.name],
      ),
    ),
  );
}

function openPresetEditor(): void {
  const editor = $('preset-editor');
  const areas = presets.map((preset) => {
    const area = h('textarea', { attrs: { id: `preset-${preset.id}`, rows: '3' } });
    area.value = preset.text;
    return area;
  });
  editor.replaceChildren(
    ...presets.flatMap((preset, i) => [h('label', { attrs: { for: `preset-${preset.id}` } }, [preset.name]), areas[i]!]),
    h('div', { class: 'btns' }, [
      h(
        'button',
        {
          class: 'primary',
          attrs: { type: 'button' },
          on: {
            click: async () => {
              presets = presets.map((p, i) => ({ ...p, text: areas[i]!.value }));
              try {
                await savePresets(presets);
                showToast('Presets saved.');
              } catch (error) {
                showToast(`Presets not saved: ${errorText(error)}`, { level: 'error' });
              }
              closePresetEditor();
              renderPresets();
            },
          },
        },
        ['Save presets'],
      ),
      h('button', { attrs: { type: 'button' }, on: { click: closePresetEditor } }, ['Cancel']),
    ]),
  );
  editor.hidden = false;
  $('edit-presets').setAttribute('aria-expanded', 'true');
  areas[0]?.focus();
}
function closePresetEditor(): void {
  $('preset-editor').hidden = true;
  $('edit-presets').setAttribute('aria-expanded', 'false');
  $('edit-presets').focus();
}

function renderJobSources(): void {
  if (!view) return;
  const excluded = new Set(settings.excluded_source_ids);
  $('job-sources').replaceChildren(
    ...view.sources.map((entry) => {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = !excluded.has(entry.source.id);
      box.addEventListener('change', () => {
        const set = new Set(settings.excluded_source_ids);
        if (box.checked) set.delete(entry.source.id);
        else set.add(entry.source.id);
        settings = { ...settings, excluded_source_ids: [...set] };
        persistSettings(activeId, settings);
        renderJob();
      });
      return h('li', {}, [
        h('label', {}, [
          box,
          h('span', { class: 'sid' }, [sourceLabel(entry.source)]),
          h('span', { class: 'title' }, [capturedTitle(entry) ?? entry.source.dedup_url]),
          badge(chooseSnapshot(entry).status),
        ]),
      ]);
    }),
  );
  const selected = view.sources.filter((s) => !excluded.has(s.source.id)).length;
  $('job-sources-heading').textContent = `Sources · ${selected} of ${view.sources.length}`;
}

function renderJob(): void {
  if (!view) return;
  renderJobSources();
  draft = buildResearchJob({ view, settings, id: 'draft', createdAt: '' });
  const stats = draft.stats;
  const missing = draft.sources.filter((s) => s.material === 'missing').map((s) => s.label);
  const partial = draft.sources.filter((s) => s.material === 'partial').map((s) => s.label);
  const missingWhat = settings.context_mode === 'selections' ? 'selection' : 'snapshot';
  $('summary').replaceChildren(
    h('b', {}, [`${stats.source_count} ${stats.source_count === 1 ? 'source' : 'sources'}`]),
    ` · ${fmtNumber(stats.character_count)} characters · ~${fmtBytes(stats.utf8_bytes)} UTF-8`,
    h('br'),
    `${missing.length} missing ${missingWhat}${missing.length === 1 ? '' : 's'}${missing.length ? ` (${missing.join(', ')})` : ''} · `,
    `${partial.length} partial${partial.length ? ` (${partial.join(', ')})` : ''}`,
  );

  const reasons: string[] = [];
  if (!view.session.prompt.trim()) reasons.push('Write a session prompt first.');
  if (stats.source_count === 0) reasons.push('Select at least one source.');
  $<HTMLButtonElement>('generate').disabled = reasons.length > 0;
  $('generate-hint').textContent = reasons.join(' ');
  $('generate-hint').hidden = reasons.length === 0;

  const result = $('job-result');
  result.hidden = !job;
  if (!job) return;
  const outdated = isJobOutdated(job, draft);
  $('job-result-title').textContent = `Generated ${fmtTime(job.created_at)}`;
  $('job-result-meta').textContent = `${job.stats.source_count} ${job.stats.source_count === 1 ? 'source' : 'sources'} · ${fmtNumber(job.stats.character_count)} chars`;
  $('job-stale').hidden = !outdated;
  if ($('job-preview').textContent !== job.text) $('job-preview').textContent = job.text;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#job-result [data-destination]')) {
    button.disabled = outdated;
  }
}

async function generateJob(): Promise<void> {
  if (!view) return;
  try {
    await updateSessionText(db, activeId, { prompt: view.session.prompt });
    const fresh = buildResearchJob({ view, settings, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    job = await saveJob(db, fresh);
    $('delivery-status').hidden = true;
    renderJob();
    $('job-preview').focus();
  } catch (error) {
    showToast(`Research Job not saved: ${errorText(error)}`, { level: 'error' });
  }
}

function saveFile(name: string, mime: string, content: string): Promise<void> {
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

// ---------- Backup and restore ----------

function toggleMenu(open: boolean): void {
  $('menu').hidden = !open;
  $('menu-button').setAttribute('aria-expanded', String(open));
  if (open) $('backup-button').focus();
}

async function backup(): Promise<void> {
  toggleMenu(false);
  try {
    const createdAt = new Date().toISOString();
    const data = await readAllData(db);
    const sessionIds = new Set((data.sessions as Session[]).map((s) => s.id));
    const jobSettings = Object.fromEntries(Object.entries(await getAllJobSettings()).filter(([id]) => sessionIds.has(id)));
    const settings = { active_session_id: activeId, presets, job_settings: jobSettings };
    const content = JSON.stringify(createBackup(data, settings, createdAt), null, 1);
    const name = backupFileName(createdAt);
    await saveFile(name, 'application/json;charset=utf-8', content);
    const s = summarize(data, createdAt);
    showToast(`Backup export started: ${name} (${s.sessions} sessions, ${s.sources} sources, ${s.captures} captures).`);
  } catch (error) {
    showToast(`Backup failed: ${errorText(error)}`, { level: 'error' });
  }
}

function showRestorePanel(text: string, canConfirm: boolean): void {
  $('restore-text').textContent = text;
  $('restore-confirm').hidden = !canConfirm;
  $('restore-cancel').textContent = canConfirm ? 'Cancel' : 'Close';
  $('restore-panel').hidden = false;
  $('restore-panel').focus();
}
function closeRestorePanel(): void {
  pendingRestore = null;
  $('restore-panel').hidden = true;
}

async function checkRestoreFile(file: File): Promise<void> {
  const check = await validateBackup(await file.text());
  if (!check.ok) {
    pendingRestore = null;
    showRestorePanel(`Backup rejected: ${check.error}\nCurrent data is unchanged.`, false);
    return;
  }
  pendingRestore = check.backup;
  const current = summarize(await readAllData(db), '');
  const s = check.summary;
  showRestorePanel(
    `Backup from ${fmtTime(s.created_at)} is valid: ${s.sessions} sessions, ${s.sources} sources, ${s.captures} captures, ${s.jobs} jobs; all texts match their SHA-256.\n` +
      `Restoring replaces all current data (${current.sessions} sessions, ${current.sources} sources, ${current.captures} captures). Back up the current data first if you may need it.`,
    true,
  );
}

async function confirmRestore(): Promise<void> {
  const backupData = pendingRestore;
  if (!backupData) return;
  closeRestorePanel();
  const result = await restoreBackup(backupData, {
    replaceData: (data) => replaceAllData(db, data),
    applySettings: async (s) => {
      await savePresets(s.presets);
      await replaceAllJobSettings(s.job_settings);
      await setActiveSessionId(s.active_session_id);
    },
  });
  detailSourceId = null;
  try {
    presets = await getPresets();
    activeId = await getActiveSessionId();
    renderPresets();
    await loadActiveSession();
  } catch (error) {
    const state = !result.ok && !result.dataReplaced ? 'Restore failed and current data is unchanged' : 'The backup was restored';
    showToast(`${state}, but the panel could not show the data: ${errorText(error)}. Close and reopen the panel.`, { level: 'error' });
    return;
  }
  showToast(result.message, { level: result.ok ? 'info' : 'error' });
}

// ---------- Tabs ----------

function selectTab(name: 'collect' | 'job', focus = false): void {
  const tabs = { collect: $('tab-collect'), job: $('tab-job') };
  for (const [key, tab] of Object.entries(tabs)) {
    const on = key === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  $('view-collect').hidden = name !== 'collect';
  $('view-job').hidden = name !== 'job';
  if (focus) tabs[name].focus();
  if (name === 'job') renderJob();
}

// ---------- Wiring ----------

function bind(): void {
  $('tab-collect').addEventListener('click', () => selectTab('collect'));
  $('tab-job').addEventListener('click', () => selectTab('job'));
  for (const id of ['tab-collect', 'tab-job']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        selectTab(id === 'tab-collect' ? 'job' : 'collect', true);
        event.preventDefault();
      }
    });
  }

  $<HTMLSelectElement>('session-select').addEventListener('change', (event) => {
    void switchSession((event.target as HTMLSelectElement).value);
  });
  $('new-session').addEventListener('click', () => openSessionForm('create'));
  $('rename-session').addEventListener('click', () => openSessionForm('rename'));
  $('session-cancel').addEventListener('click', closeSessionForm);
  $('session-form').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSessionForm();
  });
  $('session-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $<HTMLInputElement>('session-name').value;
    void (async () => {
      try {
        if (sessionFormMode === 'create') {
          const session = await createSession(db, name);
          closeSessionForm();
          await switchSession(session.id);
          showToast(`Session "${session.name}" created. New captures go here.`);
        } else {
          await renameSession(db, activeId, name);
          closeSessionForm();
          await loadActiveSession();
        }
      } catch (error) {
        showToast(errorText(error), { level: 'error' });
      }
    })();
  });

  $('clip-page').addEventListener('click', () => void clip('page'));
  $('clip-selection').addEventListener('click', () => void clip('selection'));

  $<HTMLTextAreaElement>('session-notes').addEventListener('input', (event) => {
    const notes = (event.target as HTMLTextAreaElement).value;
    if (view) view = { ...view, session: { ...view.session, notes } };
    updateSessionText(db, activeId, { notes }).catch(reportSaveError('Notes'));
    renderJob();
  });

  $<HTMLTextAreaElement>('prompt').addEventListener('input', (event) => setPrompt((event.target as HTMLTextAreaElement).value));
  $('edit-presets').addEventListener('click', () => ($('preset-editor').hidden ? openPresetEditor() : closePresetEditor()));
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="context"], #inc-notes, #inc-links, #inc-times, #inc-urls')) {
    input.addEventListener('change', settingsChanged);
  }
  $('limit').addEventListener('input', settingsChanged);
  $('select-all').addEventListener('click', () => {
    settings = { ...settings, excluded_source_ids: [] };
    persistSettings(activeId, settings);
    renderJob();
  });
  $('select-none').addEventListener('click', () => {
    settings = { ...settings, excluded_source_ids: view?.sources.map((s) => s.source.id) ?? [] };
    persistSettings(activeId, settings);
    renderJob();
  });
  $('generate').addEventListener('click', () => void generateJob());
  for (const button of document.querySelectorAll<HTMLButtonElement>('#job-result [data-destination]')) {
    button.addEventListener('click', () => void deliver(button.dataset.destination as DestinationId));
  }

  $('menu-button').addEventListener('click', () => toggleMenu($('menu').hidden === true));
  $('menu').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      toggleMenu(false);
      $('menu-button').focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (!$('menu').hidden && !(event.target as HTMLElement).closest('.menu-wrap')) toggleMenu(false);
  });
  $('backup-button').addEventListener('click', () => void backup());
  $('restore-button').addEventListener('click', () => {
    toggleMenu(false);
    const input = $<HTMLInputElement>('restore-file');
    input.value = '';
    input.click();
  });
  $<HTMLInputElement>('restore-file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void checkRestoreFile(file).catch((error: unknown) => showRestorePanel(`Backup rejected: ${errorText(error)}\nCurrent data is unchanged.`, false));
  });
  $('restore-confirm').addEventListener('click', () => void confirmRestore());
  $('restore-cancel').addEventListener('click', closeRestorePanel);
  $('restore-panel').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeRestorePanel();
  });

  $('toast-undo').addEventListener('click', () => {
    const undo = toastUndo;
    hideToast();
    if (undo) void undo();
  });
  $('toast-close').addEventListener('click', hideToast);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[NOTICE_KEY]) handleNotice(changes[NOTICE_KEY].newValue as Notice | undefined);
    if (area === 'local' && changes.activeSessionId) {
      const id = changes.activeSessionId.newValue;
      if (typeof id === 'string' && id !== activeId) {
        activeId = id;
        detailSourceId = null;
        void loadActiveSession();
      }
    }
  });
}

async function init(): Promise<void> {
  bind();
  try {
    db = await openDb();
    windowId = (await browser.windows.getCurrent()).id;
    presets = await getPresets();
    activeId = await getActiveSessionId();
    const commands = await browser.commands.getAll();
    shortcut = commands.find((c) => c.name === 'clip-page')?.shortcut ?? '';
    $('clip-hint').textContent =
      `Right-click a link to save it without opening it.${shortcut ? ` ${shortcut} clips the current page.` : ''}`;
    renderPresets();
    await loadActiveSession();
    // Show a capture result that arrived while the panel was opening.
    const stored = await browser.storage.session.get(NOTICE_KEY);
    const notice = stored[NOTICE_KEY] as Notice | undefined;
    if (notice && Date.now() - notice.at < 10_000) handleNotice(notice);
  } catch (error) {
    showToast(`ClipGrail could not load its data: ${errorText(error)}`, { level: 'error' });
  }
}

void init();
