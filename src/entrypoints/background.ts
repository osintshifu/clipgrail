import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CaptureOutcome, TabInfo } from '../lib/capture';
import { captureLink, capturePage, captureSelection } from '../lib/capture';
import { announceDataChange } from '../lib/changes';
import { openDb, saveThumbnail, setWriteListener } from '../lib/db';
import type { ClipResponse } from '../lib/messages';
import { isClipRequest } from '../lib/messages';
import { openLibrary } from '../lib/library-tab';
import { publishNotice } from '../lib/notice';
import { OPEN_MODE_KEY, getActiveSessionId, getOpenMode, resolveActiveSessionId } from '../lib/settings';
import { captureThumbnail } from '../lib/thumbnail';

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
  // sidePanel.close needs Chrome 141.
  browser.sidePanel.close?.({ windowId }).catch(() => undefined);
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
  // sidePanel.onOpened and onClosed need Chrome 141.
  browser.sidePanel.onOpened?.addListener(({ windowId }) => trackPanel(windowId, true));
  browser.sidePanel.onClosed?.addListener(({ windowId }) => trackPanel(windowId, false));
  browser.windows.onRemoved.addListener((windowId) => openPanels.has(windowId) && trackPanel(windowId, false));

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
        (db, sessionId) => captureSelection(db, tab, sessionId, { frameId: info.frameId, menuSelectionText: info.selectionText }),
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

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
