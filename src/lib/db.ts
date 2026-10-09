import { INBOX_SESSION_ID } from './model';
import type { Capture, CaptureFrame, CaptureKind, CaptureNavigation, FailedSnapshot, Fragment, OkSnapshotMeta, Session, Snapshot, SnapshotMeta, Source } from './model';
import type { ResearchJob } from './research-job';
import type { SnapshotDraft } from './snapshot';

export const DB_NAME = 'clipgrail';
export const DB_SCHEMA_VERSION = 6;
/** Records as they appear in backups. The texts of successful snapshots are part of the snapshot records there. */
export const DATA_STORES = ['sessions', 'sources', 'captures', 'snapshots', 'jobs'] as const;
export type DataStore = (typeof DATA_STORES)[number];
/** Texts of successful snapshots, one record per snapshot, kept apart so lists and the library read without them. */
const TEXT_STORE = 'snapshot_texts';
/** Small images of the clipped pages, one per capture. Not part of backups. */
const THUMB_STORE = 'thumbnails';
const CAPTURE_STORES = ['sessions', 'sources', 'captures', 'snapshots', TEXT_STORE, THUMB_STORE] as const;

interface SnapshotText {
  snapshot_id: string;
  text: string;
}

/** Splits a snapshot into the record for the snapshots store and, for a successful one, its text record. */
function splitSnapshot(snapshot: Snapshot): { meta: SnapshotMeta; text: SnapshotText | null } {
  if (snapshot.status !== 'ok') return { meta: snapshot, text: null };
  const { text, ...meta } = snapshot;
  return { meta, text: { snapshot_id: snapshot.id, text } };
}

let writeListener: (() => void) | null = null;

/** Called after every committed read-write transaction; pages use it to tell other ClipGrail pages that data changed. */
export function setWriteListener(listener: (() => void) | null): void {
  writeListener = listener;
}

export function newInboxSession(createdAt: string): Session {
  return { id: INBOX_SESSION_ID, name: 'Inbox', created_at: createdAt, next_source_number: 1, prompt: '', notes: '', archived_at: null };
}

/** Adds fields introduced by a schema upgrade to every record of a store, keeping values that already exist. */
function backfill(store: IDBObjectStore, defaults: Record<string, unknown>): void {
  store.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    cursor.update({ ...defaults, ...(cursor.value as Record<string, unknown>) });
    cursor.continue();
  };
}

/** Moves the text of every successful snapshot from its snapshot record to the text store. */
function moveTexts(tx: IDBTransaction): void {
  const texts = tx.objectStore(TEXT_STORE);
  tx.objectStore('snapshots').openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    const snapshot = cursor.value as Snapshot;
    if (snapshot.status === 'ok' && typeof snapshot.text === 'string') {
      const { meta, text } = splitSnapshot(snapshot);
      if (text) texts.put(text);
      cursor.update(meta);
    }
    cursor.continue();
  };
}

/**
 * Opens (and on first use creates) the research database. The Inbox session
 * is created in the same upgrade transaction as the schema.
 */
export function openDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_SCHEMA_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('sessions', { keyPath: 'id' });
        const sources = db.createObjectStore('sources', { keyPath: 'id' });
        sources.createIndex('session_dedup_url', ['session_id', 'dedup_url'], { unique: true });
        sources.createIndex('session_number', ['session_id', 'number'], { unique: true });
        sources.createIndex('session', 'session_id');
        const captures = db.createObjectStore('captures', { keyPath: 'id' });
        captures.createIndex('source', 'source_id');
        captures.createIndex('session', 'session_id');
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
        snapshots.createIndex('session', 'session_id');
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('session_created', ['session_id', 'created_at']);
        request.transaction?.objectStore('sessions').add(newInboxSession(new Date().toISOString()));
      }
      // Fields added by later schemas, filled in with one pass over each store: two cursors updating the same records would overwrite each other.
      const defaults: Record<'sessions' | 'sources' | 'captures', Record<string, unknown>> = { sessions: {}, sources: {}, captures: {} };
      if (event.oldVersion >= 1 && event.oldVersion < 2) {
        // v2: sessions can be archived and sources have a note.
        defaults.sessions.archived_at = null;
        defaults.sources.note = '';
      }
      if (event.oldVersion < 3) {
        // v3: snapshot texts move to their own store.
        db.createObjectStore(TEXT_STORE, { keyPath: 'snapshot_id' });
        if (event.oldVersion >= 1 && request.transaction) moveTexts(request.transaction);
      }
      if (event.oldVersion < 4) {
        // v4: page thumbnails, keyed by capture.
        db.createObjectStore(THUMB_STORE, { keyPath: 'capture_id' });
      }
      if (event.oldVersion >= 1 && event.oldVersion < 5) {
        // v5: sources remember the IDs of sources that joined them; selections note an embedded frame. Earlier captures have no frame recorded.
        defaults.sources.merged_ids = [];
        defaults.captures.frame = null;
      }
      if (event.oldVersion >= 1 && event.oldVersion < 6) {
        // v6: sources can be marked important; recorded pages keep how they were reached. Earlier captures have no navigation recorded.
        defaults.sources.important = false;
        defaults.captures.navigation = null;
      }
      for (const [store, fields] of Object.entries(defaults)) {
        if (Object.keys(fields).length && request.transaction) backfill(request.transaction.objectStore(store), fields);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version of the extension upgrade the schema instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the ClipGrail database.'));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
  });
}

/**
 * Runs `work` in one transaction and resolves only after the transaction has
 * committed. Any error aborts the whole transaction, so nothing is half-written.
 * `work` may only await requests of this transaction.
 */
