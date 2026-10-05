import type { DataSnapshot } from './db';
import { DATA_STORES, DB_SCHEMA_VERSION } from './db';
import { INBOX_SESSION_ID } from './model';
import type { Capture, Session, Snapshot, Source } from './model';
import type { Preset } from './settings';
import { mergePresets } from './settings';
import { sha256Hex } from './snapshot';
import { countCharacters } from './text';

export const BACKUP_FORMAT = 'clipgrail-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupSettings {
  active_session_id: string;
  presets: Preset[];
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  format_version: typeof BACKUP_FORMAT_VERSION;
  db_schema_version: number;
  created_at: string;
  data: DataSnapshot;
  settings: BackupSettings;
}

export interface BackupSummary {
  created_at: string;
  sessions: number;
  sources: number;
  captures: number;
  snapshots: number;
  jobs: number;
}

export function createBackup(data: DataSnapshot, settings: BackupSettings, createdAt: string): Backup {
  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    db_schema_version: DB_SCHEMA_VERSION,
    created_at: createdAt,
    data,
    settings,
  };
}

/** File name with the local date and time, for example clipgrail-backup-20261005-1430.json. */
export function backupFileName(createdAt: string): string {
  const d = new Date(createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `clipgrail-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

export function summarize(data: DataSnapshot, createdAt: string): BackupSummary {
  return {
    created_at: createdAt,
    sessions: data.sessions.length,
    sources: data.sources.length,
    captures: data.captures.length,
    snapshots: data.snapshots.length,
    jobs: data.jobs.length,
  };
}

class Invalid extends Error {}

type Rec = Record<string, unknown>;
function obj(value: unknown, where: string): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid(`${where} is not an object.`);
  return value as Rec;
}
function str(r: Rec, key: string, where: string, allowEmpty = true): string {
  const v = r[key];
  if (typeof v !== 'string' || (!allowEmpty && !v)) throw new Invalid(`${where}: "${key}" must be a${allowEmpty ? '' : ' non-empty'} string.`);
  return v;
}
function strOrNull(r: Rec, key: string, where: string): string | null {
  const v = r[key];
  if (v !== null && typeof v !== 'string') throw new Invalid(`${where}: "${key}" must be a string or null.`);
  return v;
}
function int(r: Rec, key: string, where: string, min = 0): number {
  const v = r[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Invalid(`${where}: "${key}" must be an integer ≥ ${min}.`);
  return v;
}
function intOrNull(r: Rec, key: string, where: string): number | null {
  return r[key] === null ? null : int(r, key, where);
}
function bool(r: Rec, key: string, where: string): boolean {
  if (typeof r[key] !== 'boolean') throw new Invalid(`${where}: "${key}" must be true or false.`);
  return r[key] as boolean;
}
function oneOf<T extends string>(r: Rec, key: string, values: readonly T[], where: string): T {
  const v = r[key];
  if (typeof v !== 'string' || !values.includes(v as T)) throw new Invalid(`${where}: "${key}" has an unsupported value.`);
  return v as T;
}
function uniqueIds(records: Rec[], where: string): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const r of records) {
    const id = str(r, 'id', where, false);
    if (map.has(id)) throw new Invalid(`${where}: duplicate id ${id}.`);
    map.set(id, r);
  }
  return map;
}

async function checkText(text: string, sha256: string, characterCount: number, where: string): Promise<void> {
  if (text !== text.toWellFormed()) throw new Invalid(`${where}: text is not well-formed Unicode.`);
  if (countCharacters(text) !== characterCount) throw new Invalid(`${where}: character_count does not match the text.`);
  if ((await sha256Hex(text)) !== sha256) throw new Invalid(`${where}: text does not match its SHA-256.`);
}

export type BackupCheck =
  | { ok: true; backup: Backup; summary: BackupSummary }
  | { ok: false; error: string };

/**
 * Parses and fully validates a backup before anything is written: format and
 * version, every record's fields, references between records, S-number
 * rules, and the SHA-256 and character count of every stored text.
 */
export async function validateBackup(json: string): Promise<BackupCheck> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Invalid('The file is not valid JSON.');
    }
    const root = obj(parsed, 'Backup');
    if (root.format !== BACKUP_FORMAT) throw new Invalid('This file is not a ClipGrail backup.');
    if (root.format_version !== BACKUP_FORMAT_VERSION) {
      throw new Invalid(`Unsupported backup format version ${String(root.format_version)}.`);
    }
    if (root.db_schema_version !== DB_SCHEMA_VERSION) {
      throw new Invalid(`Unsupported database schema version ${String(root.db_schema_version)}.`);
    }
    const createdAt = str(root, 'created_at', 'Backup', false);
    const dataRoot = obj(root.data, 'Backup data');
    const data = {} as Record<(typeof DATA_STORES)[number], Rec[]>;
    for (const store of DATA_STORES) {
      const list = dataRoot[store];
      if (!Array.isArray(list)) throw new Invalid(`Backup data: "${store}" must be a list.`);
      data[store] = list.map((item, i) => obj(item, `${store}[${i}]`));
    }

    const sessions = uniqueIds(data.sessions, 'sessions');
    if (!sessions.has(INBOX_SESSION_ID)) throw new Invalid('The backup has no Inbox session.');
    for (const s of sessions.values()) {
      const where = `session ${String(s.id)}`;
      str(s, 'name', where, false);
      str(s, 'created_at', where, false);
      int(s, 'next_source_number', where, 1);
      str(s, 'prompt', where);
      str(s, 'notes', where);
    }

    const sources = uniqueIds(data.sources, 'sources');
    const numbers = new Set<string>();
    const dedupUrls = new Set<string>();
    for (const s of sources.values()) {
      const where = `source ${String(s.id)}`;
      const sessionId = str(s, 'session_id', where, false);
      const session = sessions.get(sessionId);
      if (!session) throw new Invalid(`${where}: unknown session.`);
      const number = int(s, 'number', where, 1);
      if (number >= (session.next_source_number as number)) throw new Invalid(`${where}: S${number} is not below the session's next number.`);
      const numberKey = `${sessionId}\u0000${number}`;
      const urlKey = `${sessionId}\u0000${str(s, 'dedup_url', where, false)}`;
      if (numbers.has(numberKey)) throw new Invalid(`${where}: S${number} is used twice in one session.`);
      if (dedupUrls.has(urlKey)) throw new Invalid(`${where}: the URL appears twice in one session.`);
      numbers.add(numberKey);
      dedupUrls.add(urlKey);
      str(s, 'created_at', where, false);
    }

    const snapshots = uniqueIds(data.snapshots, 'snapshots');
    const captures = uniqueIds(data.captures, 'captures');
    const usedSnapshots = new Set<string>();
    for (const c of captures.values()) {
      const where = `capture ${String(c.id)}`;
      const source = sources.get(str(c, 'source_id', where, false));
      if (!source || source.session_id !== c.session_id) throw new Invalid(`${where}: unknown source or session mismatch.`);
      const kind = oneOf(c, 'kind', ['page', 'selection', 'link'] as const, where);
      str(c, 'captured_at', where, false);
      str(c, 'original_url', where, false);
      str(c, 'tab_title', where);
      strOrNull(c, 'found_on', where);
      strOrNull(c, 'anchor_text', where);
      str(c, 'note', where);
      const snapshotId = strOrNull(c, 'snapshot_id', where);
      if (kind === 'selection') {
        if (snapshotId !== null) throw new Invalid(`${where}: a selection capture cannot have a snapshot.`);
        const f = obj(c.fragment, `${where} fragment`);
        oneOf(f, 'method', ['dom-selection', 'menu-selection-text'] as const, where);
        bool(f, 'truncated', where);
        int(f, 'original_character_count', where);
        await checkText(str(f, 'text', where, false), str(f, 'sha256', where), int(f, 'character_count', where, 1), `${where} fragment`);
      } else {
        if (c.fragment !== null) throw new Invalid(`${where}: only selection captures have a fragment.`);
        if (!snapshotId) throw new Invalid(`${where}: missing snapshot.`);
        const snapshot = snapshots.get(snapshotId);
        if (!snapshot || snapshot.capture_id !== c.id || snapshot.source_id !== c.source_id || snapshot.session_id !== c.session_id) {
          throw new Invalid(`${where}: its snapshot is missing or belongs elsewhere.`);
        }
        usedSnapshots.add(snapshotId);
      }
    }
    if (usedSnapshots.size !== snapshots.size) throw new Invalid('The backup contains snapshots without a capture.');
    const capturedSources = new Set([...captures.values()].map((c) => c.source_id));
    for (const source of sources.values()) {
      if (!capturedSources.has(source.id)) throw new Invalid(`source ${String(source.id)}: has no captures.`);
    }

    for (const s of snapshots.values()) {
      const where = `snapshot ${String(s.id)}`;
      const status = oneOf(s, 'status', ['ok', 'failed', 'pending'] as const, where);
      if (status === 'pending') continue;
      str(s, 'captured_at', where, false);
      intOrNull(s, 'http_status', where);
      if (status === 'failed') {
        oneOf(s, 'error_code', ['page_unavailable', 'http_error', 'empty_text', 'extraction_error', 'timeout'] as const, where);
        str(s, 'error_message', where);
        continue;
      }
      oneOf(s, 'extraction_method', ['readability', 'page-text'] as const, where);
      if (s.fallback_reason !== null) oneOf(s, 'fallback_reason', ['not_html', 'no_article', 'page_too_large', 'reader_error'] as const, where);
      bool(s, 'truncated', where);
      int(s, 'original_character_count', where);
      str(s, 'title', where);
      str(s, 'page_url', where);
      for (const key of ['byline', 'site_name', 'lang', 'published_time', 'canonical_url']) strOrNull(s, key, where);
      await checkText(str(s, 'text', where, false), str(s, 'sha256', where), int(s, 'character_count', where, 1), where);
    }

    const jobs = uniqueIds(data.jobs, 'jobs');
    for (const j of jobs.values()) {
      const where = `job ${String(j.id)}`;
      if (j.format_version !== 1) throw new Invalid(`${where}: unsupported job format version.`);
      str(j, 'session_id', where, false);
      str(j, 'created_at', where, false);
      str(j, 'text', where);
      obj(j.settings, `${where} settings`);
      if (!Array.isArray(j.sources)) throw new Invalid(`${where}: "sources" must be a list.`);
    }

    const settingsRoot = obj(root.settings, 'Backup settings');
    const activeSessionId = str(settingsRoot, 'active_session_id', 'Backup settings', false);
    const settings: BackupSettings = {
      active_session_id: sessions.has(activeSessionId) ? activeSessionId : INBOX_SESSION_ID,
      presets: mergePresets(settingsRoot.presets),
    };

    const backup: Backup = {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      db_schema_version: DB_SCHEMA_VERSION,
      created_at: createdAt,
      data: {
        sessions: data.sessions as unknown as Session[],
        sources: data.sources as unknown as Source[],
        captures: data.captures as unknown as Capture[],
        snapshots: data.snapshots as unknown as Snapshot[],
        jobs: data.jobs,
      },
      settings,
    };
    return { ok: true, backup, summary: summarize(backup.data, createdAt) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    return { ok: false, error: `The backup could not be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}

