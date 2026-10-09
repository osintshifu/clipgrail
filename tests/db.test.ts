/// <reference types="node" />
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBackup, validateBackup } from '../src/lib/backup';
import {
  commitCapture,
  commitCaptures,
  countForDeletion,
  countSourcesForDeletion,
  createSession,
  deleteSession,
  deleteSource,
  deleteSources,
  emptyInbox,
  listSessions,
  loadLibrary,
  loadSessionView,
  loadSnapshotText,
  moveSource,
  openDb,
  readAllData,
  renameSession,
  replaceAllData,
  saveThumbnail,
  saveJob,
  setSessionArchived,
  setSourceImportant,
  thumbnailIds,
  undoCapture,
  undoCaptures,
  undoSavedCaptures,
  updateCaptureNote,
  updateSessionText,
  updateSourceNote,
} from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { recordVisit } from '../src/lib/recording';
import type { OkSnapshot } from '../src/lib/model';
import { DEFAULT_JOB_SETTINGS, buildResearchJob } from '../src/lib/research-job';
import { chooseSnapshot } from '../src/lib/selection';
import { DEFAULT_PRESETS } from '../src/lib/settings';
import { failedDraft, freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

/** Creates a database with the store layout of schema 1 and 2 at the given version, filled by `fill`. */
function legacyDb(name: string, version: 1 | 2, fill: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const old = request.result;
      old.createObjectStore('sessions', { keyPath: 'id' });
      const sources = old.createObjectStore('sources', { keyPath: 'id' });
      sources.createIndex('session_dedup_url', ['session_id', 'dedup_url'], { unique: true });
      sources.createIndex('session_number', ['session_id', 'number'], { unique: true });
      sources.createIndex('session', 'session_id');
      const captures = old.createObjectStore('captures', { keyPath: 'id' });
      captures.createIndex('source', 'source_id');
      captures.createIndex('session', 'session_id');
      old.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('session', 'session_id');
      old.createObjectStore('jobs', { keyPath: 'id' }).createIndex('session_created', ['session_id', 'created_at']);
      fill(request.transaction!);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

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
    await legacyDb(name, 1, (tx) => {
      tx.objectStore('sessions').add({ id: INBOX_SESSION_ID, name: 'Inbox', created_at: 'x', next_source_number: 2, prompt: 'p', notes: '' });
      tx.objectStore('sources').add({ id: 'src-1', session_id: INBOX_SESSION_ID, number: 1, dedup_url: URL_A, created_at: 'x' });
      tx.objectStore('captures').add({ id: 'cap-1', session_id: INBOX_SESSION_ID, source_id: 'src-1', kind: 'tab', captured_at: 'x', note: '' });
    });
    const db = await openDb(name);
    const data = await readAllData(db);
    expect(data.sessions).toEqual([{ id: INBOX_SESSION_ID, name: 'Inbox', created_at: 'x', next_source_number: 2, prompt: 'p', notes: '', archived_at: null }]);
    expect(data.sources).toEqual([{ id: 'src-1', session_id: INBOX_SESSION_ID, number: 1, dedup_url: URL_A, created_at: 'x', note: '', merged_ids: [], important: false }]);
    expect(data.captures).toEqual([{ id: 'cap-1', session_id: INBOX_SESSION_ID, source_id: 'src-1', kind: 'tab', captured_at: 'x', note: '', frame: null, navigation: null }]);
  });

  it('upgrades a schema 2 database by moving snapshot texts to their own store, unchanged', async () => {
    const name = `v2-${crypto.randomUUID()}`;
    const draft = await pageDraft(URL_A, 'Text kept across the upgrade', '2026-10-05T10:00:00.000Z');
    const snapshot = { ...draft.snapshot!, id: 'snap-1', capture_id: 'cap-1', source_id: 'src-1', session_id: INBOX_SESSION_ID } as OkSnapshot;
    await legacyDb(name, 2, (tx) => {
      tx.objectStore('sessions').add({ id: INBOX_SESSION_ID, name: 'Inbox', created_at: 'x', next_source_number: 2, prompt: '', notes: '', archived_at: null });
      tx.objectStore('sources').add({ id: 'src-1', session_id: INBOX_SESSION_ID, number: 1, dedup_url: URL_A, created_at: 'x', note: '' });
      const { snapshot: _, ...capture } = { ...draft, id: 'cap-1', source_id: 'src-1', snapshot_id: 'snap-1', note: '' };
      tx.objectStore('captures').add(capture);
      tx.objectStore('snapshots').add(snapshot);
    });
    const db = await openDb(name);
    expect((await readAllData(db)).snapshots).toEqual([snapshot]);
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources[0]!.captures[0]!.snapshot).toEqual(snapshot);
    const library = await loadLibrary(db);
    expect(library.sources[0]!.captures[0]!.snapshot).not.toHaveProperty('text');
    expect(chooseSnapshot(library.sources[0]!).status).toBe('ok');
    expect(await loadSnapshotText(db, 'snap-1')).toBe(snapshot.text);
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

describe('undoSavedCaptures', () => {
  it('undoes saved tabs or a recording but keeps the pages with a note or moved since, and the sources clipped since', async () => {
    const db = await freshDb();
    const other = await createSession(db, 'Port strike');
    const at = '2026-10-07T09:00:00.000Z';
    const saved = await commitCaptures(db, ['a', 'b', 'c', 'd', 'e'].map((p) => linkDraft(`https://example.com/${p}`, at, URL_A)));
    await updateSourceNote(db, saved[0]!.source.id, 'Source note');
    await updateCaptureNote(db, saved[1]!.capture.id, 'Capture note');
    await moveSource(db, saved[2]!.source.id, other.id);
    await commitCapture(db, await pageDraft('https://example.com/e', 'Clipped since.', '2026-10-07T09:05:00.000Z'));
    const items = saved.map((r) => ({ capture_id: r.capture.id, session_id: r.capture.session_id }));
    expect(await undoSavedCaptures(db, items)).toEqual({ removed: 2, kept: 3, stayed: 1 });
    expect(await undoSavedCaptures(db, items)).toEqual({ removed: 0, kept: 3, stayed: 0 });
    expect((await readAllData(db)).sources.map((s) => (s as { dedup_url: string }).dedup_url).sort()).toEqual(['a', 'b', 'c', 'e'].map((p) => `https://example.com/${p}`));
  });
});

describe('visits and important sources', () => {
  it('removes a source with its visits when its last saved capture goes, and Undo keeps sources marked important', async () => {
    const db = await freshDb();
    const at = '2026-10-07T09:00:00.000Z';
    const visitDraft = (url: string) => ({
      ...linkDraft(url, '2026-10-07T10:00:00.000Z', URL_A),
      kind: 'visit' as const,
      anchor_text: null,
      navigation: { transition: 'typed', qualifiers: [], in_page: false },
      snapshot: null,
    });
    const [a, b] = await commitCaptures(db, ['a', 'b'].map((p) => linkDraft(`https://example.com/${p}`, at, URL_A)));
    const [va, vb] = await commitCaptures(db, [visitDraft('https://example.com/a'), visitDraft('https://example.com/b')]);
    expect(va!.captureCount).toBe(1);
    await setSourceImportant(db, b!.source.id, true);
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => [s.captures.length, s.visits.length, s.source.important])).toEqual([[1, 1, false], [1, 1, true]]);
    // Visits are removed and not counted; the important source stays with its visit.
    const items = [a!, b!, va!, vb!].map((r) => ({ capture_id: r.capture.id, session_id: r.capture.session_id }));
    expect(await undoSavedCaptures(db, items)).toEqual({ removed: 1, kept: 1, stayed: 0 });
    expect((await readAllData(db)).captures.map((c) => (c as { id: string }).id)).toEqual([b!.capture.id]);
    // Undoing the last saved capture takes the source and any visit left with it.
    const [vb2] = await commitCaptures(db, [visitDraft('https://example.com/b')]);
    expect(vb2!.isNewSource).toBe(false);
    expect((await undoCapture(db, b!.capture.id)).sourceRemoved).toBe(true);
    const left = await readAllData(db);
    expect([left.sources.length, left.captures.length]).toEqual([0, 0]);
  });

  it('never makes a source from a visit alone, also when the page is deleted while a return to it is saved, and a recorded opening of a saved link goes with its visits', async () => {
    const db = await freshDb();
    const url = 'https://example.com/r';
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 9, minutes)).toISOString();
    const nav = { transition: 'link', qualifiers: [], in_page: false };
    const first = await recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at: at(0), navigation: nav });
    await Promise.all([recordVisit(db, INBOX_SESSION_ID, { url, title: '', found_on: null, at: at(40), navigation: nav }), deleteSource(db, first!.source.id)]);
    const data = await readAllData(db);
    const saved = new Set((data.captures as Array<{ kind: string; source_id: string }>).filter((c) => c.kind !== 'visit').map((c) => c.source_id));
    expect((data.sources as Array<{ id: string }>).every((s) => saved.has(s.id))).toBe(true);

    // A page saved as a link, opened while recording and returned to: removing the recorded opening removes the return too.
    const linked = 'https://example.com/linked';
    await commitCapture(db, linkDraft(linked, at(0), URL_A));
    const opened = await recordVisit(db, INBOX_SESSION_ID, { url: linked, title: '', found_on: null, at: at(1), navigation: nav });
    const back = await recordVisit(db, INBOX_SESSION_ID, { url: linked, title: '', found_on: null, at: at(45), navigation: nav });
    expect([opened!.capture.kind, back!.capture.kind]).toEqual(['tab', 'visit']);
    expect(await undoSavedCaptures(db, [{ capture_id: opened!.capture.id, session_id: INBOX_SESSION_ID }])).toEqual({ removed: 1, kept: 0, stayed: 0 });
    const entry = (await loadSessionView(db, INBOX_SESSION_ID)).sources.find((s) => s.source.dedup_url === linked)!;
    expect([entry.captures.map((c) => c.capture.kind), entry.visits.length]).toEqual([['link'], 0]);
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
    expect(await loadSnapshotText(db, second.snapshot!.id)).toBeUndefined();
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

  /** A backup of what is left must still pass the restore checks. */
  async function remainderIsValid(db: IDBDatabase): Promise<boolean> {
    const settings = { active_session_id: INBOX_SESSION_ID, presets: DEFAULT_PRESETS, job_settings: {} };
    return (await validateBackup(JSON.stringify(createBackup(await readAllData(db), settings, '2026-10-06T12:00:00.000Z')))).ok;
  }
  const generate = async (db: IDBDatabase, sessionId: string, id: string, excluded: string[] = []) =>
    saveJob(db, buildResearchJob({ view: await loadSessionView(db, sessionId), settings: { ...DEFAULT_JOB_SETTINGS, excluded_source_ids: excluded }, id, createdAt: '2026-10-06T10:00:00.000Z' }));

  it('deletes a source with its captures, texts and the Research Jobs that include it, and never reuses its label', async () => {
    const db = await freshDb();
    const a = await commitCapture(db, await pageDraft(URL_A, 'Alpha text', '2026-10-06T09:00:00.000Z'));
    await commitCapture(db, await selectionDraft(URL_A, 'Alpha', '2026-10-06T09:01:00.000Z'));
    const b = await commitCapture(db, await pageDraft(URL_B, 'Beta text', '2026-10-06T09:02:00.000Z'));
    await generate(db, INBOX_SESSION_ID, 'with-a');
    await generate(db, INBOX_SESSION_ID, 'without-a', [a.source.id]);

    expect(await countForDeletion(db, INBOX_SESSION_ID, a.source.id)).toEqual({ sources: 1, captures: 2, jobs: 1 });
    // Several sources: a job that includes both counts once.
    expect(await countSourcesForDeletion(db, [a.source.id, b.source.id])).toEqual({ sources: 2, captures: 3, jobs: 2 });
    expect(await deleteSource(db, a.source.id)).toEqual({ sources: 1, captures: 2, jobs: 1 });
    const data = await readAllData(db);
    expect(data.sources.map((s) => (s as { id: string }).id)).toEqual([b.source.id]);
    expect(data.captures).toHaveLength(1);
    expect(data.jobs.map((j) => (j as { id: string }).id)).toEqual(['without-a']);
    expect(await loadSnapshotText(db, a.snapshot!.id)).toBeUndefined();
    await expect(deleteSource(db, a.source.id)).rejects.toThrow('no longer exists');

    const c = await commitCapture(db, await pageDraft('https://example.com/c', 'c', '2026-10-06T09:03:00.000Z'));
    expect(c.source.number).toBe(3);
    expect(await remainderIsValid(db)).toBe(true);

    // Deleting several at once skips sources that are already gone.
    expect(await deleteSources(db, [b.source.id, a.source.id, c.source.id])).toEqual({ sources: 2, captures: 2, jobs: 1 });
    expect((await readAllData(db)).sources).toHaveLength(0);
  });

  it('deletes a session with everything in it and empties the Inbox, keeping the Inbox and its numbering', async () => {
    const db = await freshDb();
    const other = await createSession(db, 'Port strike');
    await commitCapture(db, await pageDraft(URL_A, 'Inbox text', '2026-10-06T09:00:00.000Z'));
    await commitCapture(db, await pageDraft(URL_A, 'Strike text', '2026-10-06T09:01:00.000Z', other.id));
    await commitCapture(db, linkDraft(URL_B, '2026-10-06T09:02:00.000Z', URL_A, other.id));
    await generate(db, INBOX_SESSION_ID, 'inbox-job');
    await generate(db, other.id, 'strike-job');

    expect(await countForDeletion(db, other.id)).toEqual({ sources: 2, captures: 2, jobs: 1 });
    expect(await deleteSession(db, other.id)).toEqual({ sources: 2, captures: 2, jobs: 1 });
    expect((await listSessions(db)).map((s) => s.id)).toEqual([INBOX_SESSION_ID]);
    const left = await readAllData(db);
    expect([...left.sources, ...left.captures, ...left.snapshots, ...left.jobs].every((r) => (r as { session_id: string }).session_id === INBOX_SESSION_ID)).toBe(true);
    expect(left.jobs).toHaveLength(1);
    await expect(deleteSession(db, INBOX_SESSION_ID)).rejects.toThrow('cannot be deleted');

    await updateSessionText(db, INBOX_SESSION_ID, { prompt: 'Kept prompt' });
    expect(await emptyInbox(db)).toEqual({ sources: 1, captures: 1, jobs: 1 });
    const inbox = await loadSessionView(db, INBOX_SESSION_ID);
    expect([inbox.sources.length, inbox.session.prompt, inbox.session.next_source_number]).toEqual([0, 'Kept prompt', 2]);
    expect((await readAllData(db)).jobs).toHaveLength(0);
    expect((await commitCapture(db, await pageDraft(URL_B, 'b', '2026-10-06T09:03:00.000Z'))).source.number).toBe(2);
    expect(await remainderIsValid(db)).toBe(true);
  });

  it('deletes the Research Jobs of a former session that hold the text of a moved source', async () => {
    const db = await freshDb();
    const other = await createSession(db, 'Port strike');
    const a = await commitCapture(db, await pageDraft(URL_A, 'Alpha text', '2026-10-06T09:00:00.000Z'));
    const b = await commitCapture(db, await pageDraft(URL_B, 'Beta text', '2026-10-06T09:01:00.000Z'));
    const joined = await commitCapture(db, await pageDraft(URL_B, 'Beta there', '2026-10-06T09:02:00.000Z', other.id));
    await generate(db, INBOX_SESSION_ID, 'with-a', [b.source.id]);
    await generate(db, INBOX_SESSION_ID, 'with-b', [a.source.id]);
    await moveSource(db, a.source.id, other.id);
    // B joins the source with the same address there, so the job names B's old ID.
    await moveSource(db, b.source.id, other.id);

    expect(await countForDeletion(db, other.id, a.source.id)).toEqual({ sources: 1, captures: 1, jobs: 1 });
    expect(await deleteSource(db, a.source.id)).toEqual({ sources: 1, captures: 1, jobs: 1 });
    expect(await deleteSource(db, joined.source.id)).toEqual({ sources: 1, captures: 2, jobs: 1 });
    expect((await readAllData(db)).jobs).toHaveLength(0);
  });

  it('deletes the Links only jobs of every source that joined a deleted one along a chain of moves, without changing them, also after a restore', async () => {
    const db = await freshDb();
    const [one, two, three] = [await createSession(db, 'One'), await createSession(db, 'Two'), await createSession(db, 'Three')];
    const at = '2026-10-07T09:00:00.000Z';
    const a = await commitCapture(db, linkDraft(URL_A, at, URL_B, one.id));
    const b = await commitCapture(db, linkDraft(URL_A, at, URL_B, two.id));
    const c = await commitCapture(db, linkDraft(URL_A, at, URL_B, three.id));
    const linksOnly = async (sessionId: string, id: string) =>
      saveJob(db, buildResearchJob({ view: await loadSessionView(db, sessionId), settings: { ...DEFAULT_JOB_SETTINGS, context_mode: 'links' }, id, createdAt: at }));
    await linksOnly(one.id, 'job-a');
    await moveSource(db, a.source.id, two.id);
    await linksOnly(two.id, 'job-b');
    const jobsBefore = (await readAllData(db)).jobs;
    await moveSource(db, b.source.id, three.id);
    const data = await readAllData(db);
    expect(data.jobs).toEqual(jobsBefore);
    expect((data.sources as Array<{ id: string; merged_ids: string[] }>).find((s) => s.id === c.source.id)!.merged_ids.sort()).toEqual([a.source.id, b.source.id].sort());

    const settings = { active_session_id: INBOX_SESSION_ID, presets: DEFAULT_PRESETS, job_settings: {} };
    const checked = await validateBackup(JSON.stringify(createBackup(data, settings, at)));
    if (!checked.ok) throw new Error(checked.error);
    await replaceAllData(db, checked.backup.data);
    expect(await deleteSource(db, c.source.id)).toEqual({ sources: 1, captures: 3, jobs: 2 });
    expect((await readAllData(db)).jobs).toHaveLength(0);
  });

  it('reads a snapshot whose saved text is missing as failed, without stopping the panel, the library, backup or restore', async () => {
    const db = await freshDb();
    const a = await commitCapture(db, await pageDraft(URL_A, 'Alpha text', '2026-10-06T09:00:00.000Z'));
    await commitCapture(db, await pageDraft(URL_B, 'Beta text', '2026-10-06T09:01:00.000Z'));
    await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshot_texts', 'readwrite');
      tx.objectStore('snapshot_texts').delete(a.snapshot!.id);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    const missing = { status: 'failed', error_code: 'text_missing' };
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources[0]!.captures[0]!.snapshot).toMatchObject(missing);
    expect(chooseSnapshot((await loadLibrary(db)).sources.find((s) => s.source.id === a.source.id)!).entry?.snapshot).toMatchObject(missing);
    expect(await remainderIsValid(db)).toBe(true);
    await replaceAllData(db, await readAllData(db));
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources.map((s) => s.captures[0]!.snapshot!.status)).toEqual(['failed', 'ok']);
  });
});

