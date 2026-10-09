import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, loadSessionView } from '../src/lib/db';
import { captureExtra } from '../src/lib/describe';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { foundOnFor, recordVisit } from '../src/lib/recording';
import { DEFAULT_JOB_SETTINGS, buildResearchJob } from '../src/lib/research-job';
import { freshDb, linkDraft } from './helpers';

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

  it('skips addresses that carry a sign-in or access credential and never names them as where a page was found', async () => {
    const db = await freshDb();
    const at = '2026-10-07T09:00:00.000Z';
    const secret = [
      'https://accounts.example.com/reset?token=8f2c1e',
      'https://app.example.com/callback#access_token=ya29.a0&token_type=Bearer',
      'https://gitlab.example.com/users/password/edit?reset_password_token=Zx8kQ',
      'https://blog.example.org/wp-login.php?action=rp&key=AbCd&login=jdoe',
      'https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Credential=AKIA&X-Amz-Signature=9f0e',
      'https://storage.googleapis.com/files/report.pdf?GoogleAccessId=svc&Expires=1&Signature=c2ln',
      'https://api.example.com/export?accessToken=ya29',
      'https://zoom.us/j/123456789?pwd=abc',
    ];
    for (const url of secret) {
      expect(await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at }), url).toBeNull();
      expect(foundOnFor({ transition: 'link', qualifiers: [] }, { url, found_on: null }, null), url).toBeNull();
    }
    // A code, a state or a key alone is an ordinary parameter.
    for (const url of ['https://registry.example.org/search?code=PL-14&key=company', 'https://registry.example.gov/lookup?code=541511&state=CA']) {
      expect(await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at }), url).not.toBeNull();
    }
  });

  it('skips pages on excluded sites and their subdomains and never names them as where a page was found', async () => {
    const db = await freshDb();
    const at = '2026-10-07T09:00:00.000Z';
    const excluded = ['google.com', 'online.mybank.example'];
    expect(await recordVisit(db, INBOX_SESSION_ID, { url: 'https://mail.google.com/mail/u/0', title: '', found_on: null, at }, excluded)).toBeNull();
    expect(await recordVisit(db, INBOX_SESSION_ID, { url: 'https://online.mybank.example/accounts', title: '', found_on: null, at }, excluded)).toBeNull();
    expect(await recordVisit(db, INBOX_SESSION_ID, { url: 'https://mail.google.com./mail/u/0', title: '', found_on: null, at }, excluded)).toBeNull();
    // A site that only ends with the same letters is recorded; the excluded page it was opened from is not kept.
    const saved = await recordVisit(db, INBOX_SESSION_ID, { url: 'https://notgoogle.com/news', title: '', found_on: 'https://mail.google.com/mail/u/0', at }, excluded);
    expect(saved?.capture.found_on).toBeNull();
  });

  it('saves a visited page as an address with where it was found, shows and exports that, once per session', async () => {
    const db = await freshDb();
    const visit = { url: 'https://port.example.org/closures', title: 'Night closures', found_on: RESULTS, at: '2026-10-07T09:00:00.000Z' };
    const saved = await recordVisit(db, INBOX_SESSION_ID, visit);
    expect(saved?.capture).toMatchObject({ kind: 'tab', found_on: RESULTS, tab_title: 'Night closures' });
    expect(saved?.snapshot?.status).toBe('pending');
    expect(await recordVisit(db, INBOX_SESSION_ID, { ...visit, at: '2026-10-07T09:05:00.000Z' })).toBeNull();
    expect(await recordVisit(db, INBOX_SESSION_ID, { ...visit, url: 'chrome://settings/' })).toBeNull();
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources).toHaveLength(1);
    expect(captureExtra(saved!.capture, saved!.source.dedup_url)).toBe(`Found on ${RESULTS}`);
    const settings = { ...DEFAULT_JOB_SETTINGS, include_link_context: true };
    expect(buildResearchJob({ view, settings, id: 'job', createdAt: visit.at }).text).toContain(`- Found on <${RESULTS}>`);
  });

  it('notes a return to a page only for a new page load at least 30 minutes after it was last saved, and opens a saved link as a page', async () => {
    const db = await freshDb();
    const url = 'https://port.example.org/closures';
    const nav = (transition: string, qualifiers: string[] = [], in_page = false) => ({ transition, qualifiers, in_page });
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 9, minutes)).toISOString();
    const first = await recordVisit(db, INBOX_SESSION_ID, { url, title: 'Night closures', found_on: null, at: at(0), navigation: nav('typed') });
    expect(first?.capture).toMatchObject({ kind: 'tab', navigation: nav('typed') });
    // Too soon, a reload (Chrome reports one the page makes itself as a redirect to the same address), Back or Forward
    // and an address the page changed itself are not returns.
    expect(await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at: at(20), navigation: nav('link') })).toBeNull();
    const notReturns = [
      { navigation: nav('reload') },
      { navigation: nav('link', ['client_redirect']), same_page: true },
      { navigation: nav('link', ['forward_back']) },
      { navigation: nav('link', [], true) },
      { navigation: null },
    ];
    for (const how of notReturns) {
      expect(await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at: at(40), ...how }), JSON.stringify(how)).toBeNull();
    }
    const again = await recordVisit(db, INBOX_SESSION_ID, { url, title: 'Night closures', found_on: RESULTS, at: at(40), navigation: nav('link') });
    expect(again?.capture).toMatchObject({ kind: 'visit', snapshot_id: null, found_on: RESULTS, navigation: nav('link') });
    // The next return counts from that visit.
    expect(await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at: at(60), navigation: nav('typed') })).toBeNull();
    const entry = (await loadSessionView(db, INBOX_SESSION_ID)).sources[0]!;
    expect([entry.captures.length, entry.visits.length]).toEqual([1, 1]);

    // A link saved without opening it is opened for the first time: an address, not a return.
    const saved = 'https://port.example.org/notice';
    await commitCapture(db, linkDraft(saved, at(1), url));
    expect((await recordVisit(db, INBOX_SESSION_ID, { url: saved, title: 'Notice', found_on: url, at: at(2), navigation: nav('link') }))?.capture.kind).toBe('tab');
  });
});
