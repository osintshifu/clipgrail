import { browser } from 'wxt/browser';

/**
 * The latest capture result, shared through chrome.storage.session so the
 * side panel shows it (with Undo) whether the capture came from the panel,
 * the context menu or the keyboard shortcut. Session storage is in memory only.
 */
export interface Notice {
  id: string;
  at: number;
  window_id: number | null;
  level: 'info' | 'error';
  text: string;
  /** Capture that Undo would remove. */
  capture_id: string | null;
}

export const NOTICE_KEY = 'notice';

export async function publishNotice(notice: Omit<Notice, 'id' | 'at'>): Promise<void> {
  await browser.storage.session.set({ [NOTICE_KEY]: { ...notice, id: crypto.randomUUID(), at: Date.now() } });
}
