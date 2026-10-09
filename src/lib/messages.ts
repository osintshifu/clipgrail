import type { SavedCapture } from './db';

/**
 * True for a message from one of ClipGrail's own pages (side panel, popup,
 * library). A script ClipGrail injects into a web page reports that page's
 * address, so a compromised page cannot send requests in its name.
 */
export function isFromOwnPage(sender: { id?: string; url?: string }, extensionId: string, extensionUrl: string): boolean {
  if (sender.id !== extensionId || sender.url === undefined) return false;
  try {
    return new URL(sender.url).origin === new URL(extensionUrl).origin;
  } catch {
    return false;
  }
}

/** Messages from the side panel to the background service worker. */
export interface ClipRequest {
  type: 'clip';
  what: 'page' | 'selection';
  windowId: number;
  sessionId: string;
}

export interface ClipResponse {
  saved: boolean;
  message: string;
}

export function isClipRequest(value: unknown): value is ClipRequest {
  const v = value as Partial<ClipRequest> | null;
  return (
    !!v &&
    v.type === 'clip' &&
    (v.what === 'page' || v.what === 'selection') &&
    typeof v.windowId === 'number' &&
    typeof v.sessionId === 'string'
  );
}

/**
 * Clips sources saved as a URL only, once Chrome allows their sites: each page opens in a background tab of the
 * window and its text goes to its source. Sent before Chrome asks, because the toolbar popup that asks closes when
 * Chrome shows its prompt; the result comes as a notice. After a recording, the pages left unchecked are removed first.
 */
export interface ClipSourcesRequest {
  type: 'clip-sources';
  sourceIds: string[];
  windowId: number;
  /** The site patterns Chrome is asked for. */
  origins: string[];
  remove?: SavedCapture[];
}

/** Withdraws the clip request of a window whose sites Chrome was not allowed to read. */
export interface ClipCancelRequest {
  type: 'clip-sources-cancel';
  windowId: number;
}

const isSavedCapture = (v: unknown) => !!v && typeof (v as SavedCapture).capture_id === 'string' && typeof (v as SavedCapture).session_id === 'string';

export function isClipSourcesRequest(value: unknown): value is ClipSourcesRequest {
  const v = value as Partial<ClipSourcesRequest> | null;
  return (
    !!v &&
    v.type === 'clip-sources' &&
    Array.isArray(v.sourceIds) &&
    v.sourceIds.length > 0 &&
    v.sourceIds.length <= 1000 &&
    v.sourceIds.every((id) => typeof id === 'string') &&
    typeof v.windowId === 'number' &&
    Array.isArray(v.origins) &&
    v.origins.length > 0 &&
    v.origins.every((o) => typeof o === 'string' && /^\*:\/\/[^/]+\/\*$/.test(o)) &&
    (v.remove === undefined || (Array.isArray(v.remove) && v.remove.every(isSavedCapture)))
  );
}

export function isClipCancelRequest(value: unknown): value is ClipCancelRequest {
  const v = value as Partial<ClipCancelRequest> | null;
  return !!v && v.type === 'clip-sources-cancel' && typeof v.windowId === 'number';
}

/** From the background to its hidden clipboard page: copy this text. */
export interface OffscreenCopy {
  type: 'offscreen-copy';
  text: string;
}

export function isOffscreenCopy(value: unknown): value is OffscreenCopy {
  const v = value as Partial<OffscreenCopy> | null;
  return !!v && v.type === 'offscreen-copy' && typeof v.text === 'string';
}

/** Starts or stops recording the pages opened in a window. */
export interface RecordRequest {
  type: 'record';
  action: 'start' | 'stop';
  windowId: number;
}

/** The pages a stopped recording saved, its visits to pages the session already had and the pages it could not save (none after a start), or why it failed. */
export interface RecordResponse {
  captures: SavedCapture[];
  visits?: SavedCapture[];
  failed: number;
  /** After a start that took the recording over from another window: how many pages it had saved there. */
  moved?: { saved: number };
  error?: string;
}

export function isRecordRequest(value: unknown): value is RecordRequest {
  const v = value as Partial<RecordRequest> | null;
  return !!v && v.type === 'record' && (v.action === 'start' || v.action === 'stop') && typeof v.windowId === 'number';
}
