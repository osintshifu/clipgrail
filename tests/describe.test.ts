import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, loadLibrary, loadSessionView } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { chooseSnapshot } from '../src/lib/selection';
import { buildSnapshotDraft } from '../src/lib/snapshot';
import { PAGE_CODE_NOTE, STATUS_LABELS, comparisonLine, fmtBytes, fmtTime, pageCodeCapture, pageCodeView, sourceMeta, statusSentence, textComparisons } from '../src/lib/describe';
import { timelineEvents } from '../src/lib/timeline';
import { extraction, failedDraft, freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

describe('source status texts', () => {
  it('name every status in plain words, from the saved snapshot and never from the page title', async () => {
    const db = await freshDb();
    const at = '2026-10-05T10:00:00.000Z';
    await commitCapture(db, await pageDraft('https://example.com/ok', 'Saved text', at));
    const partial = await pageDraft('https://example.com/partial', 'Cut text', at);
    partial.snapshot = await buildSnapshotDraft(extraction('Cut text', { truncated: true, original_character_count: 20 }), at);
    await commitCapture(db, partial);
    await commitCapture(db, linkDraft('https://example.com/link', at, 'https://example.com/ok'));
    await commitCapture(db, failedDraft('https://example.com/failed', at));
    await commitCapture(db, await selectionDraft('https://example.com/selected', 'Selected words', at));
    await commitCapture(db, {
      ...linkDraft('https://example.com/tab', at, 'https://example.com/ok'),
      kind: 'tab',
      tab_title: '404 Not Found',
      found_on: null,
      anchor_text: null,
    });

    const sources = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    expect(sources.map((s) => STATUS_LABELS[chooseSnapshot(s).status])).toEqual([
      'Text saved',
      'Partial text',
      'URL only',
      'Capture failed',
      'Selections only',
      'URL only',
    ]);
    expect(sources.map(sourceMeta)).toEqual(['10 chars', '8 of 20 chars', '', 'HTTP 404', '1 selection', '']);
    const sentences = sources.map(statusSentence);
    expect(sentences[1]).toMatch(/^Partial text: cut at capture to 8 of 20 characters\. Saved /);
    expect(sentences[2]).toBe('The link was saved without opening the page, so there is no text yet. Clip page saves its text.');
    expect(sentences[3]).toMatch(/failed: HTTP 404\. No text was saved; the address is kept\.$/);
    expect(sentences[4]).toBe('No page text. Only 1 selection was clipped from this page.');
    expect(sentences[5]).toMatch(/^The tab address was saved without reading the page/);
  });

  it('mark a selection cut at the length limit as partial, without changing the status of the source', async () => {
    const db = await freshDb();
    const at = '2026-10-05T10:00:00.000Z';
    const cut = async (url: string, when = at) => {
      const draft = await selectionDraft(url, 'Selected words', when);
      return { ...draft, fragment: { ...draft.fragment!, truncated: true, original_character_count: 1_000_005 } };
    };
    await commitCapture(db, await cut('https://example.com/cut', '2026-10-05T09:00:00.000Z'));
    await commitCapture(db, await pageDraft('https://example.com/full', 'Saved text', at));
    await commitCapture(db, await cut('https://example.com/full'));
    await commitCapture(db, await selectionDraft('https://example.com/full', 'More words', at));

    const sources = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    expect(sources.map(sourceMeta)).toEqual(['1 selection, partial', '10 chars · 3 captures · 2 selections, 1 partial']);
    expect(sources.map((s) => STATUS_LABELS[chooseSnapshot(s).status])).toEqual(['Selections only', 'Text saved']);
    expect(timelineEvents((await loadLibrary(db)).sources)[0]).toMatchObject({ verb: 'Selection saved', detail: 'partial, 14 of 1,000,005 characters' });
  });

  it('say when the latest attempt failed after the text in use', async () => {
    const db = await freshDb();
    await commitCapture(db, await pageDraft('https://example.com/recount', 'Saved text', '2026-10-05T10:00:00.000Z'));
    await commitCapture(db, failedDraft('https://example.com/recount', '2026-10-06T12:20:00.000Z'));
    const [entry] = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    expect(STATUS_LABELS[chooseSnapshot(entry!).status]).toBe('Text saved');
    expect(sourceMeta(entry!)).toBe('10 chars · 2 captures · latest attempt failed');
    expect(statusSentence(entry!)).toMatch(/^Readable text saved .* · capture 1 of 2\. Latest attempt (.+) failed: HTTP 404\.$/);
    expect(statusSentence(entry!)).toContain(`Latest attempt ${fmtTime('2026-10-06T12:20:00.000Z')} failed`);
  });
});

describe('sizes', () => {
  it('shows a size from 1 MB up in MB, as the backup sizes are shown', () => {
    expect([fmtBytes(999), fmtBytes(999_949), fmtBytes(999_950), fmtBytes(9_057_400)]).toEqual(['999 B', '999.9 kB', '1 MB', '9.1 MB']);
  });
});

describe('text comparisons', () => {
  it('mark a saved text as the same as the latest earlier capture with that SHA-256, else as different from the nearest earlier text', async () => {
    const db = await freshDb();
    const url = 'https://example.com/notice';
    const at = (minute: number) => `2026-10-09T10:${String(minute).padStart(2, '0')}:00.000Z`;
    await commitCapture(db, await pageDraft(url, 'Berths 4 to 7 are closed.', at(1)));
    await commitCapture(db, await pageDraft(url, 'Berths 4 to 7 are closed.', at(2)));
    await commitCapture(db, await selectionDraft(url, 'Berths 4 to 7', at(3)));
    await commitCapture(db, failedDraft(url, at(4)));
    await commitCapture(db, await pageDraft(url, 'Berths 4 to 8 are closed.', at(5)));
    await commitCapture(db, await pageDraft(url, 'Berths 4 to 7 are closed.', at(6)));

    const [entry] = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    const compared = textComparisons(entry!.captures);
    expect(entry!.captures.map((c) => { const comparison = compared.get(c.capture.id); return comparison ? comparisonLine(comparison) : null; })).toEqual([
      null,
      'Same text as capture\u00a01',
      null,
      null,
      'Text differs from capture\u00a02',
      'Same text as capture\u00a02',
    ]);
  });
});

describe('page code in details', () => {
  it('shows the values, trackers, contacts and addresses a capture read with where each came from, and what Readability read when the page code was not read', async () => {
    const db = await freshDb();
    const url = 'https://example.com/notice';
    await commitCapture(db, await pageDraft(url, 'Clipped before page code was read.', '2026-10-09T10:00:00.000Z'));
    const [before] = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    const old = pageCodeCapture(before!)!;
    expect(pageCodeView(old.capture, old.snapshot)).toEqual({
      declaredTitle: 'Read with the text by Readability',
      declared: [],
      trackers: null,
      values: null,
      valuesTitle: '',
      note: 'The page code was not read for this capture: it was made before ClipGrail read page code, or the page could not be read in time.',
    });

    await commitCapture(db, {
      ...(await pageDraft(url, 'Clipped with page code.', '2026-10-09T11:00:00.000Z')),
      page_code: {
        declared: [{ field: 'published', value: '2026-10-09T09:12:00+02:00', from: ['article:published_time', 'schema.org datePublished'] }],
        trackers: [{ kind: 'ga4', id: 'G-7QX2KF31PL', where: ['script_address', 'inline_script'] }],
        values: [{ kind: 'email', value: 'press@example.com', where: ['link', 'page_text'] }],
      },
    });
    await commitCapture(db, await selectionDraft(url, 'Clipped', '2026-10-09T12:00:00.000Z'));
    const [entry] = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    // The side panel shows the newest capture that read the page code, not a later selection made without it.
    const shown = pageCodeCapture(entry!)!;
    expect(shown.number).toBe(2);
    expect(pageCodeView(shown.capture, shown.snapshot)).toEqual({
      declaredTitle: 'Declared by the page',
      declared: [{ label: 'Published', value: '2026-10-09T09:12:00+02:00', from: 'article:published_time, schema.org datePublished', mono: false }],
      trackers: [{ label: 'Google Analytics 4', value: 'G-7QX2KF31PL', from: 'script address, inline script', mono: true }],
      values: [{ label: 'Email address', value: 'press@example.com', from: 'link, page text', mono: false }],
      valuesTitle: 'Contacts and addresses in the page',
      note: PAGE_CODE_NOTE,
    });
  });
});

