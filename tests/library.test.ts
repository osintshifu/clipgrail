import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, createSession, loadLibrary, updateSourceNote, visitSnapshotTexts } from '../src/lib/db';
import { compareChoices, filterRows, libraryRows, searchSnippet, textIdsOf, versionsOf } from '../src/lib/library';
import type { LibraryFilter, TextHits } from '../src/lib/library';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { parseSearch, storedRanges, textHit } from '../src/lib/search';
import { failedDraft, freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

const all: LibraryFilter = { view: 'all', query: '', status: 'any', important: false, sort: 'last-desc' };

async function library() {
  const db = await freshDb();
  const other = await createSession(db, 'Port strike');
  await commitCapture(db, await pageDraft('https://docs.example.org/recycling', 'v1', '2026-10-01T10:00:00.000Z'));
  await commitCapture(db, failedDraft('https://news.example.net/missing', '2026-10-02T10:00:00.000Z'));
  await commitCapture(db, await pageDraft('https://press.example.org/strike', 'strike text', '2026-10-03T10:00:00.000Z', other.id));
  await commitCapture(db, await pageDraft('https://docs.example.org/recycling', 'v2', '2026-10-04T10:00:00.000Z'));
  return { db, other, rows: libraryRows(await loadLibrary(db)) };
}

describe('library', () => {
  it('lists the sources of every session with their own session and label, and searches title, address and label', async () => {
    const { other, rows } = await library();
    expect(filterRows(rows, all).map((r) => `${r.session.name} ${r.label} ${r.status}`)).toEqual([
      'Inbox S1 ok',
      'Port strike S1 ok',
      'Inbox S2 failed',
    ]);
    expect(filterRows(rows, { ...all, query: 'DOCS.example recycling' }).map((r) => r.entry.source.dedup_url)).toEqual(['https://docs.example.org/recycling']);
    expect(filterRows(rows, { ...all, query: 'missing PAGE' }).map((r) => r.title)).toEqual(['Missing page']);
    expect(filterRows(rows, { ...all, view: other.id }).map((r) => r.label)).toEqual(['S1']);
    // A label finds that source in every session it exists in, but S1 does not find S10.
    expect(filterRows(rows, { ...all, query: 's2' }).map((r) => `${r.session.name} ${r.label}`)).toEqual(['Inbox S2']);
    expect(filterRows(rows, { ...all, query: 'S1' }).map((r) => `${r.session.name} ${r.label}`)).toEqual(['Inbox S1', 'Port strike S1']);
  });

  it('filters by status and sorts by last capture or by date added without changing labels', async () => {
    const { rows } = await library();
    expect(filterRows(rows, { ...all, status: 'failed' }).map((r) => r.label)).toEqual(['S2']);
    expect(filterRows(rows, { ...all, view: INBOX_SESSION_ID, sort: 'added-asc' }).map((r) => r.label)).toEqual(['S1', 'S2']);
    expect(filterRows(rows, { ...all, view: INBOX_SESSION_ID, sort: 'last-desc' }).map((r) => r.label)).toEqual(['S1', 'S2']);
    expect(filterRows(rows, { ...all, view: INBOX_SESSION_ID, sort: 'added-desc' }).map((r) => r.label)).toEqual(['S2', 'S1']);
  });

  it('searches notes, selections and saved texts of every version without regard to case or diacritics, finds phrases, and narrows by site and day', async () => {
    const db = await freshDb();
    await commitCapture(db, await pageDraft('https://port.example.org/berth', 'Old text about the cranes.', '2026-10-01T10:00:00.000Z'));
    await commitCapture(db, await pageDraft('https://port.example.org/berth', 'Night closures at berth 4. Źródło: the port authority.', '2026-10-03T10:00:00.000Z'));
    const union = await commitCapture(db, await selectionDraft('https://news.example.net/union', 'The union called a strike.', '2026-10-05T10:00:00.000Z'));
    await updateSourceNote(db, union.source.id, 'Check the strike dates.');
    // A page with an international address, and text stored with separate accents.
    await commitCapture(db, await pageDraft('https://xn--w-uga1v8h.pl/raport', 'Raport: źródła. İstanbul. ΑΣΤΡΟ.'.normalize('NFD'), '2026-10-06T10:00:00.000Z'));
    const rows = libraryRows(await loadLibrary(db));
    // The library reads the saved texts for the search words, then filters with what it found.
    const search = async (input: string) => {
      const query = parseSearch(input);
      const hits: TextHits = new Map();
      await visitSnapshotTexts(db, rows.flatMap((r) => textIdsOf(r.entry)), (id, text) => {
        const hit = textHit(text, query.terms);
        if (hit) hits.set(id, hit);
        return true;
      });
      return filterRows(rows, { ...all, query: input }, hits).map((row) => {
        const found = searchSnippet(row, query, hits);
        const marked = found?.snippet.marks.map(([a, b]) => found.snippet.text.slice(a, b)).join(',');
        return `${row.host} ${found ? `${found.where}: ${marked}` : '-'}`;
      });
    };
    expect(await search('zrodlo')).toEqual(['port.example.org Saved text: Źródło']);
    expect(await search('CRANES')).toEqual(['port.example.org Earlier text · capture 1: cranes']);
    expect(await search('strike')).toEqual(['news.example.net Note: strike']);
    expect(await search('"called a strike"')).toEqual(['news.example.net Selection: called a strike']);
    expect(await search('"strike called"')).toEqual([]);
    // Every word must be in the same source; the title and address count without a passage.
    expect(await search('berth strike')).toEqual([]);
    expect(await search('berth night')).toEqual(['port.example.org Saved text: Night,berth']);
    expect(await search('site:example.org')).toEqual(['port.example.org -']);
    expect(await search('site:https://news.example.net/union union')).toEqual(['news.example.net -']);
    expect(await search('after:2026-10-04 before:2026-10-05')).toEqual(['news.example.net -']);
    expect(await search('before:2026-10-02')).toEqual(['port.example.org -']);
    // The passage and the capture to open follow the word the list does not show: "port" is in the address and the current text, "cranes" only in capture 1.
    expect(await search('port cranes')).toEqual(['port.example.org Earlier text · capture 1: cranes']);
    expect(await search('zrodla istanbul')).toEqual(['xn--w-uga1v8h.pl Saved text: źródła,İstanbul']);
    expect(await search('ΑΣ')).toEqual(['xn--w-uga1v8h.pl Saved text: ΑΣ']);
    expect(await search('site:żółw.pl')).toEqual(['xn--w-uga1v8h.pl -']);
    // The reader marks the words in the text as stored, accents written separately included.
    const stored = 'Raport: źródła.'.normalize('NFD');
    expect(storedRanges(stored, parseSearch('zrodla').terms).map(([a, b]) => stored.slice(a, b).normalize('NFC'))).toEqual(['źródła']);
    // A qualifier without a usable value is an ordinary word, so it narrows rather than widens.
    expect(await search('after:yesterday')).toEqual([]);
  });

  it('lists versions newest first and marks the one Research Jobs use, also when a later capture has no text', async () => {
    const db = await freshDb();
    await commitCapture(db, await pageDraft('https://example.com/a', 'first', '2026-10-01T10:00:00.000Z'));
    await commitCapture(db, await pageDraft('https://example.com/a', 'second', '2026-10-02T10:00:00.000Z'));
    await commitCapture(db, linkDraft('https://example.com/a', '2026-10-03T10:00:00.000Z', 'https://example.com/list'));
    const [entry] = (await loadLibrary(db)).sources;
    expect(versionsOf(entry!).map((v) => [v.number, v.capture.capture.kind, v.current])).toEqual([
      [3, 'link', false],
      [2, 'page', true],
      [1, 'page', false],
    ]);
  });

  it('offers the other captures with text to compare with, marking one that repeats the viewed text or a newer choice', async () => {
    const db = await freshDb();
    const url = 'https://example.com/notice';
    for (const [text, day] of [['A', 1], ['B', 2], ['A', 3], ['C', 4]] as const) await commitCapture(db, await pageDraft(url, text, `2026-10-0${day}T10:00:00.000Z`));
    await commitCapture(db, await selectionDraft(url, 'A', '2026-10-05T10:00:00.000Z'));
    const versions = versionsOf((await loadLibrary(db)).sources[0]!);
    const choices = (viewed: number) => compareChoices(versions.find((v) => v.number === viewed)!, versions).map((c) => [c.version.number, c.sameAs]);
    // Newest first, selections left out; capture 1 repeats the text of capture 3.
    expect(choices(4)).toEqual([[3, null], [2, null], [1, 3]]);
    expect(choices(3)).toEqual([[4, null], [2, null], [1, 3]]);
  });
});

