import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CaptureOutcome, TabInfo } from '../lib/capture';
import { captureLink, capturePage, captureSelection } from '../lib/capture';
import { announceDataChange } from '../lib/changes';
import { openDb, saveThumbnail, setWriteListener } from '../lib/db';
import type { ClipResponse, RecordResponse } from '../lib/messages';
import { isClipRequest, isFromOwnPage, isRecordRequest } from '../lib/messages';
import { openLibrary } from '../lib/library-tab';
import { publishNotice } from '../lib/notice';
import { OPEN_MODE_KEY, getActiveSessionId, getOpenMode, resolveActiveSessionId } from '../lib/settings';
import { captureThumbnail } from '../lib/thumbnail';
import type { Recording, TrailEntry } from '../lib/recording';
import { RECORDING_KEY, foundOnFor, isRecording, recordVisit } from '../lib/recording';
import { plural } from '../lib/text';

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
  });
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

function showRecordingBadge(on: boolean): void {
  void browser.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) void browser.action.setBadgeBackgroundColor({ color: '#d93025' });
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
  // A recording that had to stop may have left its reason on the icon.
  void browser.action.setTitle({ title: browser.runtime.getManifest().action?.default_title ?? 'ClipGrail' });
  return previous && previous.window_id !== windowId ? { captures: [], failed: 0, moved: { saved: previous.captures.length } } : { captures: [], failed: 0 };
}

async function stopRecording(): Promise<RecordResponse> {
  const recording = await currentRecording();
  await browser.storage.session.remove([RECORDING_KEY, TRAIL_KEY]);
  showRecordingBadge(false);
  return { captures: recording?.captures ?? [], failed: recording?.failed ?? 0 };
}

/**
 * Ends a recording whose own state can no longer be written: it would
 * otherwise look complete while pages go unsaved. The panel is told how many
 * pages were saved; if even that fails, the toolbar icon says so.
 */
async function abandonRecording(recording: Recording): Promise<void> {
  showRecordingBadge(false);
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

/** Notes where a main-frame navigation in the recorded window came from. */
function navigated(tabId: number, url: string, transition: string, qualifiers: string[]): void {
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
    pages[String(tabId)] = { url, found_on: foundOnFor({ transition, qualifiers }, previous, opener) };
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
    const db = await getDb();
    saved = await recordVisit(db, await resolveActiveSessionId(db), {
      url: tab.url,
      title: tab.title ?? '',
      found_on: entry?.url === tab.url ? entry.found_on : null,
      at: new Date().toISOString(),
    });
  } catch {
    await recordFailure(recording.started_at);
    return;
  }
  if (!saved) return;
  // Stopped meanwhile: the page is saved, but no longer part of this recording's Undo.
  const now = await currentRecording();
  if (now?.started_at !== recording.started_at) return;
  const capture = { capture_id: saved.capture.id, session_id: saved.capture.session_id };
  try {
    await browser.storage.session.set({ [RECORDING_KEY]: { ...now, captures: [...now.captures, capture] } });
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
  navigation.onCommitted.addListener((d) => d.frameId === 0 && navigated(d.tabId, d.url, d.transitionType, d.transitionQualifiers));
  // Pages that change their address without loading: history.pushState, and a new #fragment (a different source, such as a Telegram channel).
  const inPage = (d: { frameId: number; tabId: number; url: string; transitionType: string; transitionQualifiers: string[] }) => {
    if (d.frameId !== 0) return;
    navigated(d.tabId, d.url, d.transitionType, d.transitionQualifiers);
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
  // A recording ends with its window, or when Chrome's access to tabs or navigation is turned off.
  browser.windows.onRemoved.addListener((windowId) => {
    void serial(async () => ((await currentRecording())?.window_id === windowId ? stopRecording() : undefined));
  });
  browser.permissions.onRemoved.addListener(({ permissions }) => {
    if (permissions?.some((p) => p === 'tabs' || p === 'webNavigation')) void serial(stopRecording);
  });

  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: 'clip-page', title: 'Clip page to ClipGrail', contexts: ['page'] });
      browser.contextMenus.create({ id: 'clip-selection', title: 'Clip selection to ClipGrail', contexts: ['selection'] });
      browser.contextMenus.create({ id: 'save-link', title: 'Save link to ClipGrail (not opened)', contexts: ['link'] });
      // Right-click on the toolbar button.
      browser.contextMenus.create({ id: 'open-panel', title: 'Open side panel', contexts: ['action'], visible: false });
      browser.contextMenus.create({ id: 'open-library', title: 'Open library', contexts: ['action'] });
      return applyOpenMode();
    });
  });
  browser.runtime.onStartup.addListener(() => void applyOpenMode());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[OPEN_MODE_KEY]) void applyOpenMode();
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
      void getActiveSessionId().then((view) => openLibrary({ view }, tab?.windowId));
      return;
    }
    showResult(tab?.windowId);
    if (info.menuItemId === 'clip-page' && tab) {
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