async function inTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const committed = completion(tx);
  let value: T;
  try {
    value = await work(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    await committed.catch(() => undefined);
    throw error;
  }
  await committed;
  if (mode === 'readwrite') writeListener?.();
  return value;
}

async function getSession(tx: IDBTransaction, id: string): Promise<Session> {
  const session = (await result(tx.objectStore('sessions').get(id))) as Session | undefined;
  if (!session) throw new Error(`Session "${id}" does not exist.`);
  return session;
}

// Sessions

/** Inbox first, then by creation time. */
function sortSessions(sessions: Session[]): Session[] {
  return sessions.sort(
    (a, b) => Number(b.id === INBOX_SESSION_ID) - Number(a.id === INBOX_SESSION_ID) || a.created_at.localeCompare(b.created_at),
  );
}

export function hasSession(db: IDBDatabase, id: string): Promise<boolean> {
  return inTransaction(db, ['sessions'], 'readonly', async (tx) => (await result(tx.objectStore('sessions').getKey(id))) !== undefined);
}

/**
 * Saves a page a recording visited, in one transaction with the look at the
 * session, so a source deleted or moved meanwhile is never recreated by a
 * visit alone. `kindFor` gets when the page was last saved or visited (the
 * newest capture other than a link saved without opening it): undefined when
 * the session does not have the page, null when it has it only as such links.
 * It returns the kind to save, or null to save nothing. A page is saved with
 * a PENDING snapshot, a visit without one.
 */
export function commitRecordedPage(
  db: IDBDatabase,
  draft: Omit<CaptureDraft, 'kind' | 'snapshot'>,
  kindFor: (lastOpenedAt: string | null | undefined) => 'tab' | 'visit' | null,
): Promise<CommitResult | null> {
  return inTransaction(db, CAPTURE_STORES, 'readwrite', async (tx) => {
    const source = (await result(tx.objectStore('sources').index('session_dedup_url').get([draft.session_id, draft.dedup_url]))) as Source | undefined;
    let last: string | null | undefined;
    if (source) {
      const captures = (await result(tx.objectStore('captures').index('source').getAll(source.id))) as Capture[];
      last = captures.filter((c) => c.kind !== 'link').map((c) => c.captured_at).sort().at(-1) ?? null;
    }
    const kind = kindFor(last);
    if (!kind) return null;
    return addCapture(tx, { ...draft, kind, snapshot: kind === 'tab' ? { status: 'pending' } : null });
  });
}

export function listSessions(db: IDBDatabase): Promise<Session[]> {
  return inTransaction(db, ['sessions'], 'readonly', async (tx) => sortSessions((await result(tx.objectStore('sessions').getAll())) as Session[]));
}

function cleanName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error('Session name cannot be empty.');
  if (cleaned.length > 120) throw new Error('Session name is longer than 120 characters.');
  return cleaned;
}

export function createSession(db: IDBDatabase, name: string, createdAt = new Date().toISOString()): Promise<Session> {
  const session: Session = {
    id: crypto.randomUUID(),
    name: cleanName(name),
    created_at: createdAt,
    next_source_number: 1,
    prompt: '',
    notes: '',
    archived_at: null,
  };
  return inTransaction(db, ['sessions'], 'readwrite', async (tx) => {
    tx.objectStore('sessions').add(session);
    return session;
  });
}

export function renameSession(db: IDBDatabase, id: string, name: string): Promise<Session> {
  if (id === INBOX_SESSION_ID) return Promise.reject(new Error('The Inbox cannot be renamed.'));
  const cleaned = cleanName(name);
  return inTransaction(db, ['sessions'], 'readwrite', async (tx) => {
    const updated = { ...(await getSession(tx, id)), name: cleaned };
    tx.objectStore('sessions').put(updated);
    return updated;
  });
}

/**
 * Archives or unarchives a session. Archiving only moves the session to the
 * Archived group of the session list; its data and S-numbers are unchanged.
 */
export function setSessionArchived(
  db: IDBDatabase,
  id: string,
  archived: boolean,
  at = new Date().toISOString(),
): Promise<Session> {
  if (id === INBOX_SESSION_ID && archived) return Promise.reject(new Error('The Inbox cannot be archived.'));
  return inTransaction(db, ['sessions'], 'readwrite', async (tx) => {
    const session = await getSession(tx, id);
    const updated = { ...session, archived_at: archived ? (session.archived_at ?? at) : null };
    tx.objectStore('sessions').put(updated);
    return updated;
  });
}

/** Saves the session prompt and/or notes. */
export function updateSessionText(
  db: IDBDatabase,
  id: string,
  changes: Partial<Pick<Session, 'prompt' | 'notes'>>,
): Promise<Session> {
  return inTransaction(db, ['sessions'], 'readwrite', async (tx) => {
    const updated = { ...(await getSession(tx, id)), ...changes };
    tx.objectStore('sessions').put(updated);
    return updated;
  });
}

export function updateCaptureNote(db: IDBDatabase, captureId: string, note: string): Promise<Capture> {
  return inTransaction(db, ['captures'], 'readwrite', async (tx) => {
    const capture = (await result(tx.objectStore('captures').get(captureId))) as Capture | undefined;
    if (!capture) throw new Error('This capture no longer exists.');
    const updated = { ...capture, note };
    tx.objectStore('captures').put(updated);
    return updated;
  });
}

