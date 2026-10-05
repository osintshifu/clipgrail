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
