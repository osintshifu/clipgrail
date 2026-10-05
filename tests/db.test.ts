/// <reference types="node" />
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  commitCapture,
  commitCaptures,
  createSession,
  listSessions,
  loadSessionView,
  moveSource,
  openDb,
  readAllData,
  renameSession,
  setSessionArchived,
  undoCapture,
  undoCaptures,
  updateCaptureNote,
  updateSessionText,
  updateSourceNote,
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

  it('archives and unarchives a session without touching its data, but never the Inbox', async () => {
    const db = await freshDb();
    const session = await createSession(db, 'Old research');
    await commitCapture(db, await pageDraft(URL_A, 'text', '2026-10-05T10:00:00.000Z', session.id));
    expect((await setSessionArchived(db, session.id, true, '2026-10-06T08:00:00.000Z')).archived_at).toBe('2026-10-06T08:00:00.000Z');
    expect((await loadSessionView(db, session.id)).sources).toHaveLength(1);
    expect((await setSessionArchived(db, session.id, false)).archived_at).toBeNull();
    await expect(setSessionArchived(db, INBOX_SESSION_ID, true)).rejects.toThrow('cannot be archived');
  });

  it('upgrades a schema 1 database without losing records', async () => {
    const name = `v1-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const v1 = request.result;
        v1.createObjectStore('sessions', { keyPath: 'id' }).add({ id: INBOX_SESSION_ID, name: 'Inbox', created_at: 'x', next_source_number: 2, prompt: 'p', notes: '' });
        const sources = v1.createObjectStore('sources', { keyPath: 'id' });
        sources.createIndex('session_dedup_url', ['session_id', 'dedup_url'], { unique: true });
        sources.createIndex('session_number', ['session_id', 'number'], { unique: true });
        sources.createIndex('session', 'session_id');
        sources.add({ id: 'src-1', session_id: INBOX_SESSION_ID, number: 1, dedup_url: URL_A, created_at: 'x' });
        const captures = v1.createObjectStore('captures', { keyPath: 'id' });
        captures.createIndex('source', 'source_id');
        captures.createIndex('session', 'session_id');
        v1.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('session', 'session_id');
        v1.createObjectStore('jobs', { keyPath: 'id' }).createIndex('session_created', ['session_id', 'created_at']);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const db = await openDb(name);
    const data = await readAllData(db);
    expect(data.sessions).toEqual([{ id: INBOX_SESSION_ID, name: 'Inbox', created_at: 'x', next_source_number: 2, prompt: 'p', notes: '', archived_at: null }]);
    expect(data.sources).toEqual([{ id: 'src-1', session_id: INBOX_SESSION_ID, number: 1, dedup_url: URL_A, created_at: 'x', note: '' }]);
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

describe('commitCaptures', () => {
  it('saves a batch all or nothing, and Undo removes exactly that batch', async () => {
    const db = await freshDb();
    const earlier = await commitCapture(db, await pageDraft(URL_A, 'earlier', '2026-10-05T10:00:00.000Z'));
    const broken = await pageDraft('https://example.com/c', 'c', '2026-10-05T10:01:00.000Z');
    (broken.snapshot as unknown as Record<string, unknown>).broken = () => undefined;
    await expect(commitCaptures(db, [linkDraft(URL_B, '2026-10-05T10:01:00.000Z', URL_A), broken])).rejects.toThrow();
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources).toHaveLength(1);

    const batch = await commitCaptures(db, [
      linkDraft(URL_A, '2026-10-05T10:02:00.000Z', URL_A),
      linkDraft(URL_B, '2026-10-05T10:02:00.000Z', URL_A),
    ]);
    expect(batch.map((r) => [r.source.number, r.isNewSource])).toEqual([[1, false], [2, true]]);
    expect(await undoCaptures(db, batch.map((r) => r.capture.id))).toEqual([
      { removed: true, sourceRemoved: false },
      { removed: true, sourceRemoved: true },
    ]);
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => s.captures.map((c) => c.capture.id))).toEqual([[earlier.capture.id]]);
    expect(view.session.next_source_number).toBe(3);
  });
});

describe('moveSource', () => {
  it('moves a source with its captures and snapshots, joins a source with the same address and never reuses labels', async () => {
    const db = await freshDb();
    const target = await createSession(db, 'Target');
    await commitCapture(db, await pageDraft(URL_A, 'a', '2026-10-05T10:00:00.000Z'));
    const b = await commitCapture(db, await pageDraft(URL_B, 'b one', '2026-10-05T10:01:00.000Z'));
    await commitCapture(db, await selectionDraft(URL_B, 'b words', '2026-10-05T10:02:00.000Z'));
    await updateSourceNote(db, b.source.id, 'Inbox note');
    await commitCapture(db, await pageDraft('https://example.com/t', 't', '2026-10-05T09:00:00.000Z', target.id));

    // No source with this address in the target: the source gets the target's next label.
    const moved = await moveSource(db, b.source.id, target.id);
    expect(moved).toMatchObject({ joined: false, source: { id: b.source.id, session_id: target.id, number: 2, note: 'Inbox note' } });
    const targetView = await loadSessionView(db, target.id);
    const movedEntry = targetView.sources.find((s) => s.source.id === b.source.id)!;
    expect(movedEntry.captures.map((c) => c.capture.kind)).toEqual(['page', 'selection']);
    expect(movedEntry.captures[0]!.snapshot).toMatchObject({ status: 'ok', text: 'b one', session_id: target.id });
    const inbox = await loadSessionView(db, INBOX_SESSION_ID);
    expect(inbox.sources.map((s) => s.source.number)).toEqual([1]);
    expect((await commitCapture(db, await pageDraft('https://example.com/new', 'n', '2026-10-05T11:00:00.000Z'))).source.number).toBe(3);

    // The same address captured again in the Inbox, then moved: it joins the target's S2.
    const again = await commitCapture(db, await pageDraft(URL_B, 'b two', '2026-10-05T12:00:00.000Z'));
    await updateSourceNote(db, again.source.id, 'Second note');
    const joined = await moveSource(db, again.source.id, target.id);
    expect(joined).toMatchObject({ joined: true, source: { id: b.source.id, number: 2, note: 'Inbox note\n\nSecond note' } });
    const after = await loadSessionView(db, target.id);
    expect(after.sources.map((s) => s.source.number)).toEqual([1, 2]);
    expect(after.sources[1]!.captures.map((c) => c.capture.captured_at)).toEqual([
      '2026-10-05T10:01:00.000Z',
      '2026-10-05T10:02:00.000Z',
      '2026-10-05T12:00:00.000Z',
    ]);
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources.map((s) => s.source.number)).toEqual([1, 3]);
    await expect(moveSource(db, b.source.id, target.id)).rejects.toThrow('already in this session');
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
