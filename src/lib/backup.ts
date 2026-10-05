import type { DataSnapshot } from './db';
import { DATA_STORES, DB_SCHEMA_VERSION } from './db';
import { INBOX_SESSION_ID } from './model';
import type { Capture, Session, Snapshot, Source } from './model';
import type { JobSettings } from './research-job';
import type { Preset } from './settings';
import { mergePresets } from './settings';
import { sha256Hex } from './snapshot';
import { MAX_SNAPSHOT_CHARACTERS, countCharacters } from './text';
import { isCapturableUrl, isProvenanceUrl, normalizeUrl } from './url';

export const BACKUP_FORMAT = 'clipgrail-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupSettings {
  active_session_id: string;
  presets: Preset[];
  /** Research Job settings per session ID. Restore replaces all of them; a session without an entry gets defaults. */
  job_settings: Record<string, JobSettings>;
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
/** Highest S-number a backup may hold, far below the precision limit of JavaScript numbers. */
const MAX_SOURCE_NUMBER = 1_000_000_000;

function int(r: Rec, key: string, where: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = r[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Invalid(`${where}: "${key}" must be an integer ≥ ${min}.`);
  if (v > max) throw new Invalid(`${where}: "${key}" is larger than ${max}.`);
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

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Invalid(`${where} must be a list of strings.`);
  return value as string[];
}
function list(value: unknown, where: string): Rec[] {
  if (!Array.isArray(value)) throw new Invalid(`${where} must be a list.`);
  return value.map((item, i) => obj(item, `${where} [${i + 1}]`));
}
function nullableList(value: unknown, where: string): Rec[] | null {
  return value === null ? null : list(value, where);
}
/** An http or https address. */
function webUrl(r: Rec, key: string, where: string): string {
  const v = str(r, key, where, false);
  if (!isCapturableUrl(v)) throw new Invalid(`${where}: "${key}" must be an http or https address.`);
  return v;
}
function webUrlOrNull(r: Rec, key: string, where: string): string | null {
  return r[key] === null ? null : webUrl(r, key, where);
}
/** Page where a link was found: http, https or file address. */
function provenanceUrlOrNull(r: Rec, key: string, where: string): string | null {
  const v = strOrNull(r, key, where);
  if (v !== null && !isProvenanceUrl(v)) throw new Invalid(`${where}: "${key}" must be an http, https or file address.`);
  return v;
}
/** Stored character counts must agree with each other and with the truncation flag. */
function checkLength(count: number, original: number, truncated: boolean, where: string): void {
  if (count > MAX_SNAPSHOT_CHARACTERS) throw new Invalid(`${where}: text is longer than the ${MAX_SNAPSHOT_CHARACTERS} character limit.`);
  if (original < count) throw new Invalid(`${where}: original_character_count is smaller than character_count.`);
  if (truncated !== original > count) throw new Invalid(`${where}: "truncated" does not match the character counts.`);
}

function parseJobSettings(value: unknown, where: string): JobSettings {
  const s = obj(value, where);
  return {
    context_mode: oneOf(s, 'context_mode', ['links', 'selections', 'full'] as const, where),
    excluded_source_ids: strings(s.excluded_source_ids, `${where}: "excluded_source_ids"`),
    max_chars_per_source: s.max_chars_per_source === null ? null : int(s, 'max_chars_per_source', where, 1),
    include_notes: bool(s, 'include_notes', where),
    include_link_context: bool(s, 'include_link_context', where),
    include_capture_times: bool(s, 'include_capture_times', where),
    include_original_urls: bool(s, 'include_original_urls', where),
  };
}

/** Included text of a job: count must match the text, and the limit flag must match the counts. */
function checkJobText(t: Rec, where: string): void {
  const count = int(t, 'character_count', where);
  const available = int(t, 'available_character_count', where);
  if (countCharacters(str(t, 'text', where)) !== count) throw new Invalid(`${where}: character_count does not match the text.`);
  if (available < count || bool(t, 'shortened_by_limit', where) !== available > count) {
    throw new Invalid(`${where}: shortened_by_limit does not match the character counts.`);
  }
}

/**
 * A stored Research Job is a frozen copy: it is checked on its own, without
 * requiring its sources to still exist in the session.
 */
function validateJob(j: Rec, sessions: Map<string, Rec>): void {
  const where = `job ${String(j.id)}`;
  if (j.format_version !== 1) throw new Invalid(`${where}: unsupported job format version.`);
  if (!sessions.has(str(j, 'session_id', where, false))) throw new Invalid(`${where}: unknown session.`);
  str(j, 'session_name', where);
  str(j, 'created_at', where, false);
  str(j, 'prompt', where);
  strOrNull(j, 'session_notes', where);
  parseJobSettings(j.settings, `${where} settings`);
  const text = str(j, 'text', where);
  const sources = list(j.sources, `${where} sources`);
  const labels = new Set<string>();
  sources.forEach((s, i) => {
    const w = `${where} source ${i + 1}`;
    const label = str(s, 'label', w, false);
    if (!/^S[1-9]\d*$/.test(label) || labels.has(label)) throw new Invalid(`${w}: label is invalid or repeated.`);
    labels.add(label);
    str(s, 'source_id', w, false);
    webUrl(s, 'url', w);
    for (const key of ['title', 'site_name', 'byline', 'published_time', 'missing_reason']) strOrNull(s, key, w);
    oneOf(s, 'status', ['ok', 'partial', 'failed', 'pending', 'none'] as const, w);
    oneOf(s, 'material', ['complete', 'partial', 'missing', 'not_requested'] as const, w);
    if (s.snapshot !== null) {
      const sn = obj(s.snapshot, `${w} snapshot`);
      checkJobText(sn, `${w} snapshot`);
      str(sn, 'snapshot_id', w, false);
      strOrNull(sn, 'captured_at', w);
      oneOf(sn, 'extraction_method', ['readability', 'page-text'] as const, w);
      if (sn.fallback_reason !== null) oneOf(sn, 'fallback_reason', ['not_html', 'no_article', 'page_too_large', 'reader_error'] as const, w);
      if (!/^[0-9a-f]{64}$/.test(str(sn, 'stored_sha256', w))) throw new Invalid(`${w}: stored_sha256 is not a SHA-256 value.`);
      bool(sn, 'truncated_at_capture', w);
      int(sn, 'original_character_count', w);
    }
    for (const sel of list(s.selections, `${w} selections`)) {
      checkJobText(sel, `${w} selection`);
      str(sel, 'capture_id', w, false);
      strOrNull(sel, 'captured_at', w);
      bool(sel, 'truncated_at_capture', w);
      oneOf(sel, 'method', ['dom-selection', 'menu-selection-text'] as const, w);
    }
    // Jobs generated before sources had notes have no source_note.
    if (s.source_note !== undefined) strOrNull(s, 'source_note', w);
    // Jobs generated before later failed attempts were reported have no latest_failure.
    if (s.latest_failure !== undefined && s.latest_failure !== null) {
      const f = obj(s.latest_failure, `${w} latest_failure`);
      str(f, 'description', w, false);
      strOrNull(f, 'captured_at', w);
    }
    for (const n of nullableList(s.notes, `${w} notes`) ?? []) {
      str(n, 'capture_id', w, false);
      str(n, 'note', w);
    }
    for (const l of nullableList(s.link_context, `${w} link_context`) ?? []) {
      str(l, 'capture_id', w, false);
      provenanceUrlOrNull(l, 'found_on', w);
      strOrNull(l, 'anchor_text', w);
    }
    for (const t of nullableList(s.capture_times, `${w} capture_times`) ?? []) {
      str(t, 'capture_id', w, false);
      oneOf(t, 'kind', ['page', 'selection', 'link', 'tab'] as const, w);
      str(t, 'captured_at', w, false);
    }
    if (s.original_urls !== null) {
      for (const url of strings(s.original_urls, `${w}: "original_urls"`)) {
        if (!isCapturableUrl(url)) throw new Invalid(`${w}: original_urls must be http or https addresses.`);
      }
    }
  });
  const stats = obj(j.stats, `${where} stats`);
  const material = (m: string) => sources.filter((s) => s.material === m).length;
  if (
    int(stats, 'source_count', where) !== sources.length ||
    int(stats, 'character_count', where) !== countCharacters(text) ||
    int(stats, 'utf8_bytes', where) !== new TextEncoder().encode(text).length ||
    int(stats, 'missing_count', where) !== material('missing') ||
    int(stats, 'partial_count', where) !== material('partial')
  ) {
    throw new Invalid(`${where}: stats do not match the job.`);
  }
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
    const schemaVersion = root.db_schema_version;
    // Schemas 2 and 3 store the same records; 3 only keeps snapshot texts in a separate store inside the database.
    if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== DB_SCHEMA_VERSION) {
      throw new Invalid(`Unsupported database schema version ${String(schemaVersion)}.`);
    }
    const createdAt = str(root, 'created_at', 'Backup', false);
    const dataRoot = obj(root.data, 'Backup data');
    const data = {} as Record<(typeof DATA_STORES)[number], Rec[]>;
    for (const store of DATA_STORES) {
      const list = dataRoot[store];
      if (!Array.isArray(list)) throw new Invalid(`Backup data: "${store}" must be a list.`);
      data[store] = list.map((item, i) => obj(item, `${store}[${i}]`));
    }
    if (schemaVersion === 1) {
      // Schema 1 had no archived sessions and no source notes; the database upgrade adds the same defaults.
      data.sessions = data.sessions.map((s) => ({ archived_at: null, ...s }));
      data.sources = data.sources.map((s) => ({ note: '', ...s }));
    }

    const sessions = uniqueIds(data.sessions, 'sessions');
    if (!sessions.has(INBOX_SESSION_ID)) throw new Invalid('The backup has no Inbox session.');
    for (const s of sessions.values()) {
      const where = `session ${String(s.id)}`;
      str(s, 'name', where, false);
      str(s, 'created_at', where, false);
      int(s, 'next_source_number', where, 1, MAX_SOURCE_NUMBER);
      str(s, 'prompt', where);
      str(s, 'notes', where);
      const archivedAt = strOrNull(s, 'archived_at', where);
      if (archivedAt === '') throw new Invalid(`${where}: "archived_at" must be a time or null.`);
      if (archivedAt !== null && s.id === INBOX_SESSION_ID) throw new Invalid('The Inbox cannot be archived.');
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
      const dedupUrl = webUrl(s, 'dedup_url', where);
      if (normalizeUrl(dedupUrl) !== dedupUrl) throw new Invalid(`${where}: dedup_url is not in normalized form.`);
      const urlKey = `${sessionId}\u0000${dedupUrl}`;
      if (numbers.has(numberKey)) throw new Invalid(`${where}: S${number} is used twice in one session.`);
      if (dedupUrls.has(urlKey)) throw new Invalid(`${where}: the URL appears twice in one session.`);
      numbers.add(numberKey);
      dedupUrls.add(urlKey);
      str(s, 'created_at', where, false);
      str(s, 'note', where);
    }

    const snapshots = uniqueIds(data.snapshots, 'snapshots');
    const captures = uniqueIds(data.captures, 'captures');
    const usedSnapshots = new Set<string>();
    for (const c of captures.values()) {
      const where = `capture ${String(c.id)}`;
      const source = sources.get(str(c, 'source_id', where, false));
      if (!source || source.session_id !== c.session_id) throw new Invalid(`${where}: unknown source or session mismatch.`);
      const kind = oneOf(c, 'kind', ['page', 'selection', 'link', 'tab'] as const, where);
      str(c, 'captured_at', where, false);
      webUrl(c, 'original_url', where);
      str(c, 'tab_title', where);
      provenanceUrlOrNull(c, 'found_on', where);
      strOrNull(c, 'anchor_text', where);
      str(c, 'note', where);
      const snapshotId = strOrNull(c, 'snapshot_id', where);
      if (kind === 'selection') {
        if (snapshotId !== null) throw new Invalid(`${where}: a selection capture cannot have a snapshot.`);
        const f = obj(c.fragment, `${where} fragment`);
        oneOf(f, 'method', ['dom-selection', 'menu-selection-text'] as const, where);
        const fragmentCount = int(f, 'character_count', where, 1);
        checkLength(fragmentCount, int(f, 'original_character_count', where), bool(f, 'truncated', where), `${where} fragment`);
        await checkText(str(f, 'text', where, false), str(f, 'sha256', where), fragmentCount, `${where} fragment`);
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
      const count = int(s, 'character_count', where, 1);
      checkLength(count, int(s, 'original_character_count', where), bool(s, 'truncated', where), where);
      str(s, 'title', where);
      webUrl(s, 'page_url', where);
      webUrlOrNull(s, 'canonical_url', where);
      for (const key of ['byline', 'site_name', 'lang', 'published_time']) strOrNull(s, key, where);
      await checkText(str(s, 'text', where, false), str(s, 'sha256', where), count, where);
    }

    for (const j of uniqueIds(data.jobs, 'jobs').values()) validateJob(j, sessions);

    const settingsRoot = obj(root.settings, 'Backup settings');
    const activeSessionId = str(settingsRoot, 'active_session_id', 'Backup settings', false);
    // Backups made before job settings were included have none: every session then gets defaults.
    const jobSettingsRoot = settingsRoot.job_settings === undefined ? {} : obj(settingsRoot.job_settings, 'Backup job settings');
    // Session IDs are keys here; a prototype-less object keeps an ID such as "__proto__" an ordinary key.
    const jobSettings = Object.create(null) as Record<string, JobSettings>;
    for (const [sessionId, value] of Object.entries(jobSettingsRoot)) {
      if (!sessions.has(sessionId)) throw new Invalid(`Backup job settings: unknown session ${sessionId}.`);
      jobSettings[sessionId] = parseJobSettings(value, `Job settings of session ${sessionId}`);
    }
    const settings: BackupSettings = {
      active_session_id: sessions.has(activeSessionId) ? activeSessionId : INBOX_SESSION_ID,
      presets: mergePresets(settingsRoot.presets),
      job_settings: jobSettings,
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


export interface RestoreSteps {
  /** Replaces all research data in one transaction (all or nothing). */
  replaceData(data: DataSnapshot): Promise<void>;
  /** Writes presets, Research Job settings and the active session. */
  applySettings(settings: BackupSettings): Promise<void>;
}

export type RestoreResult = { ok: true; message: string } | { ok: false; dataReplaced: boolean; message: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Restores a validated backup and reports what actually happened: research
 * data and settings are written in separate steps, so a settings failure
 * after the data was replaced is reported as such.
 */
export async function restoreBackup(backup: Backup, steps: RestoreSteps): Promise<RestoreResult> {
  try {
    await steps.replaceData(backup.data);
  } catch (error) {
    return { ok: false, dataReplaced: false, message: `Restore failed, current data is unchanged: ${reason(error)}` };
  }
  try {
    await steps.applySettings(backup.settings);
  } catch (error) {
    return {
      ok: false,
      dataReplaced: true,
      message: `Research data was restored from the backup, but its settings were not (${reason(error)}). Presets, Research Job settings or the active session may differ from the backup.`,
    };
  }
  return { ok: true, message: 'Backup restored.' };
}
