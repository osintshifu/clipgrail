import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, loadSessionView } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { chooseSnapshot } from '../src/lib/selection';
import { buildSnapshotDraft } from '../src/lib/snapshot';
import { STATUS_LABELS, comparisonLine, fmtTime, sourceMeta, statusSentence, textComparisons } from '../src/lib/describe';
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
      'Address only',
      'Capture failed',
      'Selections only',
      'Address only',
    ]);
    expect(sources.map(sourceMeta)).toEqual(['10 chars', '8 of 20 chars', '', 'HTTP 404', '1 selection', '']);
    const sentences = sources.map(statusSentence);
    expect(sentences[1]).toMatch(/^Partial text: cut at capture to 8 of 20 characters\. Saved /);
    expect(sentences[2]).toBe('The link was saved without opening the page, so there is no text yet. Open the page and clip it to save its text.');
    expect(sentences[3]).toMatch(/failed: HTTP 404\. No text was saved; the address is kept\.$/);
    expect(sentences[4]).toBe('No page text. Only 1 selection was clipped from this page.');
    expect(sentences[5]).toMatch(/^The tab address was saved without reading the page/);
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
