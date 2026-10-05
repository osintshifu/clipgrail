import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CaptureOutcome, TabInfo } from '../lib/capture';
import { captureLink, capturePage, captureSelection } from '../lib/capture';
import { announceDataChange } from '../lib/changes';
import { openDb, setWriteListener } from '../lib/db';
import type { ClipResponse } from '../lib/messages';
import { isClipRequest } from '../lib/messages';
import { publishNotice } from '../lib/notice';
import { resolveActiveSessionId } from '../lib/settings';

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
): Promise<ClipResponse> {
  try {
    const db = await getDb();
    return await report(await capture(db, sessionId ?? (await resolveActiveSessionId(db))), windowId);
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

export default defineBackground(() => {
  // Captures from the context menu and the shortcut refresh every open panel and the library.
  setWriteListener(announceDataChange);

  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: 'clip-page', title: 'Clip page to ClipGrail', contexts: ['page'] });
      browser.contextMenus.create({ id: 'clip-selection', title: 'Clip selection to ClipGrail', contexts: ['selection'] });
      browser.contextMenus.create({ id: 'save-link', title: 'Save link to ClipGrail (not opened)', contexts: ['link'] });
    });
  });

  // Toolbar icon: opens the panel and, as a user action, grants activeTab for the current tab.
  browser.action.onClicked.addListener((tab) => openPanel(tab.windowId));

  browser.contextMenus.onClicked.addListener((info, tab) => {
    openPanel(tab?.windowId);
    if (info.menuItemId === 'clip-page' && tab) {
      void run(tab.windowId, undefined, (db, sessionId) => capturePage(db, tab, sessionId));
    } else if (info.menuItemId === 'clip-selection' && tab) {
      void run(tab.windowId, undefined, (db, sessionId) =>
        captureSelection(db, tab, sessionId, { frameId: info.frameId, menuSelectionText: info.selectionText }),
      );
    } else if (info.menuItemId === 'save-link' && info.linkUrl) {
      const link = { url: info.linkUrl, pageUrl: info.pageUrl, frameId: info.frameId };
      void run(tab?.windowId, undefined, (db, sessionId) => captureLink(db, tab, sessionId, link));
    }
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'clip-page' || !tab) return;
    openPanel(tab.windowId);
    void run(tab.windowId, undefined, (db, sessionId) => capturePage(db, tab, sessionId));
  });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isClipRequest(message)) return false;
    void run(message.windowId, message.sessionId, async (db, sessionId) => {
      const tab = await activeTab(message.windowId);
      if (!tab) return capturePage(db, {}, sessionId);
      return message.what === 'page' ? capturePage(db, tab, sessionId) : captureSelection(db, tab, sessionId);
    }).then(sendResponse);
    return true;
  });
});