describe('replaceAllData', () => {
  it('restores an older backup without giving labels used since to other sources', async () => {
    const db = await freshDb();
    await commitCapture(db, await pageDraft(URL_A, 'a', '2026-10-07T09:00:00.000Z'));
    const backup = await readAllData(db);
    expect((await commitCapture(db, await pageDraft(URL_B, 'b', '2026-10-07T09:01:00.000Z'))).source.number).toBe(2);
    await replaceAllData(db, backup);
    expect((await commitCapture(db, await pageDraft('https://example.com/c', 'c', '2026-10-07T09:02:00.000Z'))).source.number).toBe(3);
  });
});

describe('thumbnails', () => {
  it('keeps a thumbnail only as long as its capture, and leaves it out of backups', async () => {
    const db = await freshDb();
    const image = 'data:image/jpeg;base64,AAAA';
    const first = await commitCapture(db, await pageDraft(URL_A, 'one', '2026-10-06T10:00:00.000Z'));
    const second = await commitCapture(db, await pageDraft(URL_A, 'two', '2026-10-06T10:01:00.000Z'));
    const other = await commitCapture(db, await pageDraft(URL_B, 'b', '2026-10-06T10:02:00.000Z'));
    for (const c of [first, second, other]) await saveThumbnail(db, c.capture.id, image);
    expect(await thumbnailIds(db)).toEqual(new Set([first.capture.id, second.capture.id, other.capture.id]));

    // Undo takes the capture's thumbnail; deleting a source takes all of its thumbnails.
    await undoCapture(db, second.capture.id);
    await deleteSource(db, other.source.id);
    expect(await thumbnailIds(db)).toEqual(new Set([first.capture.id]));
    // A capture undone before its thumbnail arrives gets none.
    await saveThumbnail(db, second.capture.id, image);
    expect((await thumbnailIds(db)).has(second.capture.id)).toBe(false);

    // Backups leave thumbnails out, so restoring replaces them with none.
    const data = await readAllData(db);
    expect(JSON.stringify(data)).not.toContain(image);
    await replaceAllData(db, data);
    expect(await thumbnailIds(db)).toEqual(new Set());
  });
});
