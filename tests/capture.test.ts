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

describe('selection in an embedded frame', () => {
  it("saves it under the frame's own web address found on the page, or keeps the page as context and says the source URL is not established", async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://news.example.com/story', title: 'Story' };

    scriptReturns({ text: 'Quoted post', url: 'https://embed.example.org/post/1' });
    const framed = await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 3 });
    expect(framed.saved && framed.result.source.dedup_url).toBe('https://embed.example.org/post/1');
    expect(framed.saved && framed.result.capture).toMatchObject({ found_on: tab.url, frame: { url: 'https://embed.example.org/post/1' }, tab_title: '' });
    expect(framed.message).toContain('from an embedded frame (embed.example.org)');

    scriptReturns({ text: 'Inline widget text', url: 'about:srcdoc' });
    const inline = await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 4 });
    expect(inline.saved && inline.result.source.dedup_url).toBe(tab.url);
    expect(inline.saved && inline.result.capture).toMatchObject({ found_on: null, frame: { url: 'about:srcdoc' } });
    expect(inline.message).toContain('from an embedded frame, source URL not established');

    // A frame ClipGrail may not read: Chrome's copy of the selection, with the frame address from the context menu.
    vi.spyOn(browser.scripting, 'executeScript').mockRejectedValue(new Error('Cannot access contents of url "https://ads.example.net/"'));
    const unread = await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 5, frameUrl: 'https://ads.example.net/slot', menuSelectionText: 'Sponsored' });
    expect(unread.saved && unread.result.capture).toMatchObject({ found_on: tab.url, frame: { url: 'https://ads.example.net/slot' } });

    // The page itself has no frame.
    scriptReturns({ text: 'Body text', url: tab.url });
    const top = await captureSelection(db, tab, INBOX_SESSION_ID);
    expect(top.saved && top.result.capture).toMatchObject({ found_on: null, frame: null, tab_title: 'Story' });
  });
});