/** Reads one note without loading snapshot texts; undefined means the record disappeared. */
export function loadNote(db: IDBDatabase, kind: 'source' | 'capture', id: string): Promise<string | undefined> {
  const store = kind === 'source' ? 'sources' : 'captures';
  return inTransaction(db, [store], 'readonly', async (tx) => {
    const record = await result(tx.objectStore(store).get(id)) as Source | Capture | undefined;
    return record?.note;
  });
}

/** Marks a source important or not. */
export function setSourceImportant(db: IDBDatabase, sourceId: string, important: boolean): Promise<void> {
  return inTransaction(db, ['sources'], 'readwrite', async (tx) => {
    const source = (await result(tx.objectStore('sources').get(sourceId))) as Source | undefined;
    if (!source) throw new Error('This source no longer exists.');
    tx.objectStore('sources').put({ ...source, important });
  });
}

export function updateSourceNote(db: IDBDatabase, sourceId: string, note: string): Promise<Source> {
  return inTransaction(db, ['sources'], 'readwrite', async (tx) => {
    const source = (await result(tx.objectStore('sources').get(sourceId))) as Source | undefined;
    if (!source) throw new Error('This source no longer exists.');
    const updated = { ...source, note };
    tx.objectStore('sources').put(updated);
    return updated;
  });
}

// Captures

export interface CaptureDraft {
  session_id: string;
  kind: CaptureKind;
  dedup_url: string;
  captured_at: string;
  original_url: string;
  tab_title: string;
  found_on: string | null;
  anchor_text: string | null;
  fragment: Fragment | null;
  /** Selections made in an embedded frame (see CaptureFrame); absent otherwise. */
  frame?: CaptureFrame | null;
  /** Pages saved by a recording and visits (see CaptureNavigation); absent otherwise. */
  navigation?: CaptureNavigation | null;
  /** Required for page, link and tab captures, absent for selections and visits. */
  snapshot: SnapshotDraft | null;
}

export interface CommitResult {
  source: Source;
  capture: Capture;
  snapshot: Snapshot | null;
  isNewSource: boolean;
  /** Number of captures of this source after this one was added, visits not counted. */
  captureCount: number;
}

/**
 * Saves captures atomically, in order: for each, finds the session's source by
 * dedup URL or creates it with the next S-number, then adds the capture and
 * its snapshot. Earlier captures and snapshots are never modified. Either all
 * captures are saved or none. IndexedDB serializes overlapping read-write
 * transactions, so concurrent captures cannot take the same S-number; unique
 * indexes reject duplicates as a second guard.
 */
export function commitCaptures(db: IDBDatabase, drafts: CaptureDraft[]): Promise<CommitResult[]> {
  return inTransaction(db, CAPTURE_STORES, 'readwrite', async (tx) => {
    const results: CommitResult[] = [];
    for (const draft of drafts) results.push(await addCapture(tx, draft));
    return results;
  });
}

export async function commitCapture(db: IDBDatabase, draft: CaptureDraft): Promise<CommitResult> {
  const [committed] = await commitCaptures(db, [draft]);
  return committed!;
}

async function addCapture(tx: IDBTransaction, draft: CaptureDraft): Promise<CommitResult> {
  const sessions = tx.objectStore('sessions');
  const sources = tx.objectStore('sources');
  const session = await getSession(tx, draft.session_id);

  let source = (await result(sources.index('session_dedup_url').get([session.id, draft.dedup_url]))) as
    | Source
    | undefined;
  const isNewSource = !source;
  // A visit is a return to a page the session has; it never makes a source by itself.
  if (!source && draft.kind === 'visit') throw new Error('A visit needs a source that already exists.');
  if (!source) {
    source = {
      id: crypto.randomUUID(),
      session_id: session.id,
      number: session.next_source_number,
      dedup_url: draft.dedup_url,
      created_at: draft.captured_at,
      note: '',
      merged_ids: [],
      important: false,
    };
    sessions.put({ ...session, next_source_number: session.next_source_number + 1 });
    sources.add(source);
  }

  const captureId = crypto.randomUUID();
  const snapshotId = draft.snapshot ? crypto.randomUUID() : null;
  const capture: Capture = {
    id: captureId,
    session_id: session.id,
    source_id: source.id,
    kind: draft.kind,
    captured_at: draft.captured_at,
    original_url: draft.original_url,
    tab_title: draft.tab_title,
    found_on: draft.found_on,
    anchor_text: draft.anchor_text,
    fragment: draft.fragment,
    frame: draft.frame ?? null,
    navigation: draft.navigation ?? null,
    snapshot_id: snapshotId,
    note: '',
  };
  tx.objectStore('captures').add(capture);
  let snapshot: Snapshot | null = null;
  if (draft.snapshot && snapshotId) {
    snapshot = {
      ...draft.snapshot,
      id: snapshotId,
      capture_id: captureId,
      source_id: source.id,
      session_id: session.id,
    } as Snapshot;
    const { meta, text } = splitSnapshot(snapshot);
    tx.objectStore('snapshots').add(meta);
    if (text) tx.objectStore(TEXT_STORE).add(text);
  }
  const all = (await result(tx.objectStore('captures').index('source').getAll(source.id))) as Capture[];
  return { source, capture, snapshot, isNewSource, captureCount: all.filter((c) => c.kind !== 'visit').length };
}

export interface UndoResult {
  /** False when the capture no longer exists (already undone). */
  removed: boolean;
  /** True when the source had no other captures and was removed; its S-number stays retired. */
  sourceRemoved: boolean;
}

/**
 * Removes a capture with its snapshot, text and thumbnail, and returns the
 * captures its source still has. Visits are returns to a page that was
 * opened: when only links saved without opening the page are left, the
 * visits go too. A source exists only while it has a capture other than a
 * visit: when none is left, the source goes and nothing is returned.
 */
