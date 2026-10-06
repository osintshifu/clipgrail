import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadSessionView } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { foundOnFor, recordVisit } from '../src/lib/recording';
import { freshDb } from './helpers';

const RESULTS = 'https://news.example.org/search?q=strike';
const previous = { url: RESULTS, found_on: null };

describe('recording', () => {
  it('names the page a link or form led from, and nothing for typed addresses, bookmarks, reloads or Back', () => {
    expect(foundOnFor({ transition: 'link', qualifiers: [] }, previous, null)).toBe(RESULTS);
    expect(foundOnFor({ transition: 'form_submit', qualifiers: [] }, previous, null)).toBe(RESULTS);
    // A new tab opened from a page: that page.
    expect(foundOnFor({ transition: 'link', qualifiers: [] }, undefined, RESULTS)).toBe(RESULTS);
    for (const transition of ['typed', 'auto_bookmark', 'reload', 'generated']) {
      expect(foundOnFor({ transition, qualifiers: ['from_address_bar'] }, previous, null), transition).toBeNull();
    }
    expect(foundOnFor({ transition: 'link', qualifiers: ['forward_back'] }, previous, null)).toBeNull();
    // A redirect by the page keeps where the redirected navigation came from.
    expect(foundOnFor({ transition: 'link', qualifiers: ['client_redirect'] }, { url: 'https://t.example/r', found_on: RESULTS }, null)).toBe(RESULTS);
    // Only web pages are provenance.
    expect(foundOnFor({ transition: 'link', qualifiers: [] }, { url: 'chrome://newtab/', found_on: null }, null)).toBeNull();
  });

  it('saves a visited page as an address with where it was found, once per session', async () => {
    const db = await freshDb();
    const visit = { url: 'https://port.example.org/closures', title: 'Night closures', found_on: RESULTS, at: '2026-10-07T09:00:00.000Z' };
    const saved = await recordVisit(db, INBOX_SESSION_ID, visit);
    expect(saved?.capture).toMatchObject({ kind: 'tab', found_on: RESULTS, tab_title: 'Night closures' });
    expect(saved?.snapshot?.status).toBe('pending');
    expect(await recordVisit(db, INBOX_SESSION_ID, { ...visit, at: '2026-10-07T09:05:00.000Z' })).toBeNull();
    expect(await recordVisit(db, INBOX_SESSION_ID, { ...visit, url: 'chrome://settings/' })).toBeNull();
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources).toHaveLength(1);
  });
});
