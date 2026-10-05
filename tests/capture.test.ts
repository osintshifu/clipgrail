import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { capturePage, captureSelection } from '../src/lib/capture';
import { loadSessionView } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { extraction, freshDb } from './helpers';

afterEach(() => vi.restoreAllMocks());

function scriptReturns(result: unknown) {
  vi.spyOn(browser.scripting, 'executeScript').mockResolvedValue([{ frameId: 0, result }] as never);
}

describe('capture of a page that changes during the capture', () => {
  it('saves nothing when the document read is not the page of the source', async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://example.com/a', title: 'Page A' };

    scriptReturns(extraction('Page B text', { page_url: 'https://example.com/b' }));
    expect(await capturePage(db, tab, INBOX_SESSION_ID)).toMatchObject({ saved: false, reason: 'page_changed' });
    // A new fragment can show other content (another chat, another sheet), so it counts as another page.
    scriptReturns(extraction('Other channel text', { page_url: 'https://example.com/a#@other' }));
    expect(await capturePage(db, tab, INBOX_SESSION_ID)).toMatchObject({ saved: false, reason: 'page_changed' });

    scriptReturns({ text: 'Selected on page B', url: 'https://example.com/b' });
    expect(await captureSelection(db, tab, INBOX_SESSION_ID)).toMatchObject({ saved: false, reason: 'page_changed' });
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources).toHaveLength(0);

    // The same page with tracking parameters is still the same document.
    scriptReturns(extraction('Page A text', { page_url: 'https://example.com/a?utm_source=x' }));
    expect(await capturePage(db, tab, INBOX_SESSION_ID)).toMatchObject({ saved: true });
  });
});
