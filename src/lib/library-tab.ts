import { browser } from 'wxt/browser';

/**
 * Opens the library on a session or source, in the library tab that is
 * already open if there is one (runtime.getContexts needs no permission).
 */
export async function openLibrary(params: Record<string, string>, windowId: number | undefined): Promise<void> {
  const base = browser.runtime.getURL('/library.html');
  const url = `${base}#${new URLSearchParams(params).toString()}`;
  try {
    const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB'] });
    const open = contexts.find((c) => c.documentUrl?.startsWith(base) && c.tabId >= 0);
    if (open) {
      await browser.tabs.update(open.tabId, { url, active: true });
      await browser.windows.update(open.windowId, { focused: true });
      return;
    }
  } catch {
    // Open a new library tab instead.
  }
  await browser.tabs.create({ url, windowId });
}
