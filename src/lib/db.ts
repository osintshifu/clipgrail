import { INBOX_SESSION_ID } from './model';
import type { Capture, CaptureKind, Fragment, Session, Snapshot, Source } from './model';
import type { ResearchJob } from './research-job';
import type { SnapshotDraft } from './snapshot';

export const DB_NAME = 'clipgrail';
export const DB_SCHEMA_VERSION = 1;
export const DATA_STORES = ['sessions', 'sources', 'captures', 'snapshots', 'jobs'] as const;
export type DataStore = (typeof DATA_STORES)[number];
const CAPTURE_STORES = ['sessions', 'sources', 'captures', 'snapshots'] as const;

export function newInboxSession(createdAt: string): Session {
  return { id: INBOX_SESSION_ID, name: 'Inbox', created_at: createdAt, next_source_number: 1, prompt: '', notes: '' };
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
  return value;
}

async function getSession(tx: IDBTransaction, id: string): Promise<Session> {
  const session = (await result(tx.objectStore('sessions').get(id))) as Session | undefined;
  if (!session) throw new Error(`Session "${id}" does not exist.`);
  return session;
}

// Sessions

export function listSessions(db: IDBDatabase): Promise<Session[]> {
  return inTransaction(db, ['sessions'], 'readonly', async (tx) => {
    const sessions = (await result(tx.objectStore('sessions').getAll())) as Session[];
    // Inbox first, then by creation time.
    return sessions.sort(
      (a, b) =>
        Number(b.id === INBOX_SESSION_ID) - Number(a.id === INBOX_SESSION_ID) || a.created_at.localeCompare(b.created_at),
    );
  });
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
  /** Required for page and link captures, absent for selections. */
  snapshot: SnapshotDraft | null;
}

export interface CommitResult {
  source: Source;
  capture: Capture;
  snapshot: Snapshot | null;
  isNewSource: boolean;
  /** Number of captures of this source after this one was added. */
  captureCount: number;
}

/**
 * Saves one capture atomically: finds the session's source by dedup URL or
 * creates it with the next S-number, then adds the capture and its snapshot.
 * Earlier captures and snapshots are never modified. IndexedDB serializes
 * overlapping read-write transactions, so concurrent captures cannot take
 * the same S-number; unique indexes reject duplicates as a second guard.
 */
export function commitCapture(db: IDBDatabase, draft: CaptureDraft): Promise<CommitResult> {
  return inTransaction(db, CAPTURE_STORES, 'readwrite', async (tx) => {
    const sessions = tx.objectStore('sessions');
    const sources = tx.objectStore('sources');
    const session = await getSession(tx, draft.session_id);

    let source = (await result(sources.index('session_dedup_url').get([session.id, draft.dedup_url]))) as
      | Source
      | undefined;
    const isNewSource = !source;
    if (!source) {
      source = {
        id: crypto.randomUUID(),
        session_id: session.id,
        number: session.next_source_number,
        dedup_url: draft.dedup_url,
        created_at: draft.captured_at,
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
      tx.objectStore('snapshots').add(snapshot);
    }
    const captureCount = await result(tx.objectStore('captures').index('source').count(source.id));
    return { source, capture, snapshot, isNewSource, captureCount };
  });
}

export interface UndoResult {
  /** False when the capture no longer exists (already undone). */
  removed: boolean;
  /** True when the source had no other captures and was removed; its S-number stays retired. */
  sourceRemoved: boolean;
}

/** Removes exactly one capture and its snapshot. Other captures of the source stay untouched. */
export function undoCapture(db: IDBDatabase, captureId: string): Promise<UndoResult> {
  return inTransaction(db, ['captures', 'snapshots', 'sources'], 'readwrite', async (tx) => {
    const captures = tx.objectStore('captures');
    const capture = (await result(captures.get(captureId))) as Capture | undefined;
    if (!capture) return { removed: false, sourceRemoved: false };
    if (capture.snapshot_id) tx.objectStore('snapshots').delete(capture.snapshot_id);
    captures.delete(capture.id);
    const remaining = await result(captures.index('source').count(capture.source_id));
    if (remaining === 0) tx.objectStore('sources').delete(capture.source_id);
    return { removed: true, sourceRemoved: remaining === 0 };
  });
}

// Reading

export interface CaptureEntry {
  capture: Capture;
  snapshot: Snapshot | undefined;
}

export interface SourceEntry {
  source: Source;
  /** Oldest first. */
  captures: CaptureEntry[];
}

export interface SessionView {
  session: Session;
  /** Ordered by S-number. */
  sources: SourceEntry[];
}

/** Reads a session with all its sources, captures and snapshots in one consistent read. */
export function loadSessionView(db: IDBDatabase, sessionId: string): Promise<SessionView> {
  return inTransaction(db, CAPTURE_STORES, 'readonly', async (tx) => {
    const session = await getSession(tx, sessionId);
    const [sources, captures, snapshots] = await Promise.all([
      result(tx.objectStore('sources').index('session').getAll(sessionId)) as Promise<Source[]>,
      result(tx.objectStore('captures').index('session').getAll(sessionId)) as Promise<Capture[]>,
      result(tx.objectStore('snapshots').index('session').getAll(sessionId)) as Promise<Snapshot[]>,
    ]);
    const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
    const bySource = new Map<string, CaptureEntry[]>();
    for (const capture of captures) {
      const list = bySource.get(capture.source_id) ?? [];
      list.push({ capture, snapshot: capture.snapshot_id ? snapshotById.get(capture.snapshot_id) : undefined });
      bySource.set(capture.source_id, list);
    }
    const ordered = (a: CaptureEntry, b: CaptureEntry) =>
      a.capture.captured_at.localeCompare(b.capture.captured_at) || a.capture.id.localeCompare(b.capture.id);
    return {
      session,
      sources: sources
        .sort((a, b) => a.number - b.number)
        .map((source) => ({ source, captures: (bySource.get(source.id) ?? []).sort(ordered) })),
    };
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

/** Reads every record of every data store in one consistent read. */
export function readAllData(db: IDBDatabase): Promise<DataSnapshot> {
  return inTransaction(db, DATA_STORES, 'readonly', async (tx) => {
    const entries = await Promise.all(
      DATA_STORES.map(async (store) => [store, await result(tx.objectStore(store).getAll())] as const),
    );
    return Object.fromEntries(entries) as DataSnapshot;
  });
}

/**
 * Replaces all data in one transaction. If any record is rejected the
 * transaction aborts and the previous data stays exactly as it was.
 */
export function replaceAllData(db: IDBDatabase, data: DataSnapshot): Promise<void> {
  return inTransaction(db, DATA_STORES, 'readwrite', async (tx) => {
    for (const store of DATA_STORES) tx.objectStore(store).clear();
    for (const store of DATA_STORES) {
      for (const record of data[store]) tx.objectStore(store).add(record);
    }
  });
}
