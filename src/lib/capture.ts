import { browser } from 'wxt/browser';
import type { CaptureDraft, CommitResult } from './db';
import { commitCapture } from './db';
import type { CaptureFrame, PageCode, PageExtraction } from './model';
import { sourceLabel } from './model';
import { describeFailure, frameSourceUnestablished } from './selection';
import type { SnapshotDraft } from './snapshot';
import { buildFragment, buildSnapshotDraft, failedSnapshotDraft } from './snapshot';
import { frameAddress, isCapturableUrl, isProvenanceUrl, normalizeUrl } from './url';
import { cleanPageCode } from './page-code';
import { plural } from './text';
import type { ClipTarget } from './clip-address';
import { fileTypeOf } from './clip-address';

/** Longest wait for the extractor before the capture is saved as failed (timeout). */
export const EXTRACTION_TIMEOUT_MS = 30_000;
/** Reading the page code beside a selection; a page that takes longer is saved without it. */
const PAGE_CODE_TIMEOUT_MS = 5_000;
/** Longest wait for a page opened to be clipped to finish loading; it is read as it is then. */
const LOAD_TIMEOUT_MS = 20_000;
/** After loading, pages that write their text with scripts get a moment more. */
const SETTLE_MS = 1_000;

export type NotSavedReason =
  | 'no_tab'
  | 'no_access'
  | 'blocked_page'
  | 'tab_gone'
  | 'empty_selection'
  | 'unsupported_link'
  | 'page_changed'
  | 'error_page'
  | 'frame_error_page'
  | 'not_opened'
  | 'not_a_page'
  | 'no_site_access'
  | 'storage_error';

export type CaptureOutcome =
  | { saved: true; result: CommitResult; message: string }
  | { saved: false; reason: NotSavedReason; message: string };

export interface TabInfo {
  id?: number;
  url?: string;
  title?: string;
  windowId?: number;
}

type ScriptErrorKind = 'no_access' | 'blocked_page' | 'page_unavailable' | 'tab_gone' | 'other';

/** Classifies chrome.scripting errors by their message. */
export function classifyScriptError(error: unknown): ScriptErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/showing error page/i.test(message)) return 'page_unavailable';
  if (/Cannot access contents of|must request permission|Missing host permission/i.test(message)) return 'no_access';
  if (/Cannot access a chrome|extensions gallery cannot be scripted|chrome-extension:\/\/|chrome-error|devtools:/i.test(message)) {
    return 'blocked_page';
  }
  if (/No tab with id|No frame with id|frame with ID \d+ was removed|frame was removed|tab was closed/i.test(message)) return 'tab_gone';
  return 'other';
}

async function shortcutHint(): Promise<string> {
  try {
    const commands = await browser.commands.getAll();
    const shortcut = commands.find((c) => c.name === 'clip-page')?.shortcut;
    return shortcut ? `press ${shortcut}, or click` : 'click';
  } catch {
    return 'click';
  }
}

