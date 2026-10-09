import { browser } from 'wxt/browser';
import { isFromOwnPage, isOffscreenCopy } from '../../lib/messages';

// Chrome gives the background no clipboard: this hidden page copies a job for Open in from the page menu.
// It cannot take the focus the Clipboard API needs, so it copies the way a selection is copied.
browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isFromOwnPage(sender, browser.runtime.id, browser.runtime.getURL('/')) || !isOffscreenCopy(message)) return false;
  const area = document.createElement('textarea');
  area.value = message.text;
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  sendResponse({ copied });
  return false;
});
