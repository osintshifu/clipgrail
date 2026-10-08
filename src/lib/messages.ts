import type { SavedCapture } from './db';

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

/** The captures a stopped recording saved and the pages it could not save (none after a start), or why it failed. */
export interface RecordResponse {
  captures: SavedCapture[];
  failed: number;
  error?: string;
}

export function isRecordRequest(value: unknown): value is RecordRequest {
  const v = value as Partial<RecordRequest> | null;
  return !!v && v.type === 'record' && (v.action === 'start' || v.action === 'stop') && typeof v.windowId === 'number';
}
