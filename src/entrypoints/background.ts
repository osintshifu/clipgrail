import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CaptureOutcome, TabInfo } from '../lib/capture';
import { captureAddress, captureLink, capturePage, captureSelection, clipSummary, savedText } from '../lib/capture';
import { announceDataChange } from '../lib/changes';
import { clipTargets, listSessions, loadSessionView, openDb, saveThumbnail, setWriteListener, undoSavedCaptures } from '../lib/db';
import type { DestinationId } from '../lib/destinations';
import { DESTINATIONS } from '../lib/destinations';
import { oneSourceJob } from '../lib/research-job';
import type { ClipResponse, ClipSourcesRequest, OffscreenCopy, RecordResponse } from '../lib/messages';
import { isClipCancelRequest, isClipRequest, isClipSourcesRequest, isFromOwnPage, isRecordRequest } from '../lib/messages';
import { openLibrary } from '../lib/library-tab';
import { publishNotice } from '../lib/notice';
import { OPEN_MODE_KEY, getActiveSessionId, getExcludedSites, getJobSettings, getOpenMode, resolveActiveSessionId } from '../lib/settings';
import { captureThumbnail } from '../lib/thumbnail';
import type { Recording, TrailEntry } from '../lib/recording';
import { RECORDING_KEY, REVIEW_KEY, foundOnFor, isRecording, recordVisit } from '../lib/recording';
import { plural } from '../lib/text';
import { normalizeUrl } from '../lib/url';

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  dbPromise ??= openDb().then((db) => {
    db.addEventListener('close', () => (dbPromise = null));
    db.addEventListener('versionchange', () => (dbPromise = null));
    return db;
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function report(outcome: CaptureOutcome, windowId: number | undefined): Promise<ClipResponse> {
  await publishNotice({
    window_id: windowId ?? null,
    level: outcome.saved ? 'info' : 'error',
    text: outcome.message,
    capture_id: outcome.saved ? outcome.result.capture.id : null,
  });
  return { saved: outcome.saved, message: outcome.message };
}

async function run(
  windowId: number | undefined,
  sessionId: string | undefined,
  capture: (db: IDBDatabase, sessionId: string) => Promise<CaptureOutcome>,
  thumbnail?: Promise<string | null>,
): Promise<ClipResponse> {
  try {
    const db = await getDb();
    const outcome = await capture(db, sessionId ?? (await resolveActiveSessionId(db)));
    const image = outcome.saved ? await thumbnail : null;
    // A missing thumbnail never fails the capture.
    if (outcome.saved && image) await saveThumbnail(db, outcome.result.capture.id, image).catch(() => undefined);
    return await report(outcome, windowId);
  } catch (error) {
    const message = `Capture failed: ${error instanceof Error ? error.message : String(error)}`;
    await publishNotice({ window_id: windowId ?? null, level: 'error', text: message, capture_id: null });
    return { saved: false, message };
  }
}

/** Page menu items that clip the page or the selection and open a chat with a job of it. */
const OPEN_IN: Record<string, DestinationId> = { 'open-in-chatgpt': 'chatgpt', 'open-in-claude': 'claude', 'open-in-gemini': 'gemini', 'open-in-perplexity': 'perplexity' };

/** Copies run one at a time: each opens and closes the hidden clipboard page. */
let copyWork: Promise<unknown> = Promise.resolve();

/** Copies text through the hidden clipboard page; returns why it failed, or null once copied. Needs clipboardWrite. */
function copyText(text: string): Promise<string | null> {
  const next = copyWork.then(() => copyOnce(text));
  copyWork = next.catch(() => undefined);
  return next;
}

async function copyOnce(text: string): Promise<string | null> {
  try {
    if (!(await browser.offscreen.hasDocument())) {
      await browser.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Copy a job to the clipboard for the chat it is opened in.' });
    }
    const message: OffscreenCopy = { type: 'offscreen-copy', text };
    const response = (await browser.runtime.sendMessage(message)) as { copied?: boolean } | undefined;
    return response?.copied ? null : 'the browser did not copy it';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    void browser.offscreen.closeDocument().catch(() => undefined);
  }
}

/**
 * Clips the page or the selection to the active session and makes a job of that one source: the session's prompt
 * and settings, its text in full or only this selection. The job is copied, then the chat opens in a tab next to
 * the page for the user to paste it. The job is not kept in the session.
 */
async function openInChat(
  destination: DestinationId,
  tab: TabInfo & { index?: number },
  selection: { frameId?: number; frameUrl?: string; text?: string } | null,
  copyAllowed: Promise<boolean>,
): Promise<void> {
  const windowId = tab.windowId;
  const notice = (level: 'info' | 'error', text: string, captureId: string | null = null) =>
    publishNotice({ window_id: windowId ?? null, level, text, capture_id: captureId });
  try {
    if (!(await copyAllowed.catch(() => false))) {
      return void (await notice('error', "Not opened: ClipGrail needs Chrome's permission to copy the job to the clipboard."));
    }
    const db = await getDb();
    const sessionId = await resolveActiveSessionId(db);
    const thumbnail = captureThumbnail(windowId);
    const outcome = selection
      ? await captureSelection(db, tab, sessionId, { frameId: selection.frameId, frameUrl: selection.frameUrl, menuSelectionText: selection.text })
      : await capturePage(db, tab, sessionId);
    if (!outcome.saved) return void (await report(outcome, windowId));
    const image = await thumbnail;
    if (image) await saveThumbnail(db, outcome.result.capture.id, image).catch(() => undefined);
    // A page whose text could not be read has nothing to send.
    if (!selection && outcome.result.snapshot?.status !== 'ok') return void (await report(outcome, windowId));
    const clipped = { source_id: outcome.result.source.id, capture_id: outcome.result.capture.id };
    const view = await loadSessionView(db, sessionId);
    const job = oneSourceJob(view, await getJobSettings(sessionId), clipped, selection ? 'selections' : 'full', crypto.randomUUID(), new Date().toISOString());
    const adapter = DESTINATIONS[destination];
    const failed = await copyText(job.text);
    if (failed) {
      return void (await notice('error', `${outcome.message}. The job could not be copied (${failed}), so ${adapter.name} was not opened. Use Create job in the side panel.`, outcome.result.capture.id));
    }
    await browser.tabs.create({ url: adapter.launch_url!, windowId, ...(tab.index === undefined ? {} : { index: tab.index + 1 }) });
    await notice('info', 'Job copied. Paste it into the chat.', outcome.result.capture.id);
  } catch (error) {
    await notice('error', `Not opened: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
  }
}

/** Starts recording from the page menu, with the page it was used on as the first page. */
function recordFromMenu(windowId: number, tabId: number): void {
  const notice = (level: 'info' | 'error', text: string) => publishNotice({ window_id: windowId, level, text, capture_id: null });
  // Asked in the click itself: Chrome shows its permission prompt only for a user action.
  browser.permissions.request({ permissions: ['tabs', 'webNavigation'] }).then(
    async (granted) => {
      if (!granted) return notice('error', "Recording not started: ClipGrail needs Chrome's permission to see the pages you open.");
      await serial(() => startRecording(windowId));
      recordSoon(tabId);
      const db = await getDb();
      const sessionId = await resolveActiveSessionId(db);
      const name = (await listSessions(db)).find((s) => s.id === sessionId)?.name ?? 'the active session';
      await notice('info', `Recording. Pages you open in this window are saved to ${name} as addresses.`);
    },
    (error: unknown) => notice('error', `Recording not started: ${error instanceof Error ? error.message : String(error)}`),
  ).catch(() => undefined);
}

/** Stops the recording from the page menu; the panel of the recorded window shows the review. */
function stopFromMenu(windowId: number | undefined): void {
  void serial(stopRecording)
    .then((result) => browser.storage.session.set({ [REVIEW_KEY]: { ...result, window_id: windowId ?? null, at: Date.now() } }))
    .catch(() => undefined);
}

/** Clips run one at a time, so a second request waits instead of opening its pages alongside. */
let clipWork: Promise<unknown> = Promise.resolve();
function serialClip<T>(work: () => Promise<T>): Promise<T> {
  const next = clipWork.then(work, work);
  clipWork = next.catch(() => undefined);
  return next;
}

/**
 * Clip requests waiting for Chrome to allow their sites, one per window, in session storage: the service worker
 * may stop while Chrome asks, and starts again when the sites are allowed. A request not allowed in time is dropped.
 */
const PENDING_CLIPS_KEY = 'pendingClips';
const PENDING_CLIP_MS = 2 * 60_000;
type PendingClip = ClipSourcesRequest & { at: number };

async function pendingClips(): Promise<PendingClip[]> {
  const value: unknown = (await browser.storage.session.get(PENDING_CLIPS_KEY))[PENDING_CLIPS_KEY];
  return Array.isArray(value) ? (value as PendingClip[]).filter((p) => Date.now() - p.at < PENDING_CLIP_MS) : [];
}

function queueClip(request: ClipSourcesRequest): Promise<void> {
  return serialClip(async () => {
    const others = (await pendingClips()).filter((p) => p.windowId !== request.windowId);
    await browser.storage.session.set({ [PENDING_CLIPS_KEY]: [...others, { ...request, at: Date.now() }] });
  });
}

function cancelClip(windowId: number): Promise<void> {
  return serialClip(async () => {
    await browser.storage.session.set({ [PENDING_CLIPS_KEY]: (await pendingClips()).filter((p) => p.windowId !== windowId) });
  });
}

/** Runs the waiting clips whose sites Chrome now allows; the others keep waiting. */
function runAllowedClips(): Promise<void> {
  return serialClip(async () => {
    const ready: PendingClip[] = [];
    const waiting: PendingClip[] = [];
    for (const pending of await pendingClips()) (await browser.permissions.contains({ origins: pending.origins }) ? ready : waiting).push(pending);
    await browser.storage.session.set({ [PENDING_CLIPS_KEY]: waiting });
    for (const request of ready) await clipSources(request);
  });
}

/** Clips sources saved as a URL only, one page after another, and says what happened in a notice. */
async function clipSources(request: ClipSourcesRequest): Promise<void> {
  const notice = (level: 'info' | 'error', text: string, captureId: string | null = null) =>
    publishNotice({ window_id: request.windowId, level, text, capture_id: captureId }).catch(() => undefined);
  try {
    const db = await getDb();
    // After a recording: the pages left unchecked go, under the rules of Undo.
    if (request.remove?.length) await undoSavedCaptures(db, request.remove, 'review');
    const done = [];
    for (const target of await clipTargets(db, request.sourceIds)) done.push({ target, outcome: await captureAddress(db, target, request.windowId) });
    if (!done.length) return void (await notice('error', 'Nothing was clipped: the sources were deleted.'));
    const clipped = done.filter((d) => savedText(d.outcome)).length;
    const only = done.length === 1 ? done[0]!.outcome : null;
    await notice(clipped === done.length ? 'info' : 'error', clipSummary(done), only?.saved ? only.result.capture.id : null);
  } catch (error) {
    await notice('error', `Not clipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function activeTab(windowId: number): Promise<TabInfo | undefined> {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  return tab;
}

/** Opens the side panel. Must be called synchronously inside a user-action handler. */
function openPanel(windowId: number | undefined): void {
  if (windowId === undefined) return;
  browser.sidePanel.open({ windowId }).catch(() => {
    // The panel can still be opened from the toolbar icon.
  });
}

/**
 * Shows a capture result from the shortcut or the page menu: in the side
 * panel, or in the popup when the side panel is turned off (popup mode).
 * Synchronous for the same reason as openPanel.
 */
function showResult(windowId: number | undefined): void {
  if (windowId === undefined) return;
  browser.sidePanel.open({ windowId }).catch(() => browser.action.openPopup({ windowId }).catch(() => undefined));
}

const POPUP_PATH = 'sidepanel.html?view=popup';

/**
 * Windows with an open ClipGrail side panel. Kept in session storage too,
 * because the service worker stops when idle and starts again on a click.
 */
const OPEN_PANELS_KEY = 'openPanels';
const openPanels = new Set<number>();
let openPanelsKnown = false;
let openPanelsLoaded: Promise<void> = Promise.resolve();

function trackPanel(windowId: number, open: boolean): void {
  void openPanelsLoaded.then(async () => {
    if (open) openPanels.add(windowId);
    else openPanels.delete(windowId);
    await browser.storage.session.set({ [OPEN_PANELS_KEY]: [...openPanels] });
    if (!open) await applyOpenMode();
  }).catch(() => undefined);
}

function closePanel(windowId: number): void {
  browser.sidePanel.close({ windowId }).catch(() => undefined);
  trackPanel(windowId, false);
}

/** The toolbar button in side panel mode: opens the panel, or closes it when it is open in this window. */
function togglePanel(windowId: number | undefined): void {
  if (windowId === undefined) return;
  if (openPanelsKnown && openPanels.has(windowId)) return closePanel(windowId);
  openPanel(windowId);
  // Right after the service worker starts, open panels are not known yet; one that was open closes now.
  if (!openPanelsKnown) void openPanelsLoaded.then(() => openPanels.has(windowId) && closePanel(windowId));
}

/**
 * Points the toolbar button at the popup or the side panel. Popup mode turns
 * the side panel off, so the shortcut and the page menu show results in the
 * popup; it does so only once no ClipGrail panel is open, so switching never
 * closes the panel in use.
 */
async function applyOpenMode(): Promise<void> {
  const popup = (await getOpenMode()) === 'popup';
  await openPanelsLoaded;
  await Promise.all([
    browser.action.setPopup({ popup: popup ? POPUP_PATH : '' }),
    browser.contextMenus.update('open-panel', { visible: popup }).catch(() => undefined),
    popup && openPanels.size > 0 ? undefined : browser.sidePanel.setOptions({ enabled: !popup }),
  ]);
}

// ---------- Recording ----------

/** What each tab of the recorded window showed last; kept with the recording in session storage. */
const TRAIL_KEY = 'recordingTrail';
let recordingWork: Promise<unknown> = Promise.resolve();

/** Runs recording work one step at a time, so its state is never written by two steps at once. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = recordingWork.then(work, work);
  recordingWork = next.catch(() => undefined);
  return next;
}

async function currentRecording(): Promise<Recording | null> {
  const value: unknown = (await browser.storage.session.get(RECORDING_KEY))[RECORDING_KEY];
  return isRecording(value) ? value : null;
}

async function trail(): Promise<Record<string, TrailEntry>> {
  const value: unknown = (await browser.storage.session.get(TRAIL_KEY))[TRAIL_KEY];
  return value && typeof value === 'object' ? (value as Record<string, TrailEntry>) : {};
}

/** The window being recorded, known without waiting, so the page menu can stop it within the click. */
let recordedWindow: number | null = null;

function showRecordingBadge(on: boolean): void {
  void browser.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) void browser.action.setBadgeBackgroundColor({ color: '#d93025' });
}

/** The page menu offers Start recording, or Stop recording while one runs. */
function showRecordingMenu(windowId: number | null): void {
  recordedWindow = windowId;
  void browser.contextMenus.update('record-start', { visible: windowId === null }).catch(() => undefined);
  void browser.contextMenus.update('record-stop', { visible: windowId !== null }).catch(() => undefined);
}

async function startRecording(windowId: number): Promise<RecordResponse> {
  // Recording runs in one window at a time: a start in another window moves it here, and both panels say so.
  const previous = await currentRecording();
  // The pages already open are where the first links of the recording are found.
  const tabs = await browser.tabs.query({ windowId });
  const pages = Object.fromEntries(tabs.filter((t) => t.id !== undefined && t.url).map((t) => [String(t.id), { url: t.url!, found_on: null }]));
  const recording: Recording = { window_id: windowId, started_at: new Date().toISOString(), captures: [], failed: 0 };
  await browser.storage.session.set({ [RECORDING_KEY]: recording, [TRAIL_KEY]: pages });
  listenToNavigation();
  showRecordingBadge(true);
  showRecordingMenu(windowId);
  // A recording that had to stop may have left its reason on the icon.
  void browser.action.setTitle({ title: browser.runtime.getManifest().action?.default_title ?? 'ClipGrail' });
  return previous && previous.window_id !== windowId ? { captures: [], failed: 0, moved: { saved: previous.captures.length } } : { captures: [], failed: 0 };
}

async function stopRecording(): Promise<RecordResponse> {
  const recording = await currentRecording();
  await browser.storage.session.remove([RECORDING_KEY, TRAIL_KEY]);
  showRecordingBadge(false);
  showRecordingMenu(null);
  return { captures: recording?.captures ?? [], visits: recording?.visits ?? [], failed: recording?.failed ?? 0 };
}

/**
 * Ends a recording whose own state can no longer be written: it would
 * otherwise look complete while pages go unsaved. The panel is told how many
 * pages were saved; if even that fails, the toolbar icon says so.
 */
async function abandonRecording(recording: Recording): Promise<void> {
  showRecordingBadge(false);
  showRecordingMenu(null);
  await browser.storage.session.remove([RECORDING_KEY, TRAIL_KEY]).catch(() => undefined);
  const saved = recording.captures.length;
  const text = `Recording stopped: ClipGrail could not keep track of it. ${plural(saved, 'page')} ${saved === 1 ? 'was' : 'were'} saved before that.`;
  try {
    await publishNotice({ window_id: recording.window_id, level: 'error', text, capture_id: null });
  } catch {
    void browser.action.setBadgeText({ text: '!' });
    void browser.action.setTitle({ title: text });
  }
}

/** Counts a page the recording could not save. */
async function recordFailure(started: string): Promise<void> {
  const now = await currentRecording().catch(() => null);
  if (now?.started_at !== started) return;
  try {
    await browser.storage.session.set({ [RECORDING_KEY]: { ...now, failed: now.failed + 1 } });
  } catch {
    await abandonRecording(now);
  }
}

/** Notes where a main-frame navigation in the recorded window came from and how Chrome says it was reached. */
function navigated(tabId: number, url: string, transition: string, qualifiers: string[], inPage: boolean): void {
  void serial(async () => {
    const recording = await currentRecording();
    if (!recording) return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.windowId !== recording.window_id || tab.incognito) return;
    const pages = await trail();
    const previous = pages[String(tabId)];
    let opener: string | null = null;
    if (!previous && tab.openerTabId !== undefined) {
      opener = pages[String(tab.openerTabId)]?.url ?? (await browser.tabs.get(tab.openerTabId).catch(() => null))?.url ?? null;
    }
    const sameAddress = !!previous && (previous.url === url || (normalizeUrl(previous.url) ?? previous.url) === normalizeUrl(url));
    pages[String(tabId)] =
      // A page that rewrites its address in place (replaceState while loading, a tracking parameter removed) continues the navigation that loaded it.
      inPage && previous && sameAddress
        ? { ...previous, url }
        : {
            url,
            found_on: foundOnFor({ transition, qualifiers }, previous, opener, url),
            navigation: { transition, qualifiers: [...qualifiers], in_page: inPage },
            same_page: sameAddress,
          };
    // Without its trail the recording would name the wrong pages as where the next ones were found.
    await browser.storage.session.set({ [TRAIL_KEY]: pages }).catch(() => abandonRecording(recording));
  });
}

/** Saves a tab's page once it has loaded; a short delay lets its title settle. */
const pendingTabs = new Map<number, ReturnType<typeof setTimeout>>();
function recordSoon(tabId: number): void {
  clearTimeout(pendingTabs.get(tabId));
  pendingTabs.set(
    tabId,
    setTimeout(() => {
      pendingTabs.delete(tabId);
      // recordTab handles its own failures; this only keeps a failed read of the recording from going unhandled.
      void serial(() => recordTab(tabId)).catch(() => undefined);
    }, 700),
  );
}

async function recordTab(tabId: number): Promise<void> {
  const recording = await currentRecording();
  if (!recording) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.windowId !== recording.window_id || tab.incognito || tab.status !== 'complete') return;
  let saved;
  try {
    const entry = (await trail())[String(tabId)];
    const known = entry?.url === tab.url;
    const db = await getDb();
    saved = await recordVisit(
      db,
      await resolveActiveSessionId(db),
      {
        url: tab.url,
        title: tab.title ?? '',
        found_on: known ? entry.found_on : null,
        navigation: known ? (entry.navigation ?? null) : null,
        same_page: known && !!entry.same_page,
        at: new Date().toISOString(),
      },
      // Read at every page, so a change to the list applies to a recording already running.
      await getExcludedSites(),
    );
  } catch {
    await recordFailure(recording.started_at);
    return;
  }
  if (!saved) return;
  // Stopped meanwhile: the page is saved, but no longer part of this recording's Undo.
  const now = await currentRecording();
  if (now?.started_at !== recording.started_at) return;
  const capture = { capture_id: saved.capture.id, session_id: saved.capture.session_id };
  const update: Recording = saved.capture.kind === 'visit' ? { ...now, visits: [...(now.visits ?? []), capture] } : { ...now, captures: [...now.captures, capture] };
  try {
    await browser.storage.session.set({ [RECORDING_KEY]: update });
  } catch {
    await abandonRecording(now);
  }
}

let listening = false;
/** webNavigation is optional: its events exist once Chrome has granted it, at startup or when a recording starts. */
function listenToNavigation(): void {
  const navigation = browser.webNavigation as typeof browser.webNavigation | undefined;
  if (listening || !navigation) return;
  listening = true;
  navigation.onCommitted.addListener((d) => d.frameId === 0 && navigated(d.tabId, d.url, d.transitionType, d.transitionQualifiers, false));
  // Pages that change their address without loading: history.pushState, and a new #fragment (a different source, such as a Telegram channel).
  const inPage = (d: { frameId: number; tabId: number; url: string; transitionType: string; transitionQualifiers: string[] }) => {
    if (d.frameId !== 0) return;
    navigated(d.tabId, d.url, d.transitionType, d.transitionQualifiers, true);
    recordSoon(d.tabId);
  };
  navigation.onHistoryStateUpdated.addListener(inPage);
  navigation.onReferenceFragmentUpdated.addListener(inPage);
  navigation.onCompleted.addListener((d) => d.frameId === 0 && recordSoon(d.tabId));
}

export default defineBackground(() => {
  // Captures from the context menu and the shortcut refresh every open panel and the library.
  setWriteListener(announceDataChange);

  openPanelsLoaded = browser.storage.session.get(OPEN_PANELS_KEY).then(
    (stored) => {
      const ids: unknown = stored[OPEN_PANELS_KEY];
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') openPanels.add(id);
      openPanelsKnown = true;
    },
    () => void (openPanelsKnown = true),
  );
  browser.sidePanel.onOpened.addListener(({ windowId }) => trackPanel(windowId, true));
  browser.sidePanel.onClosed.addListener(({ windowId }) => trackPanel(windowId, false));
  browser.windows.onRemoved.addListener((windowId) => openPanels.has(windowId) && trackPanel(windowId, false));

  listenToNavigation();
  void currentRecording().then((recording) => showRecordingMenu(recording?.window_id ?? null), () => undefined);
  // A recording ends with its window, or when Chrome's access to tabs or navigation is turned off.
  browser.windows.onRemoved.addListener((windowId) => {
    void serial(async () => ((await currentRecording())?.window_id === windowId ? stopRecording() : undefined));
  });
  // Sites allowed for Clip page: the clips waiting for them run now.
  browser.permissions.onAdded.addListener(({ origins }) => void (origins?.length && runAllowedClips().catch(() => undefined)));
  browser.permissions.onRemoved.addListener(({ permissions }) => {
    if (permissions?.some((p) => p === 'tabs' || p === 'webNavigation')) void serial(stopRecording);
  });

  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus.removeAll().then(() => {
      // One ClipGrail entry in the page menu, with what fits where the user right-clicked.
      browser.contextMenus.create({ id: 'clipgrail', title: 'ClipGrail', contexts: ['page', 'selection', 'link'] });
      type Where = 'page' | 'selection' | 'link';
      const item = (id: string, title: string, contexts: [Where, ...Where[]], more: { parentId?: string; visible?: boolean } = {}) =>
        browser.contextMenus.create({ id, title, contexts, parentId: 'clipgrail', ...more });
      item('clip-page', 'Clip page', ['page']);
      item('clip-selection', 'Clip selection', ['selection']);
      item('save-link', 'Clip URL', ['link']);
      item('record-start', 'Start recording', ['page'], { visible: recordedWindow === null });
      item('record-stop', 'Stop recording', ['page', 'selection', 'link'], { visible: recordedWindow !== null });
      browser.contextMenus.create({ id: 'open-in-separator', type: 'separator', parentId: 'clipgrail', contexts: ['page', 'selection'] });
      item('open-in', 'Open in', ['page', 'selection']);
      for (const [id, destination] of Object.entries(OPEN_IN)) item(id, DESTINATIONS[destination].name, ['page', 'selection'], { parentId: 'open-in' });
      // Right-click on the toolbar button.
      browser.contextMenus.create({ id: 'open-panel', title: 'Open side panel', contexts: ['action'], visible: false });
      browser.contextMenus.create({ id: 'open-library', title: 'Open library', contexts: ['action'] });
      return applyOpenMode();
    }).catch(() => undefined);
  });
  browser.runtime.onStartup.addListener(() => void applyOpenMode().catch(() => undefined));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[OPEN_MODE_KEY]) void applyOpenMode().catch(() => undefined);
  });

  // Toolbar icon in side panel mode (in popup mode Chrome opens the popup instead). As a user action, it grants activeTab for the current tab.
  browser.action.onClicked.addListener((tab) => togglePanel(tab.windowId));

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'open-panel') {
      // Popup mode keeps the side panel off; it turns off again when this panel closes. Both calls stay synchronous.
      void browser.sidePanel.setOptions({ enabled: true });
      openPanel(tab?.windowId);
      return;
    }
    if (info.menuItemId === 'open-library') {
      void getActiveSessionId()
        .then((view) => openLibrary({ view }, tab?.windowId))
        .catch(() => undefined);
      return;
    }
    if (info.menuItemId === 'record-stop') {
      const windowId = recordedWindow ?? tab?.windowId;
      showResult(windowId);
      stopFromMenu(windowId);
      return;
    }
    showResult(tab?.windowId);
    if (info.menuItemId === 'record-start' && tab?.windowId !== undefined && tab.id !== undefined) {
      recordFromMenu(tab.windowId, tab.id);
    } else if (typeof info.menuItemId === 'string' && info.menuItemId in OPEN_IN && tab) {
      const selection = info.selectionText ? { frameId: info.frameId, frameUrl: info.frameUrl, text: info.selectionText } : null;
      // Asked in the click itself, once: the job is copied by ClipGrail's own hidden page, which needs this permission.
      const copyAllowed = browser.permissions.request({ permissions: ['clipboardWrite'] });
      void openInChat(OPEN_IN[info.menuItemId]!, tab, selection, copyAllowed);
    } else if (info.menuItemId === 'clip-page' && tab) {
      void run(tab.windowId, undefined, (db, sessionId) => capturePage(db, tab, sessionId), captureThumbnail(tab.windowId));
    } else if (info.menuItemId === 'clip-selection' && tab) {
      void run(
        tab.windowId,
        undefined,
        (db, sessionId) => captureSelection(db, tab, sessionId, { frameId: info.frameId, frameUrl: info.frameUrl, menuSelectionText: info.selectionText }),
        captureThumbnail(tab.windowId),
      );
    } else if (info.menuItemId === 'save-link' && info.linkUrl) {
      const link = { url: info.linkUrl, pageUrl: info.pageUrl, frameId: info.frameId };
      void run(tab?.windowId, undefined, (db, sessionId) => captureLink(db, tab, sessionId, link));
    }
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'clip-page' || !tab) return;
    showResult(tab.windowId);
    void run(tab.windowId, undefined, (db, sessionId) => capturePage(db, tab, sessionId), captureThumbnail(tab.windowId));
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isFromOwnPage(sender, browser.runtime.id, browser.runtime.getURL('/'))) return false;
    if (isRecordRequest(message)) {
      void serial(() => (message.action === 'start' ? startRecording(message.windowId) : stopRecording())).then(sendResponse, (error: unknown) =>
        sendResponse({ captures: [], failed: 0, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    }
    if (isClipSourcesRequest(message)) {
      void queueClip(message).then(runAllowedClips).catch(() => undefined);
      sendResponse({ queued: true });
      return false;
    }
    if (isClipCancelRequest(message)) {
      void cancelClip(message.windowId).catch(() => undefined);
      sendResponse({ cancelled: true });
      return false;
    }
    if (!isClipRequest(message)) return false;
    void run(
      message.windowId,
      message.sessionId,
      async (db, sessionId) => {
        const tab = await activeTab(message.windowId);
        if (!tab) return capturePage(db, {}, sessionId);
        return message.what === 'page' ? capturePage(db, tab, sessionId) : captureSelection(db, tab, sessionId);
      },
      captureThumbnail(message.windowId),
    ).then(sendResponse);
    return true;
  });
});
