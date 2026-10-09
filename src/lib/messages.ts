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