async function notSaved(reason: NotSavedReason, detail?: string): Promise<CaptureOutcome> {
  const messages: Record<NotSavedReason, string> = {
    no_tab: 'No active tab found in this window.',
    // Without access Chrome hides the tab URL, so a browser page (chrome://) looks the same as an ungranted web page.
    no_access: `ClipGrail can't read this tab yet. On a web page, ${await shortcutHint()} the ClipGrail toolbar icon, and clip again. Browser pages (chrome://) and the Chrome Web Store can't be clipped.`,
    blocked_page: "This page can't be clipped. ClipGrail captures http and https pages; Chrome blocks extensions on browser pages and the Chrome Web Store.",
    tab_gone: 'The tab was closed or navigated away before the capture finished. Nothing was saved.',
    empty_selection: 'Nothing is selected on this page.',
    unsupported_link: 'Only http and https links can be saved.',
    page_changed: 'The page changed while it was being clipped, so nothing was saved. Clip it again.',
    error_page: "This tab shows the browser's error page, not the page, so there is no selection to clip. Nothing was saved. Clip page saves the address as Capture failed.",
    frame_error_page: "This embedded frame shows the browser's error page, not its page, so there is no selection to clip. Nothing was saved.",
    not_opened: `The page could not be opened${detail ? ` (${detail})` : ''}. Nothing was saved.`,
    not_a_page: `This address leads to a ${detail?.toUpperCase() ?? ''} file, not a web page, so it was not opened. Nothing was saved.`,
    no_site_access: `ClipGrail may not read ${detail ?? 'this site'}, so nothing was saved. Allow the site when Chrome asks; a page that moves to another site needs that site too.`,
    storage_error: `Capture not saved: the browser refused to store it${detail ? ` (${detail})` : ''}. Existing data is unchanged.`,
  };
  return { saved: false, reason, message: messages[reason] };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('Extraction timed out', 'TimeoutError')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isPageExtraction(value: unknown): value is PageExtraction {
  return !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean';
}

function savedMessage(result: CommitResult): string {
  const label = sourceLabel(result.source);
  const where = result.isNewSource ? 'new source' : `capture ${result.captureCount} of this source`;
  const snapshot = result.snapshot;
  // A link to a page the session already has adds a capture; the source may have its text.
  if (result.capture.kind === 'link') return `Saved ${label} as a link, not opened · ${result.isNewSource ? 'URL only' : where}`;
  if (result.capture.kind === 'selection') {
    const partial = result.capture.fragment?.truncated ? ' · partial: cut at the length limit' : '';
    const frame = result.capture.frame;
    const from = !frame
      ? ''
      : frameSourceUnestablished(frame)
        ? ' · from an embedded frame, source URL not established'
        : ` · from an embedded frame (${new URL(frame.url!).hostname})`;
    return `Clipped selection to ${label} · ${where}${from}${partial}`;
  }
  if (snapshot?.status === 'failed') return `Saved ${label} without text: ${describeFailure(snapshot)}`;
  if (snapshot?.status === 'ok') {
    const notes = [
      snapshot.truncated ? `partial: cut at ${snapshot.character_count.toLocaleString('en-US')} characters` : null,
      snapshot.extraction_method === 'page-text' ? 'page text, no article found' : null,
    ].filter(Boolean);
    return `Clipped as ${label} · ${where}${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
  }
  return `Saved ${label}`;
}

async function save(db: IDBDatabase, draft: CaptureDraft): Promise<CaptureOutcome> {
  try {
    const result = await commitCapture(db, draft);
    return { saved: true, result, message: savedMessage(result) };
  } catch (error) {
    const detail = error instanceof DOMException ? error.name : error instanceof Error ? error.message : String(error);
    return notSaved('storage_error', detail);
  }
}

/**
 * Captures the readable text of a tab. Needs activeTab access to the tab
 * (granted by the toolbar icon, the keyboard shortcut or the context menu).
 * Access problems save nothing; page problems are saved as a failed snapshot
 * so the URL and the failure are kept.
 */
export async function capturePage(db: IDBDatabase, tab: TabInfo, sessionId: string): Promise<CaptureOutcome> {
  const capturedAt = new Date().toISOString();
  if (tab.id === undefined) return notSaved('no_tab');
  if (!tab.url) return notSaved('no_access');
  const dedupUrl = normalizeUrl(tab.url);
  if (!dedupUrl) return notSaved('blocked_page');
  const read = await readTab(tab.id, dedupUrl);
  if ('reason' in read) return notSaved(read.reason);
  return save(db, {
    session_id: sessionId,
    kind: 'page',
    dedup_url: dedupUrl,
    captured_at: capturedAt,
    original_url: tab.url,
    tab_title: tab.title ?? '',
    found_on: null,
    anchor_text: null,
    fragment: null,
    page_code: read.pageCode,
    snapshot: read.snapshot,
  });
}

/**
 * Reads the text and page code of a tab with the extractor. Access problems are reasons to save nothing; page
 * problems become a failed snapshot, so the address and the failure are kept.
 */
async function readTab(tabId: number, dedupUrl: string): Promise<{ snapshot: SnapshotDraft; pageCode: PageCode | null } | { reason: NotSavedReason }> {
  try {
    const results = await withTimeout(browser.scripting.executeScript({ target: { tabId }, files: ['/extract.js'] }), EXTRACTION_TIMEOUT_MS);
    const value: unknown = results[0]?.result;
    // The text must come from the document the source URL was taken from; a navigation in between would
    // attach another page's text to this source.
    if (isPageExtraction(value) && normalizeUrl(value.page_url) !== dedupUrl) return { reason: 'page_changed' };
    const now = new Date().toISOString();
    return isPageExtraction(value)
      ? { snapshot: await buildSnapshotDraft(value, now), pageCode: cleanPageCode(value.page_code) }
      : { snapshot: failedSnapshotDraft('extraction_error', 'The extractor returned no result.', now), pageCode: null };
  } catch (error) {
    const now = new Date().toISOString();
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { snapshot: failedSnapshotDraft('timeout', `Extraction did not finish within ${EXTRACTION_TIMEOUT_MS / 1000} s.`, now), pageCode: null };
    }
    const kind = classifyScriptError(error);
    if (kind === 'no_access' || kind === 'blocked_page' || kind === 'tab_gone') return { reason: kind };
    const snapshot =
      kind === 'page_unavailable'
        ? failedSnapshotDraft('page_unavailable', 'The browser showed an error page instead of the page.', now)
        : failedSnapshotDraft('extraction_error', error instanceof Error ? error.message : String(error), now);
    return { snapshot, pageCode: null };
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/** The tab once it has loaded and settled, or as it is after LOAD_TIMEOUT_MS; null when it was closed meanwhile. */
function loadedTab(tabId: number): Promise<TabInfo | null> {
  return new Promise((resolve) => {
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(settle);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.onRemoved.removeListener(removed);
      if (closed) resolve(null);
      else browser.tabs.get(tabId).then(resolve, () => resolve(null));
    };
    // A redirect made by the page starts loading again, which waits for the next page.
    const status = (value: string | undefined) => {
      if (value === 'loading') clearTimeout(settle);
      if (value === 'complete') {
        clearTimeout(settle);
        settle = setTimeout(() => finish(false), SETTLE_MS);
      }
    };
    const updated = (id: number, change: { status?: string }) => id === tabId && status(change.status);
    const removed = (id: number) => id === tabId && finish(true);
    const deadline = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(updated);
    browser.tabs.onRemoved.addListener(removed);
    // A page from the cache may have loaded before the listener was added.
    browser.tabs.get(tabId).then((tab) => status(tab.status), () => finish(true));
  });
}

/** True when a clip saved the page's text. */
export const savedText = (outcome: CaptureOutcome) => outcome.saved && outcome.result.snapshot?.status === 'ok';

/** One message for clipping sources: what happened to one, or how many pages got their text and what happened to the others. */
export function clipSummary(done: Array<{ target: ClipTarget; outcome: CaptureOutcome }>): string {
  const told = ({ target, outcome }: { target: ClipTarget; outcome: CaptureOutcome }) => (outcome.saved ? outcome.message : `${target.label}: ${outcome.message}`);
  if (done.length === 1) return told(done[0]!);
  const others = done.filter((d) => !savedText(d.outcome)).map(told);
  return [`Clipped ${done.length - others.length} of ${plural(done.length, 'page')}.`, ...others].join(' ');
}

/**
 * Clips a source saved as a URL only: opens its page in a background tab of the window, reads it once it has
 * loaded, saves the text to that source and closes the tab. Chrome's permission for the site is asked for
 * beforehand; a page that moved to a site without it is not read. No picture is taken, as the tab is not shown.
 */
export async function captureAddress(db: IDBDatabase, target: ClipTarget, windowId?: number): Promise<CaptureOutcome> {
  const capturedAt = new Date().toISOString();
  // A file would not give text, and opening most of them starts a download.
  const file = fileTypeOf(target.url);
  if (file) return notSaved('not_a_page', file);
  let tabId: number | undefined;
  try {
    try {
      tabId = (await browser.tabs.create({ url: target.url, active: false, ...(windowId === undefined ? {} : { windowId }) })).id;
    } catch (error) {
      return notSaved('not_opened', error instanceof Error ? error.message : String(error));
    }
    if (tabId === undefined) return notSaved('not_opened');
    const tab = await loadedTab(tabId);
    if (!tab) return notSaved('tab_gone');
    // Without permission for the site the page is on, Chrome does not give its address.
    if (!tab.url) return notSaved('no_site_access', hostOf(target.url));
    const dedupUrl = normalizeUrl(tab.url);
    if (!dedupUrl) return notSaved('blocked_page');
    const read = await readTab(tabId, dedupUrl);
    if ('reason' in read) return notSaved(read.reason === 'no_access' ? 'no_site_access' : read.reason, hostOf(tab.url));
    // The text is the source's, also from the address its page moved to, which the capture keeps as visited.
    return await save(db, {
      session_id: target.session_id,
      kind: 'page',
      dedup_url: target.dedup_url,
      captured_at: capturedAt,
      original_url: tab.url,
      tab_title: tab.title ?? '',
      found_on: null,
      anchor_text: null,
      fragment: null,
      page_code: read.pageCode,
      snapshot: read.snapshot,
    });
  } finally {
    if (tabId !== undefined) void browser.tabs.remove(tabId).catch(() => undefined);
  }
}

/**
 * The page code of the document a selection is saved from: the frame when the frame is the source, else the page.
 * Null when it cannot be read or the document is no longer at the source's address.
 */
async function selectionPageCode(tabId: number, frameId: number, dedupUrl: string): Promise<PageCode | null> {
  try {
    const results = await withTimeout(browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['/page-code.js'] }), PAGE_CODE_TIMEOUT_MS);
    const value = results[0]?.result as { page_url?: unknown } | undefined;
    return typeof value?.page_url === 'string' && normalizeUrl(value.page_url) === dedupUrl ? cleanPageCode(value) : null;
  } catch {
    return null;
  }
}

/**
 * Where a selection is saved. In the page itself: the page. In an embedded
 * frame with an http or https address: that address, found on the page. In
 * any other frame (about:srcdoc, blob:, or an address that could not be read)
 * the selection's source URL is not established: the page is kept as context
 * and the capture notes the frame, without claiming the page as its origin.
 */
export function selectionTarget(
  tabUrl: string,
  frameId: number,
  frameUrl: unknown,
): { url: string; found_on: string | null; frame: CaptureFrame | null } {
  if (frameId === 0) return { url: tabUrl, found_on: null, frame: null };
  const address = frameAddress(frameUrl);
  if (address && isCapturableUrl(address)) return { url: address, found_on: isProvenanceUrl(tabUrl) ? tabUrl : null, frame: { url: address } };
  return { url: tabUrl, found_on: null, frame: { url: address } };
}

/**
 * Captures the selected text of a tab (or of one frame). `menuSelectionText`
 * is Chrome's flattened selection from the context menu, used only when the
 * frame itself cannot be read; `frameUrl` is the frame's address as the
 * context menu reports it.
 */
export async function captureSelection(
  db: IDBDatabase,
  tab: TabInfo,
  sessionId: string,
  options: { frameId?: number; frameUrl?: string; menuSelectionText?: string } = {},
): Promise<CaptureOutcome> {
  const capturedAt = new Date().toISOString();
  if (tab.id === undefined) return notSaved('no_tab');
  if (!tab.url) return notSaved('no_access');
  const pageUrl = normalizeUrl(tab.url);
  if (!pageUrl) return notSaved('blocked_page');

  let text = '';
  let method: 'dom-selection' | 'menu-selection-text' = 'dom-selection';
  const frameId = options.frameId ?? 0;
  let frameUrl: unknown = options.frameUrl ?? null;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      func: () => ({ text: window.getSelection()?.toString() ?? '', url: document.URL }),
    });
    const value = results[0]?.result as { text?: unknown; url?: unknown } | undefined;
    // In the top frame the selection must come from the page the source URL was taken from.
    if (frameId === 0 && value && normalizeUrl(String(value.url)) !== pageUrl) return notSaved('page_changed');
    // A frame's own document says where it is, also after it navigated.
    if (frameId !== 0 && typeof value?.url === 'string') frameUrl = value.url;
    text = typeof value?.text === 'string' ? value.text : '';
  } catch (error) {
    const kind = classifyScriptError(error);
    if (kind === 'tab_gone') return notSaved('tab_gone');
    // Chrome's copy of the selection on its error page is the browser's message, not text of the source.
    if (kind === 'page_unavailable') return notSaved(frameId === 0 ? 'error_page' : 'frame_error_page');
    if (!options.menuSelectionText) return notSaved(kind === 'blocked_page' ? 'blocked_page' : 'no_access');
  }
  if (!text.trim() && options.menuSelectionText) {
    text = options.menuSelectionText;
    method = 'menu-selection-text';
  }
  const fragment = await buildFragment(text, method);
  if (!fragment) return notSaved('empty_selection');

  const target = selectionTarget(tab.url, frameId, frameUrl);
  const frameSource = target.url !== tab.url;
  const dedupUrl = frameSource ? normalizeUrl(target.url)! : pageUrl;
  return save(db, {
    session_id: sessionId,
    kind: 'selection',
    dedup_url: dedupUrl,
    captured_at: capturedAt,
    original_url: target.url,
    // The tab title belongs to the page, not to a frame saved as its own source.
    tab_title: frameSource ? '' : (tab.title ?? ''),
    found_on: target.found_on,
    anchor_text: null,
    fragment,
    frame: target.frame,
    page_code: await selectionPageCode(tab.id, frameSource ? frameId : 0, dedupUrl),
    snapshot: null,
  });
}

/** Link text of the anchors pointing at `href`, only if all of them agree. Runs in the page. */
function findAnchorText(href: string): string | null {
  const texts = new Set<string>();
  for (const link of Array.from(document.links)) {
    if (link.href !== href) continue;
    const text = (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) texts.add(text.slice(0, 500));
  }
  return texts.size === 1 ? [...texts][0]! : null;
}

/**
 * Saves a link without opening it: the source gets a PENDING snapshot and
 * nothing is downloaded. found_on and the link text are recorded as private
 * provenance; the link text only when it is unambiguous.
 */
export async function captureLink(
  db: IDBDatabase,
  tab: TabInfo | undefined,
  sessionId: string,
  link: { url: string; pageUrl?: string; frameId?: number },
): Promise<CaptureOutcome> {
  const capturedAt = new Date().toISOString();
  const dedupUrl = normalizeUrl(link.url);
  if (!dedupUrl) return notSaved('unsupported_link');

  let anchorText: string | null = null;
  if (tab?.id !== undefined) {
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [link.frameId ?? 0] },
        func: findAnchorText,
        args: [link.url],
      });
      anchorText = typeof results[0]?.result === 'string' ? results[0].result : null;
    } catch {
      // The link is saved without its text when the page cannot be read.
    }
  }

  return save(db, {
    session_id: sessionId,
    kind: 'link',
    dedup_url: dedupUrl,
    captured_at: capturedAt,
    original_url: link.url,
    tab_title: '',
    found_on: [link.pageUrl, tab?.url].find((u): u is string => !!u && isProvenanceUrl(u)) ?? null,
    anchor_text: anchorText,
    fragment: null,
    snapshot: { status: 'pending' },
  });
}
