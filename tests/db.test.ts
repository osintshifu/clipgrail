/// <reference types="node" />
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  commitCapture,
  createSession,
  listSessions,
  loadSessionView,
  openDb,
  renameSession,
  undoCapture,
  updateCaptureNote,
  updateSessionText,
} from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import type { OkSnapshot } from '../src/lib/model';
import { chooseSnapshot } from '../src/lib/selection';
import { failedDraft, freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

describe('sessions', () => {
  it('creates the Inbox automatically and supports creating and renaming sessions', async () => {
    const db = await freshDb();
    expect((await listSessions(db)).map((s) => s.name)).toEqual(['Inbox']);
    const session = await createSession(db, '  Election   claims ');
    expect(session.name).toBe('Election claims');
    await renameSession(db, session.id, 'Turnout check');
    await updateSessionText(db, session.id, { prompt: 'Check the figures.', notes: 'Private note' });
    const sessions = await listSessions(db);
    expect(sessions.map((s) => s.name)).toEqual(['Inbox', 'Turnout check']);
    expect(sessions[1]).toMatchObject({ prompt: 'Check the figures.', notes: 'Private note' });
    await expect(renameSession(db, INBOX_SESSION_ID, 'Other')).rejects.toThrow('cannot be renamed');
  });
});

describe('commitCapture', () => {
  it('keeps the source and its S-ID on a repeated capture and preserves the earlier snapshot', async () => {
    const db = await freshDb();
    const first = await commitCapture(db, await pageDraft(URL_A, 'Version one', '2026-10-05T10:00:00.000Z'));
    const second = await commitCapture(db, await pageDraft(URL_A, 'Version two', '2026-10-05T11:00:00.000Z'));
    expect(first.isNewSource).toBe(true);
    expect(second.isNewSource).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(second.source.number).toBe(1);
    expect(second.captureCount).toBe(2);

    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources).toHaveLength(1);
    const snapshots = view.sources[0]!.captures.map((c) => c.snapshot as OkSnapshot);
    expect(snapshots.map((s) => s.text)).toEqual(['Version one', 'Version two']);
    for (const s of snapshots) {
      expect(s.sha256).toBe(createHash('sha256').update(s.text, 'utf8').digest('hex'));
    }
  });

  it('keeps the last successful snapshot when a later capture fails', async () => {
    const db = await freshDb();
    await commitCapture(db, await pageDraft(URL_A, 'Good text', '2026-10-05T10:00:00.000Z'));
    await commitCapture(db, failedDraft(URL_A, '2026-10-05T11:00:00.000Z'));
    const [source] = (await loadSessionView(db, INBOX_SESSION_ID)).sources;
    const choice = chooseSnapshot(source!);
    expect(choice).toMatchObject({ status: 'ok', position: 1, total: 2 });
    expect((choice.entry?.snapshot as OkSnapshot).text).toBe('Good text');
  });

  it('assigns unique S-numbers to concurrent captures', async () => {
    const db = await freshDb();
    const urls = [URL_A, URL_B, URL_A, 'https://example.com/c', URL_B];
    const drafts = await Promise.all(urls.map((u, i) => pageDraft(u, `text ${i}`, `2026-10-05T10:00:0${i}.000Z`)));
    await Promise.all(drafts.map((d) => commitCapture(db, d)));
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => s.source.number)).toEqual([1, 2, 3]);
    expect(view.sources.map((s) => s.captures.length).reduce((a, b) => a + b)).toBe(5);
    expect(view.session.next_source_number).toBe(4);
  });

  it('writes nothing when the transaction fails', async () => {
    const db = await freshDb();
    const draft = await pageDraft(URL_A, 'text', '2026-10-05T10:00:00.000Z');
    // A function cannot be stored in IndexedDB, so the snapshot write throws inside the transaction.
    (draft.snapshot as unknown as Record<string, unknown>).broken = () => undefined;
    await expect(commitCapture(db, draft)).rejects.toThrow();
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources).toHaveLength(0);
    expect(view.session.next_source_number).toBe(1);
  });

  it('stores links as PENDING and selections without a snapshot', async () => {
    const db = await freshDb();
    await commitCapture(db, linkDraft(URL_A, '2026-10-05T10:00:00.000Z', 'https://news.example.com/'));
    await commitCapture(db, await selectionDraft(URL_B, 'Selected words', '2026-10-05T10:01:00.000Z'));
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => chooseSnapshot(s).status)).toEqual(['pending', 'none']);
    expect(view.sources[1]!.captures[0]!.capture.fragment?.text).toBe('Selected words');
  });

  it('keeps data after the database is closed and reopened', async () => {
    const name = `persist-${crypto.randomUUID()}`;
    const db = await openDb(name);
    const { capture } = await commitCapture(db, await pageDraft(URL_A, 'Persisted text', '2026-10-05T10:00:00.000Z'));
    await updateCaptureNote(db, capture.id, 'my note');
    db.close();
    const reopened = await openDb(name);
    const view = await loadSessionView(reopened, INBOX_SESSION_ID);
    expect(view.sources[0]!.captures[0]!.capture.note).toBe('my note');
    expect((view.sources[0]!.captures[0]!.snapshot as OkSnapshot).text).toBe('Persisted text');
  });
});

describe('undoCapture', () => {
  it('removes only the undone capture and never reuses an S-ID', async () => {
    const db = await freshDb();
    const first = await commitCapture(db, await pageDraft(URL_A, 'one', '2026-10-05T10:00:00.000Z'));
    const second = await commitCapture(db, await pageDraft(URL_A, 'two', '2026-10-05T10:01:00.000Z'));
    expect(await undoCapture(db, second.capture.id)).toEqual({ removed: true, sourceRemoved: false });
    let view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources[0]!.captures.map((c) => c.capture.id)).toEqual([first.capture.id]);

    const b = await commitCapture(db, await pageDraft(URL_B, 'b', '2026-10-05T10:02:00.000Z'));
    expect(b.source.number).toBe(2);
    expect(await undoCapture(db, b.capture.id)).toEqual({ removed: true, sourceRemoved: true });
    expect(await undoCapture(db, b.capture.id)).toEqual({ removed: false, sourceRemoved: false });
    const c = await commitCapture(db, await pageDraft('https://example.com/c', 'c', '2026-10-05T10:03:00.000Z'));
    expect(c.source.number).toBe(3);
    view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => s.source.number)).toEqual([1, 3]);
  });
});
