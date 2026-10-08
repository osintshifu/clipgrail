import { browser } from 'wxt/browser';
import type { CaptureDraft, CommitResult } from './db';
import { commitCapture } from './db';
import type { CaptureFrame, PageExtraction } from './model';
import { sourceLabel } from './model';
import { describeFailure, frameSourceUnestablished } from './selection';
import type { SnapshotDraft } from './snapshot';
import { buildFragment, buildSnapshotDraft, failedSnapshotDraft } from './snapshot';
import { frameAddress, isCapturableUrl, isProvenanceUrl, normalizeUrl } from './url';

/** Longest wait for the extractor before the capture is saved as failed (timeout). */
export const EXTRACTION_TIMEOUT_MS = 30_000;

export type NotSavedReason =
  | 'no_tab'
  | 'no_access'
  | 'blocked_page'
  | 'tab_gone'
  | 'empty_selection'
  | 'unsupported_link'
  | 'page_changed'
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
  if (/No tab with id|No frame with id|frame was removed|tab was closed/i.test(message)) return 'tab_gone';
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
  if (result.capture.kind === 'link') return `Saved ${label} as a link, not opened · Pending`;
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

  let snapshot: SnapshotDraft;
  try {
    const results = await withTimeout(
      browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/extract.js'] }),
      EXTRACTION_TIMEOUT_MS,
    );
    const value: unknown = results[0]?.result;
    // The text must come from the document the source URL was taken from; a navigation in between would
    // attach another page's text to this source.
    if (isPageExtraction(value) && normalizeUrl(value.page_url) !== dedupUrl) return notSaved('page_changed');
    snapshot = isPageExtraction(value)
      ? await buildSnapshotDraft(value, new Date().toISOString())
      : failedSnapshotDraft('extraction_error', 'The extractor returned no result.', new Date().toISOString());
  } catch (error) {
    const now = new Date().toISOString();
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      snapshot = failedSnapshotDraft('timeout', `Extraction did not finish within ${EXTRACTION_TIMEOUT_MS / 1000} s.`, now);
    } else {
      const kind = classifyScriptError(error);
      if (kind === 'no_access' || kind === 'blocked_page' || kind === 'tab_gone') return notSaved(kind);
      snapshot =
        kind === 'page_unavailable'
          ? failedSnapshotDraft('page_unavailable', 'The browser showed an error page instead of the page.', now)
          : failedSnapshotDraft('extraction_error', error instanceof Error ? error.message : String(error), now);
    }
  }

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
    snapshot,
  });
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
  return save(db, {
    session_id: sessionId,
    kind: 'selection',
    dedup_url: frameSource ? normalizeUrl(target.url)! : pageUrl,
    captured_at: capturedAt,
    original_url: target.url,
    // The tab title belongs to the page, not to a frame saved as its own source.
    tab_title: frameSource ? '' : (tab.title ?? ''),
    found_on: target.found_on,
    anchor_text: null,
    fragment,
    frame: target.frame,
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
