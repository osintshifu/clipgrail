import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { captureLink, capturePage, captureSelection } from '../src/lib/capture';
import { loadSessionView, readAllData } from '../src/lib/db';
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

  it('saves nothing when the page went away while it was read', async () => {
    const db = await freshDb();
    vi.spyOn(browser.scripting, 'executeScript').mockRejectedValue(new Error('Frame with ID 0 was removed.'));
    expect(await capturePage(db, { id: 7, url: 'https://example.com/a', title: 'Page A' }, INBOX_SESSION_ID)).toMatchObject({ saved: false, reason: 'tab_gone' });
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources).toHaveLength(0);
  });
});

describe('addresses with a user name and password', () => {
  it('never stores a user name or password written into an address', async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://alice:s3cret@intranet.example.com/wiki', title: 'Wiki' };
    const code = { declared: [{ field: 'canonical', value: 'https://alice:s3cret@intranet.example.com/wiki/main', from: ['link rel=canonical'] }], trackers: [] };

    scriptReturns({ ...extraction('Wiki text', { page_url: tab.url, canonical_url: 'https://alice:s3cret@intranet.example.com/wiki/main' }), page_code: code });
    const page = await capturePage(db, tab, INBOX_SESSION_ID);
    expect(page.saved && page.result.capture.original_url).toBe('https://intranet.example.com/wiki');
    vi.spyOn(browser.scripting, 'executeScript').mockRejectedValue(new Error('Cannot access contents of url'));
    expect(await captureLink(db, tab, INBOX_SESSION_ID, { url: 'https://bob:t0ken@files.example.org/report.pdf', pageUrl: tab.url })).toMatchObject({ saved: true });
    vi.restoreAllMocks();
    scriptReturns({ text: 'Quoted post', url: 'https://carol:pw9@embed.example.org/post' });
    expect(await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 3 })).toMatchObject({ saved: true });

    expect(JSON.stringify(await readAllData(db))).not.toMatch(/s3cret|t0ken|pw9|alice|bob|carol/);
  });
});

describe('saving a link without opening it', () => {
  it('says Address only for a new source and which capture it is for a source the session has', async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://news.example.com/a', title: 'News' };
    scriptReturns('Report');
    const link = await captureLink(db, tab, INBOX_SESSION_ID, { url: 'https://other.example.org/report', pageUrl: tab.url });
    expect(link.message).toBe('Saved S1 as a link, not opened · Address only');

    scriptReturns(extraction('News text', { page_url: tab.url }));
    await capturePage(db, tab, INBOX_SESSION_ID);
    scriptReturns('News');
    const again = await captureLink(db, tab, INBOX_SESSION_ID, { url: tab.url, pageUrl: 'https://news.example.com/' });
    expect(again.message).toBe('Saved S2 as a link, not opened · capture 2 of this source');
  });
});

describe('selection on an error page the browser shows', () => {
  it("saves nothing, also not Chrome's copy of its own message, and says why", async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://nonexistent.example.invalid/', title: 'nonexistent.example.invalid' };
    vi.spyOn(browser.scripting, 'executeScript').mockRejectedValue(new Error('Frame with ID 0 is showing error page'));
    const fromPanel = await captureSelection(db, tab, INBOX_SESSION_ID);
    expect(fromPanel).toMatchObject({ saved: false, reason: 'error_page' });
    expect(fromPanel.message).toContain("browser's error page");
    expect(await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 0, menuSelectionText: "This site can't be reached" })).toMatchObject({ saved: false, reason: 'error_page' });
    expect(await captureSelection(db, tab, INBOX_SESSION_ID, { frameId: 4, menuSelectionText: 'refused to connect' })).toMatchObject({ saved: false, reason: 'frame_error_page' });
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources).toHaveLength(0);
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

describe('page code of a capture', () => {
  it('keeps the page code read with a clipped page or selection, only when it is valid and from the page saved', async () => {
    const db = await freshDb();
    const tab = { id: 7, url: 'https://example.com/a', title: 'Page A' };
    const code = {
      declared: [{ field: 'site_name', value: 'Example', from: ['og:site_name'] }],
      trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: ['inline_script'] }],
    };
    scriptReturns({ ...extraction('Page A text', { page_url: tab.url }), page_code: { ...code, extra: 'dropped' } });
    const page = await capturePage(db, tab, INBOX_SESSION_ID);
    expect(page.saved && page.result.capture.page_code).toEqual(code);

    // A selection reads the page code with a script of its own, in the document it is saved from.
    const selectionReads = (pageCode: unknown) =>
      vi.spyOn(browser.scripting, 'executeScript').mockImplementation(async (injection) =>
        [{ frameId: 0, result: 'files' in injection ? pageCode : { text: 'Selected words', url: tab.url } }] as never,
      );
    selectionReads({ ...code, page_url: tab.url });
    const selection = await captureSelection(db, tab, INBOX_SESSION_ID);
    expect(selection.saved && selection.result.capture.page_code).toEqual(code);
    // Page code of a page that is no longer the one saved, or not valid, is left out; the selection is still saved.
    selectionReads({ ...code, page_url: 'https://example.com/b' });
    const moved = await captureSelection(db, tab, INBOX_SESSION_ID);
    expect(moved.saved && moved.result.capture.page_code).toBeNull();
    scriptReturns({ ...extraction('Page A text', { page_url: tab.url }), page_code: { ...code, trackers: [{ kind: 'gtm', id: 'not an ID', where: ['inline_script'] }] } });
    const invalid = await capturePage(db, tab, INBOX_SESSION_ID);
    expect(invalid.saved && invalid.result.capture.page_code).toBeNull();
  });
});