async function removeCapture(tx: IDBTransaction, capture: Capture): Promise<Capture[]> {
  const captures = tx.objectStore('captures');
  if (capture.snapshot_id) {
    tx.objectStore('snapshots').delete(capture.snapshot_id);
    tx.objectStore(TEXT_STORE).delete(capture.snapshot_id);
  }
  tx.objectStore(THUMB_STORE).delete(capture.id);
  captures.delete(capture.id);
  const remaining = ((await result(captures.index('source').getAll(capture.source_id))) as Capture[]).filter((c) => c.id !== capture.id);
  if (remaining.some((c) => c.kind !== 'visit' && c.kind !== 'link')) return remaining;
  for (const visit of remaining.filter((c) => c.kind === 'visit')) captures.delete(visit.id);
  const links = remaining.filter((c) => c.kind === 'link');
  if (!links.length) tx.objectStore('sources').delete(capture.source_id);
  return links;
}

/** Removes exactly these captures and their snapshots in one transaction. Other captures of their sources stay untouched. */
export function undoCaptures(db: IDBDatabase, captureIds: string[]): Promise<UndoResult[]> {
  return inTransaction(db, ['captures', 'snapshots', TEXT_STORE, THUMB_STORE, 'sources'], 'readwrite', async (tx) => {
    const results: UndoResult[] = [];
    for (const captureId of captureIds) {
      const capture = (await result(tx.objectStore('captures').get(captureId))) as Capture | undefined;
      results.push(capture ? { removed: true, sourceRemoved: (await removeCapture(tx, capture)).length === 0 } : { removed: false, sourceRemoved: false });
    }
    return results;
  });
}

/** A capture saved by Save tabs or a recording, with the session it was saved to. */
export interface SavedCapture {
  capture_id: string;
  session_id: string;
}

/**
 * Undo of saved tabs or a recording, which can come long after the first
 * page was saved. Captures the user has worked on since stay: a capture with
 * a note, or one whose source has a note, is marked important or was moved to
 * another session. `stayed` counts the removed captures whose source stays
 * with other captures saved since, such as a clip of the page. Visits are
 * removed and not counted: they are not pages.
 */
export function undoSavedCaptures(db: IDBDatabase, saved: SavedCapture[]): Promise<{ removed: number; kept: number; stayed: number }> {
  return inTransaction(db, ['captures', 'snapshots', TEXT_STORE, THUMB_STORE, 'sources'], 'readwrite', async (tx) => {
    let removed = 0;
    let kept = 0;
    let stayed = 0;
    for (const { capture_id, session_id } of saved) {
      const capture = (await result(tx.objectStore('captures').get(capture_id))) as Capture | undefined;
      if (!capture) continue;
      if (capture.kind === 'visit') {
        await removeCapture(tx, capture);
        continue;
      }
      const source = (await result(tx.objectStore('sources').get(capture.source_id))) as Source | undefined;
      if (capture.note.trim() || source?.note.trim() || source?.important || capture.session_id !== session_id) {
        kept += 1;
        continue;
      }
      // Kept by a capture saved since, such as a clip; a link saved before does not count, the recorded page is gone.
      if ((await removeCapture(tx, capture)).some((c) => c.kind !== 'link')) stayed += 1;
      removed += 1;
    }
    return { removed, kept, stayed };
  });
}

/** A page saved by a recording, as it is stored now. */
export interface SavedPage {
  saved: SavedCapture;
  capture: Capture;
  source: Source;
}

/** The saved captures that still exist, in the given order, with their sources, in one consistent read. */
export function loadSavedPages(db: IDBDatabase, saved: SavedCapture[]): Promise<SavedPage[]> {
  return inTransaction(db, ['captures', 'sources'], 'readonly', async (tx) => {
    const pages: SavedPage[] = [];
    for (const item of saved) {
      const capture = (await result(tx.objectStore('captures').get(item.capture_id))) as Capture | undefined;
      const source = capture && ((await result(tx.objectStore('sources').get(capture.source_id))) as Source | undefined);
      if (capture && source) pages.push({ saved: item, capture, source });
    }
    return pages;
  });
}

export async function undoCapture(db: IDBDatabase, captureId: string): Promise<UndoResult> {
  const [undone] = await undoCaptures(db, [captureId]);
  return undone!;
}

// Moving sources

export interface MoveResult {
  /** The source in the target session: the moved source with its new S-number, or the source it joined. */
  source: Source;
  /** True when the target session already had a source with the same address and the captures joined it. */
  joined: boolean;
}

function joinNotes(...notes: string[]): string {
  return notes.filter((note) => note.trim()).join('\n\n');
}

/**
 * Moves a source with all its captures and snapshots to another session in
 * one transaction. It gets the next S-number there, or joins the source with
 * the same address (keeping that source's label, with both notes). The old
 * S-number stays retired in the original session.
 */
