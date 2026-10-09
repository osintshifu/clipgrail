import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, loadLibrary } from '../src/lib/db';
import { fmtTime, navigationWords } from '../src/lib/describe';
import { ledTo, timelineEvents } from '../src/lib/timeline';
import { freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

const RESULTS = 'https://news.example.org/search?q=strike';
const ARTICLE = 'https://news.example.org/closures';
const nav = (transition: string, qualifiers: string[] = [], in_page = false) => ({ transition, qualifiers, in_page });

describe('timeline', () => {
  it('lists every capture and visit in time order, says how recorded pages were reached, which pages a page led to and which clip saved the same text', async () => {
    const db = await freshDb();
    const recorded = (url: string, at: string, found_on: string | null, navigation: ReturnType<typeof nav>, kind: 'tab' | 'visit' = 'tab') =>
      commitCapture(db, { ...linkDraft(url, at, ''), kind, found_on, anchor_text: null, navigation, snapshot: kind === 'tab' ? { status: 'pending' } : null });
    await recorded(RESULTS, '2026-10-09T12:02:00.000Z', null, nav('typed', ['from_address_bar']));
    await recorded(ARTICLE, '2026-10-09T12:03:00.000Z', RESULTS, nav('link'));
    await commitCapture(db, await pageDraft(ARTICLE, 'Berths close at night.', '2026-10-09T12:05:00.000Z'));
    await commitCapture(db, await selectionDraft(ARTICLE, 'Berths close', '2026-10-09T12:06:00.000Z'));
    await commitCapture(db, linkDraft('https://port.example.org/notice', '2026-10-09T12:07:00.000Z', ARTICLE));
    await commitCapture(db, await pageDraft(ARTICLE, 'Berths close at night.', '2026-10-09T12:20:00.000Z'));
    await recorded(RESULTS, '2026-10-09T12:41:00.000Z', null, nav('typed', ['from_address_bar']), 'visit');

    const { sources } = await loadLibrary(db);
    expect(timelineEvents(sources).map((e) => [e.verb, e.detail])).toEqual([
      ['Opened', 'Typed address'],
      ['Opened', 'Link from S1'],
      ['Clipped', '22 characters'],
      ['Selection saved', '12 characters'],
      ['Link saved, not opened', 'found on S2'],
      // The timeline shows no capture numbers, so the earlier clip is named by its time.
      ['Clipped', `22 characters · Same text as the clip at ${fmtTime('2026-10-09T12:05:00.000Z').slice(11)}`],
      ['Visited again', 'Typed address'],
    ]);
    const [results, article, notice] = sources;
    expect(ledTo(results!, sources)).toEqual([article]);
    expect(ledTo(article!, sources)).toEqual([notice]);
    expect(ledTo(notice!, sources)).toEqual([]);

    // Words for the other ways Chrome reports; nothing for a capture that was not recorded.
    expect(
      [
        nav('link', ['forward_back']),
        nav('link', [], true),
        nav('reload'),
        nav('link', ['client_redirect']),
        nav('link', ['server_redirect']),
        nav('link', ['from_address_bar']),
        nav('auto_bookmark'),
        nav('future_type'),
      ].map(navigationWords),
    ).toEqual([
      'Back or Forward',
      'Address changed by the page',
      'Reload or reopened tab',
      'Redirect by the page',
      'Link, redirected by the server',
      'Typed address',
      'Bookmark or browser menu',
      'Other (Chrome: future_type)',
    ]);
    expect(navigationWords(null)).toBeNull();
  });
});
