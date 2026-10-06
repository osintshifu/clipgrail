import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, createSession, loadLibrary } from '../src/lib/db';
import { filterRows, libraryRows, versionsOf } from '../src/lib/library';
import type { LibraryFilter } from '../src/lib/library';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { failedDraft, freshDb, linkDraft, pageDraft } from './helpers';

const all: LibraryFilter = { view: 'all', query: '', status: 'any', sort: 'last-desc' };

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
});