export function moveSource(db: IDBDatabase, sourceId: string, targetSessionId: string): Promise<MoveResult> {
  return inTransaction(db, CAPTURE_STORES, 'readwrite', async (tx) => {
    const sources = tx.objectStore('sources');
    const source = (await result(sources.get(sourceId))) as Source | undefined;
    if (!source) throw new Error('This source no longer exists.');
    if (source.session_id === targetSessionId) throw new Error('The source is already in this session.');
    const target = await getSession(tx, targetSessionId);
    const existing = (await result(sources.index('session_dedup_url').get([target.id, source.dedup_url]))) as
      | Source
      | undefined;
    let moved: Source;
    if (existing) {
      const mergedIds = new Set([...existing.merged_ids, source.id, ...source.merged_ids]);
      mergedIds.delete(existing.id);
      moved = { ...existing, note: joinNotes(existing.note, source.note), merged_ids: [...mergedIds], important: existing.important || source.important };
      sources.delete(source.id);
    } else {
      moved = { ...source, session_id: target.id, number: target.next_source_number };
      tx.objectStore('sessions').put({ ...target, next_source_number: target.next_source_number + 1 });
    }
    sources.put(moved);
    const captures = tx.objectStore('captures');
    const snapshots = tx.objectStore('snapshots');
    for (const capture of (await result(captures.index('source').getAll(source.id))) as Capture[]) {
      captures.put({ ...capture, source_id: moved.id, session_id: target.id });
      if (!capture.snapshot_id) continue;
      // Text records are keyed by snapshot only, so they stay as they are.
      const snapshot = (await result(snapshots.get(capture.snapshot_id))) as SnapshotMeta | undefined;
      if (snapshot) snapshots.put({ ...snapshot, source_id: moved.id, session_id: target.id });
    }
    return { source: moved, joined: !!existing };
  });
}

// Deleting

/** What a deletion removed, or would remove. */
export interface DeletionCounts {
  sources: number;
  captures: number;
  jobs: number;
}

/** Research Jobs of a session. */
async function sessionJobs(tx: IDBTransaction, sessionId: string): Promise<ResearchJob[]> {
  const range = IDBKeyRange.bound([sessionId, ''], [sessionId, '\uffff']);
  return (await result(tx.objectStore('jobs').index('session_created').getAll(range))) as ResearchJob[];
}

/**
 * Research Jobs of any session that include one of these sources: by its ID,
 * by the ID of a source that joined it (jobs keep the IDs they were generated
 * with), or by a copy of the text of one of these captures. A source moved to
 * another session keeps its place in the jobs of its former session. Reads
 * one job at a time.
 */
function jobsIncluding(tx: IDBTransaction, sources: Source[], captures: Capture[]): Promise<ResearchJob[]> {
  const sourceIds = new Set(sources.flatMap((source) => [source.id, ...source.merged_ids]));
  const captureIds = new Set(captures.map((c) => c.id));
  const snapshotIds = new Set(captures.flatMap((c) => (c.snapshot_id ? [c.snapshot_id] : [])));
  const includes = (job: ResearchJob) =>
    job.sources.some(
      (s) =>
        sourceIds.has(s.source_id) ||
        (s.snapshot !== null && snapshotIds.has(s.snapshot.snapshot_id)) ||
        s.selections.some((selection) => captureIds.has(selection.capture_id)),
    );
  return new Promise((resolve, reject) => {
    const found: ResearchJob[] = [];
    const request = tx.objectStore('jobs').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(found);
      if (includes(cursor.value as ResearchJob)) found.push(cursor.value as ResearchJob);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Captures other than visits: what the user saved. */
const savedCount = (captures: Capture[]) => captures.filter((c) => c.kind !== 'visit').length;

/** All captures of these sources. */
async function capturesOf(tx: IDBTransaction, sourceIds: string[]): Promise<Capture[]> {
  const index = tx.objectStore('captures').index('source');
  return (await Promise.all(sourceIds.map((id) => result(index.getAll(id)) as Promise<Capture[]>))).flat();
}

/** Deletes captures with their snapshots and texts. */
function deleteCaptures(tx: IDBTransaction, captures: Capture[]): void {
  for (const capture of captures) {
    if (capture.snapshot_id) {
      tx.objectStore('snapshots').delete(capture.snapshot_id);
      tx.objectStore(TEXT_STORE).delete(capture.snapshot_id);
    }
    tx.objectStore(THUMB_STORE).delete(capture.id);
    tx.objectStore('captures').delete(capture.id);
  }
}

/**
 * Deletes a source with all its captures, snapshots, texts and its note, and
 * the Research Jobs that include it, in any session. The session's next
 * S-number is unchanged, so the source's label is never given to another source.
 */
export function deleteSource(db: IDBDatabase, sourceId: string): Promise<DeletionCounts> {
  return inTransaction(db, [...CAPTURE_STORES, 'jobs'], 'readwrite', async (tx) => {
    const source = (await result(tx.objectStore('sources').get(sourceId))) as Source | undefined;
    if (!source) throw new Error('This source no longer exists.');
    return removeSources(tx, [source]);
  });
}

/** Deletes several sources in one transaction, as deleteSource does; sources already gone are skipped. */
export function deleteSources(db: IDBDatabase, sourceIds: string[]): Promise<DeletionCounts> {
  return inTransaction(db, [...CAPTURE_STORES, 'jobs'], 'readwrite', async (tx) => {
    const found = await Promise.all([...new Set(sourceIds)].map((id) => result(tx.objectStore('sources').get(id)) as Promise<Source | undefined>));
    return removeSources(tx, found.filter((source): source is Source => !!source));
  });
}

async function removeSources(tx: IDBTransaction, sources: Source[]): Promise<DeletionCounts> {
  const ids = sources.map((source) => source.id);
  const captures = await capturesOf(tx, ids);
  const jobs = await jobsIncluding(tx, sources, captures);
  deleteCaptures(tx, captures);
  for (const job of jobs) tx.objectStore('jobs').delete(job.id);
  for (const id of ids) tx.objectStore('sources').delete(id);
  return { sources: ids.length, captures: savedCount(captures), jobs: jobs.length };
}

/** A session's sources and captures, and the Research Jobs that deleting them removes: its own and any other that includes one of its sources. */
async function sessionContents(tx: IDBTransaction, sessionId: string): Promise<{ sourceIds: string[]; captures: Capture[]; jobIds: Set<string> }> {
  const sources = (await result(tx.objectStore('sources').index('session').getAll(sessionId))) as Source[];
  const captures = (await result(tx.objectStore('captures').index('session').getAll(sessionId))) as Capture[];
  const jobs = [...(await sessionJobs(tx, sessionId)), ...(await jobsIncluding(tx, sources, captures))];
  return { sourceIds: sources.map((source) => source.id), captures, jobIds: new Set(jobs.map((job) => job.id)) };
}

/** Deletes every source, capture, snapshot, text and Research Job of a session; the session record stays. */
async function clearSession(tx: IDBTransaction, sessionId: string): Promise<DeletionCounts> {
  const { sourceIds, captures, jobIds } = await sessionContents(tx, sessionId);
  deleteCaptures(tx, captures);
  for (const id of sourceIds) tx.objectStore('sources').delete(id);
  for (const id of jobIds) tx.objectStore('jobs').delete(id);
  return { sources: sourceIds.length, captures: savedCount(captures), jobs: jobIds.size };
}

/** Deletes a session with everything in it, including its Research Jobs. The Inbox can only be emptied. */
export function deleteSession(db: IDBDatabase, sessionId: string): Promise<DeletionCounts> {
  if (sessionId === INBOX_SESSION_ID) return Promise.reject(new Error('The Inbox cannot be deleted. Empty it instead.'));
  return inTransaction(db, [...CAPTURE_STORES, 'jobs'], 'readwrite', async (tx) => {
    await getSession(tx, sessionId);
    const removed = await clearSession(tx, sessionId);
    tx.objectStore('sessions').delete(sessionId);
    return removed;
  });
}

/** Deletes everything in the Inbox. The Inbox stays with its prompt, notes and S-number counter. */
export function emptyInbox(db: IDBDatabase): Promise<DeletionCounts> {
  return inTransaction(db, [...CAPTURE_STORES, 'jobs'], 'readwrite', (tx) => clearSession(tx, INBOX_SESSION_ID));
}

/** What deleting a source (with `sourceId`) or a whole session would remove, for the confirmation. */
export function countForDeletion(db: IDBDatabase, sessionId: string, sourceId?: string): Promise<DeletionCounts> {
  if (sourceId !== undefined) return countSourcesForDeletion(db, [sourceId]);
  return inTransaction(db, ['sources', 'captures', 'jobs'], 'readonly', async (tx) => {
    const { sourceIds, captures, jobIds } = await sessionContents(tx, sessionId);
    return { sources: sourceIds.length, captures: savedCount(captures), jobs: jobIds.size };
  });
}

/** What deleting these sources would remove; a Research Job that includes several of them counts once. */
export function countSourcesForDeletion(db: IDBDatabase, sourceIds: string[]): Promise<DeletionCounts> {
  return inTransaction(db, ['sources', 'captures', 'jobs'], 'readonly', async (tx) => {
    const found = await Promise.all([...new Set(sourceIds)].map((id) => result(tx.objectStore('sources').get(id)) as Promise<Source | undefined>));
    const sources = found.filter((source): source is Source => !!source);
    const captures = await capturesOf(tx, sources.map((source) => source.id));
    const jobs = await jobsIncluding(tx, sources, captures);
    return { sources: sources.length, captures: savedCount(captures), jobs: jobs.length };
  });
}

export interface DataSummary {
  sessions: number;
  sources: number;
  captures: number;
  /** Characters of saved text: successful snapshots plus selections. */
  characters: number;
}

/** Totals of everything stored, for the side panel menu. Reads snapshot metadata, not snapshot texts. */
export function summarizeData(db: IDBDatabase): Promise<DataSummary> {
  return inTransaction(db, ['sessions', 'sources', 'captures', 'snapshots'], 'readonly', async (tx) => {
    const [sessions, sources, captures, snapshots] = await Promise.all([
      result(tx.objectStore('sessions').count()),
      result(tx.objectStore('sources').count()),
      result(tx.objectStore('captures').getAll()) as Promise<Capture[]>,
      result(tx.objectStore('snapshots').getAll()) as Promise<SnapshotMeta[]>,
    ]);
    const characters =
      snapshots.reduce((sum, s) => sum + (s.status === 'ok' ? s.character_count : 0), 0) +
      captures.reduce((sum, c) => sum + (c.fragment?.character_count ?? 0), 0);
    return { sessions, sources, captures: savedCount(captures), characters };
  });
}

// Reading

/** A capture with its snapshot: with the snapshot text by default, or only its metadata (library lists). */
export interface CaptureEntry<S extends SnapshotMeta = Snapshot> {
  capture: Capture;
  snapshot: S | undefined;
}

export interface SourceEntry<S extends SnapshotMeta = Snapshot> {
  source: Source;
  /** Oldest first, visits not included. */
  captures: CaptureEntry<S>[];
  /** Recorded returns to the page, oldest first. */
  visits: Capture[];
}

export interface SessionView {
  session: Session;
  /** Ordered by S-number. */
  sources: SourceEntry[];
}

/** Groups captures with their snapshots under their sources, captures and visits oldest first and sources by S-number. */
function groupSources<S extends SnapshotMeta>(sources: Source[], captures: Capture[], snapshots: S[]): SourceEntry<S>[] {
  const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
  const bySource = new Map<string, CaptureEntry<S>[]>();
  const visits = new Map<string, Capture[]>();
  for (const capture of captures) {
    if (capture.kind === 'visit') {
      visits.set(capture.source_id, [...(visits.get(capture.source_id) ?? []), capture]);
      continue;
    }
    const list = bySource.get(capture.source_id) ?? [];
    list.push({ capture, snapshot: capture.snapshot_id ? snapshotById.get(capture.snapshot_id) : undefined });
    bySource.set(capture.source_id, list);
  }
  const ordered = (a: CaptureEntry<S>, b: CaptureEntry<S>) =>
    a.capture.captured_at.localeCompare(b.capture.captured_at) || a.capture.id.localeCompare(b.capture.id);
  return sources
    .sort((a, b) => a.number - b.number)
    .map((source) => ({
      source,
      captures: (bySource.get(source.id) ?? []).sort(ordered),
      visits: (visits.get(source.id) ?? []).sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.id.localeCompare(b.id)),
    }));
}

/**
 * A successful snapshot whose text is not in the database (damaged data) reads as a failed snapshot that says so,
 * so one damaged record neither passes for saved text nor stops the panel, a backup or a restore.
 */
function textMissing(snapshot: OkSnapshotMeta): FailedSnapshot {
  const { id, capture_id, source_id, session_id, captured_at, http_status } = snapshot;
  return {
    id, capture_id, source_id, session_id, captured_at, http_status,
    status: 'failed',
    error_code: 'text_missing',
    error_message: 'The saved text of this capture is missing from the browser database.',
  };
}

/** Adds the stored text to each successful snapshot. */
async function withTexts(tx: IDBTransaction, snapshots: SnapshotMeta[]): Promise<Snapshot[]> {
  const texts = tx.objectStore(TEXT_STORE);
  return Promise.all(
    snapshots.map(async (snapshot) => {
      if (snapshot.status !== 'ok') return snapshot;
      const record = (await result(texts.get(snapshot.id))) as SnapshotText | undefined;
      return record ? { ...snapshot, text: record.text } : textMissing(snapshot);
    }),
  );
}

/** Reads a session with all its sources, captures and snapshots (with their texts) in one consistent read. */
export function loadSessionView(db: IDBDatabase, sessionId: string): Promise<SessionView> {
  return inTransaction(db, CAPTURE_STORES, 'readonly', async (tx) => {
    const session = await getSession(tx, sessionId);
    const [sources, captures, snapshots] = await Promise.all([
      result(tx.objectStore('sources').index('session').getAll(sessionId)) as Promise<Source[]>,
      result(tx.objectStore('captures').index('session').getAll(sessionId)) as Promise<Capture[]>,
      result(tx.objectStore('snapshots').index('session').getAll(sessionId)) as Promise<SnapshotMeta[]>,
    ]);
    return { session, sources: groupSources(sources, captures, await withTexts(tx, snapshots)) };
  });
}

export interface LibraryData {
  /** Inbox first, then by creation time. */
  sessions: Session[];
  /** Sources of all sessions, with snapshot metadata but without snapshot texts. */
  sources: SourceEntry<SnapshotMeta>[];
}

/** Reads every session and source with captures and snapshot metadata, without any snapshot text, in one consistent read. */
export function loadLibrary(db: IDBDatabase): Promise<LibraryData> {
  return inTransaction(db, ['sessions', 'sources', 'captures', 'snapshots', TEXT_STORE], 'readonly', async (tx) => {
    const [sessions, sources, captures, snapshots, textIds] = await Promise.all([
      result(tx.objectStore('sessions').getAll()) as Promise<Session[]>,
      result(tx.objectStore('sources').getAll()) as Promise<Source[]>,
      result(tx.objectStore('captures').getAll()) as Promise<Capture[]>,
      result(tx.objectStore('snapshots').getAll()) as Promise<SnapshotMeta[]>,
      // Keys only: the texts themselves are read one at a time, when a source is opened.
      result(tx.objectStore(TEXT_STORE).getAllKeys()).then((keys) => new Set(keys as string[])),
    ]);
    const checked = snapshots.map((s) => (s.status === 'ok' && !textIds.has(s.id) ? textMissing(s) : s));
    return { sessions: sortSessions(sessions), sources: groupSources(sources, captures, checked) };
  });
}

/** Saved texts read per transaction by visitSnapshotTexts, so a capture never waits long behind a search. */
const TEXT_BATCH = 100;

/**
 * Reads the saved texts of the given snapshots one at a time and hands each to
 * `visit`, which returns false to stop. Only one text is held at a time.
 */
export async function visitSnapshotTexts(db: IDBDatabase, snapshotIds: string[], visit: (snapshotId: string, text: string) => boolean): Promise<void> {
  for (let i = 0; i < snapshotIds.length; i += TEXT_BATCH) {
    const go = await inTransaction(db, [TEXT_STORE], 'readonly', async (tx) => {
      const store = tx.objectStore(TEXT_STORE);
      for (const id of snapshotIds.slice(i, i + TEXT_BATCH)) {
        const record = (await result(store.get(id))) as SnapshotText | undefined;
        if (record && !visit(id, record.text)) return false;
      }
      return true;
    });
    if (!go) return;
  }
}

/** The saved text of one successful snapshot, or undefined if the snapshot has none. */
export function loadSnapshotText(db: IDBDatabase, snapshotId: string): Promise<string | undefined> {
  return inTransaction(db, [TEXT_STORE], 'readonly', async (tx) => {
    const record = (await result(tx.objectStore(TEXT_STORE).get(snapshotId))) as SnapshotText | undefined;
    return record?.text;
  });
}

/** Number of sources in each session, keyed by session ID (sessions without sources are missing). */
export function countSourcesBySession(db: IDBDatabase): Promise<Map<string, number>> {
  return inTransaction(db, ['sources'], 'readonly', async (tx) => {
    const counts = new Map<string, number>();
    for (const source of (await result(tx.objectStore('sources').getAll())) as Source[]) {
      counts.set(source.session_id, (counts.get(source.session_id) ?? 0) + 1);
    }
    return counts;
  });
}

// Research Jobs

/** Stores a generated Research Job. Jobs are never modified afterwards. */
export function saveJob(db: IDBDatabase, job: ResearchJob): Promise<ResearchJob> {
  return inTransaction(db, ['jobs'], 'readwrite', async (tx) => {
    tx.objectStore('jobs').add(job);
    return job;
  });
}

export function latestJob(db: IDBDatabase, sessionId: string): Promise<ResearchJob | undefined> {
  return inTransaction(db, ['jobs'], 'readonly', async (tx) => {
    const range = IDBKeyRange.bound([sessionId, ''], [sessionId, '￿']);
    const cursor = await result(tx.objectStore('jobs').index('session_created').openCursor(range, 'prev'));
    return (cursor?.value as ResearchJob | undefined) ?? undefined;
  });
}

// Backup and restore

export type DataSnapshot = { [K in DataStore]: unknown[] };

/**
 * Reads every record of every data store in one consistent read, one record
 * at a time and store by store in DATA_STORES order, successful snapshots with
 * their texts. A backup is written from it without holding all records at
 * once. An error thrown by `visit` stops the read.
 */
export function visitAllData(db: IDBDatabase, visit: (store: DataStore, record: unknown) => void): Promise<void> {
  return inTransaction(db, [...DATA_STORES, TEXT_STORE], 'readonly', async (tx) => {
    const texts = tx.objectStore(TEXT_STORE);
    for (const store of DATA_STORES) {
      await new Promise<void>((resolve, reject) => {
        const request = tx.objectStore(store).openCursor();
        const next = (cursor: IDBCursorWithValue, record: unknown) => {
          try {
            visit(store, record);
            cursor.continue();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const value = cursor.value as SnapshotMeta;
          if (store !== 'snapshots' || value.status !== 'ok') return next(cursor, cursor.value);
          const text = texts.get(value.id);
          text.onsuccess = () => {
            const record = text.result as SnapshotText | undefined;
            next(cursor, record ? { ...value, text: record.text } : textMissing(value));
          };
          text.onerror = () => reject(text.error ?? new Error('IndexedDB request failed.'));
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
      });
    }
  });
}

/** Reads every record of every data store in one consistent read. */
export async function readAllData(db: IDBDatabase): Promise<DataSnapshot> {
  const data = Object.fromEntries(DATA_STORES.map((store) => [store, [] as unknown[]])) as DataSnapshot;
  await visitAllData(db, (store, record) => data[store].push(record));
  return data;
}

/**
 * Replaces all data in one transaction. If any record is rejected the
 * transaction aborts and the previous data stays exactly as it was.
 * A session that exists now keeps the higher of its two next S-numbers, so
 * labels given out after an older backup are never given to other sources.
 */
export function replaceAllData(db: IDBDatabase, data: DataSnapshot): Promise<void> {
  // Thumbnails are not in backups; the ones of the replaced data go with it.
  return inTransaction(db, [...DATA_STORES, TEXT_STORE, THUMB_STORE], 'readwrite', async (tx) => {
    const current = new Map(
      ((await result(tx.objectStore('sessions').getAll())) as Session[]).map((s) => [s.id, s.next_source_number]),
    );
    for (const store of [...DATA_STORES, TEXT_STORE, THUMB_STORE]) tx.objectStore(store).clear();
    for (const store of DATA_STORES) {
      if (store === 'snapshots') continue;
      for (const record of data[store]) {
        if (store !== 'sessions') {
          tx.objectStore(store).add(record);
          continue;
        }
        const session = record as Session;
        const next = Math.max(session.next_source_number, current.get(session.id) ?? 0);
        tx.objectStore(store).add({ ...session, next_source_number: next });
      }
    }
    for (const snapshot of data.snapshots as Snapshot[]) {
      const { meta, text } = splitSnapshot(snapshot);
      tx.objectStore('snapshots').add(meta);
      if (text) tx.objectStore(TEXT_STORE).add(text);
    }
  });
}

// Thumbnails

interface Thumbnail {
  capture_id: string;
  /** A JPEG data URL. */
  image: string;
  created_at: string;
}

/** Stores the thumbnail of a capture, unless the capture was undone or deleted meanwhile. */
export function saveThumbnail(db: IDBDatabase, captureId: string, image: string): Promise<void> {
  return inTransaction(db, ['captures', THUMB_STORE], 'readwrite', async (tx) => {
    if (!(await result(tx.objectStore('captures').get(captureId)))) return;
    const record: Thumbnail = { capture_id: captureId, image, created_at: new Date().toISOString() };
    tx.objectStore(THUMB_STORE).put(record);
  });
}

/** The ids of the captures that have a thumbnail. */
export async function thumbnailIds(db: IDBDatabase): Promise<Set<string>> {
  return inTransaction(db, [THUMB_STORE], 'readonly', async (tx) => new Set((await result(tx.objectStore(THUMB_STORE).getAllKeys())) as string[]));
}

export function loadThumbnail(db: IDBDatabase, captureId: string): Promise<string | null> {
  return inTransaction(db, [THUMB_STORE], 'readonly', async (tx) => ((await result(tx.objectStore(THUMB_STORE).get(captureId))) as Thumbnail | undefined)?.image ?? null);
}
