import type { DataSnapshot, DataStore } from './db';
import { DATA_STORES, DB_SCHEMA_VERSION } from './db';
import { INBOX_SESSION_ID } from './model';
import type { Capture, Session, Snapshot, Source } from './model';
import type { JobSettings } from './research-job';
import type { Preset } from './settings';
import { mergePresets } from './settings';
import { sha256Hex } from './snapshot';
import { MAX_SNAPSHOT_CHARACTERS, countCharacters, utf8Length } from './text';
import { frameAddress, isCapturableUrl, isProvenanceUrl, normalizeUrl } from './url';

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

/**
 * Largest backup file ClipGrail writes or reads, in bytes. Measured in
 * Chrome 154: making, checking and restoring a backup takes up to about five
 * times its size in memory (300 MB: 1.6 GB, 13 to 18 s per step), and at
 * 450 MB the page ran out of memory. 200 MB keeps a wide margin.
 */
export const MAX_BACKUP_BYTES = 200_000_000;

export interface WrittenBackup {
  /** The backup as JSON text in parts, to be joined by the file they go into; empty when the backup is over the limit. */
  parts: string[];
  /** Size of the whole backup in UTF-8 bytes, also when it is over the limit. */
  bytes: number;
  summary: BackupSummary;
}

/**
 * Writes a backup as JSON text in parts, one record per line, without
 * building a single string of the whole backup. Once the backup passes
 * `limit` bytes, parts are no longer kept and the rest is only measured, so
 * the caller can say how large it would be. `settingsFor` gets the IDs of the
 * sessions read.
 */
export async function writeBackup(
  read: (visit: (store: DataStore, record: unknown) => void) => Promise<void>,
  settingsFor: (sessionIds: Set<string>) => BackupSettings,
  createdAt: string,
  limit = MAX_BACKUP_BYTES,
): Promise<WrittenBackup> {
  let parts: string[] = [];
  let bytes = 0;
  const add = (part: string) => {
    bytes += utf8Length(part);
    if (bytes > limit) parts = [];
    else parts.push(part);
  };
  const counts = Object.fromEntries(DATA_STORES.map((store) => [store, 0])) as Record<DataStore, number>;
  const sessionIds = new Set<string>();
  let visits = 0;
  let open = -1;
  const openUntil = (index: number) => {
    while (open < index) {
      if (open >= 0) add(']');
      open += 1;
      add(`${open ? ',' : ''}\n${JSON.stringify(DATA_STORES[open])}:[`);
    }
  };
  add(JSON.stringify({ format: BACKUP_FORMAT, format_version: BACKUP_FORMAT_VERSION, db_schema_version: DB_SCHEMA_VERSION, created_at: createdAt }).slice(0, -1) + ',"data":{');
  await read((store, record) => {
    openUntil(DATA_STORES.indexOf(store));
    add(`${counts[store] ? ',' : ''}\n${JSON.stringify(record)}`);
    counts[store] += 1;
    // Visits are not captures the user saved; the summary leaves them out, as the side panel does.
    if (store === 'captures' && (record as { kind?: string }).kind === 'visit') visits += 1;
    if (store === 'sessions') sessionIds.add((record as Session).id);
  });
  openUntil(DATA_STORES.length - 1);
  add(`]\n},\n"settings":${JSON.stringify(settingsFor(sessionIds))}}\n`);
  return {
    parts: bytes > limit ? [] : parts,
    bytes,
    summary: { created_at: createdAt, sessions: counts.sessions, sources: counts.sources, captures: counts.captures - visits, snapshots: counts.snapshots, jobs: counts.jobs },
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
    captures: data.captures.filter((c) => (c as { kind?: string }).kind !== 'visit').length,
    snapshots: data.snapshots.length,
    jobs: data.jobs.length,
  };
}

class Invalid extends Error {}

/**
 * Restored records are rebuilt from the fields ClipGrail knows, so anything
 * else in a backup file is dropped instead of being stored and carried into
 * later backups. Fields that are absent stay absent.
 */
function pick(r: Rec, keys: readonly string[]): Rec {
  const out: Rec = {};
  for (const key of keys) if (r[key] !== undefined) out[key] = r[key];
  return out;
}
const SESSION_KEYS = ['id', 'name', 'created_at', 'next_source_number', 'prompt', 'notes', 'archived_at'] as const;
const SOURCE_KEYS = ['id', 'session_id', 'number', 'dedup_url', 'created_at', 'note', 'merged_ids', 'important'] as const;
const CAPTURE_KEYS = ['id', 'session_id', 'source_id', 'kind', 'captured_at', 'original_url', 'tab_title', 'found_on', 'anchor_text', 'fragment', 'frame', 'navigation', 'snapshot_id', 'note'] as const;
const FRAGMENT_KEYS = ['text', 'character_count', 'sha256', 'truncated', 'original_character_count', 'method'] as const;
const SNAPSHOT_BASE_KEYS = ['id', 'capture_id', 'source_id', 'session_id', 'status'] as const;
const SNAPSHOT_KEYS = {
  ok: [...SNAPSHOT_BASE_KEYS, 'captured_at', 'character_count', 'sha256', 'extraction_method', 'fallback_reason', 'truncated', 'original_character_count', 'title', 'byline', 'site_name', 'lang', 'published_time', 'canonical_url', 'page_url', 'http_status', 'text'],
  failed: [...SNAPSHOT_BASE_KEYS, 'captured_at', 'error_code', 'error_message', 'http_status'],
  pending: SNAPSHOT_BASE_KEYS,
} as const;
const JOB_KEYS = ['id', 'format_version', 'session_id', 'session_name', 'created_at', 'prompt', 'settings', 'session_notes', 'sources', 'stats', 'text'] as const;
const JOB_SOURCE_KEYS = ['label', 'source_id', 'url', 'title', 'site_name', 'byline', 'published_time', 'status', 'material', 'missing_reason', 'latest_failure', 'snapshot', 'selections', 'source_note', 'notes', 'link_context', 'capture_times', 'original_urls'] as const;
const JOB_TEXT_KEYS = ['text', 'character_count', 'available_character_count', 'shortened_by_limit'] as const;
const JOB_SNAPSHOT_KEYS = [...JOB_TEXT_KEYS, 'snapshot_id', 'captured_at', 'extraction_method', 'fallback_reason', 'stored_sha256', 'truncated_at_capture', 'original_character_count'] as const;
const JOB_SELECTION_KEYS = [...JOB_TEXT_KEYS, 'capture_id', 'captured_at', 'truncated_at_capture', 'method', 'frame_source_unestablished'] as const;
const JOB_STATS_KEYS = ['source_count', 'character_count', 'utf8_bytes', 'missing_count', 'partial_count'] as const;

function cleanCapture(c: Rec): Rec {
  const out = pick(c, CAPTURE_KEYS);
  if (c.fragment !== null) out.fragment = pick(c.fragment as Rec, FRAGMENT_KEYS);
  if (c.frame !== null) out.frame = pick(c.frame as Rec, ['url']);
  if (c.navigation !== null) out.navigation = pick(c.navigation as Rec, ['transition', 'qualifiers', 'in_page']);
  return out;
}
function cleanJob(j: Rec): Rec {
  const out = pick(j, JOB_KEYS);
  out.settings = parseJobSettings(j.settings, 'job settings');
  out.stats = pick(j.stats as Rec, JOB_STATS_KEYS);
  out.sources = (j.sources as Rec[]).map((source) => {
    const s = pick(source, JOB_SOURCE_KEYS);
    if (source.snapshot !== null) s.snapshot = pick(source.snapshot as Rec, JOB_SNAPSHOT_KEYS);
    s.selections = (source.selections as Rec[]).map((sel) => pick(sel, JOB_SELECTION_KEYS));
    if (source.latest_failure) s.latest_failure = pick(source.latest_failure as Rec, ['description', 'captured_at']);
    if (source.notes !== null) s.notes = (source.notes as Rec[]).map((n) => pick(n, ['capture_id', 'note']));
    if (source.link_context !== null) s.link_context = (source.link_context as Rec[]).map((l) => pick(l, ['capture_id', 'found_on', 'anchor_text']));
    if (source.capture_times !== null) s.capture_times = (source.capture_times as Rec[]).map((t) => pick(t, ['capture_id', 'kind', 'captured_at']));
    return s;
  });
  return out;
}

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

/** A transition type or qualifier as Chrome reports it; any such word, so a value a later Chrome adds still restores. */
const CHROME_WORD = /^[a-z_]{1,40}$/;
function navigation(c: Rec, where: string): void {
  const n = obj(c.navigation, `${where} navigation`);
  if (typeof n.transition !== 'string' || !CHROME_WORD.test(n.transition)) throw new Invalid(`${where}: the navigation has no valid transition.`);
  const qualifiers = strings(n.qualifiers, `${where}: navigation qualifiers`);
  if (qualifiers.length > 8 || new Set(qualifiers).size !== qualifiers.length || !qualifiers.every((q) => CHROME_WORD.test(q))) {
    throw new Invalid(`${where}: the navigation qualifiers are not valid.`);
  }
  bool(n, 'in_page', where);
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
      // Jobs generated before frames were recorded have no frame_source_unestablished.
      if (sel.frame_source_unestablished !== undefined) bool(sel, 'frame_source_unestablished', w);
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
    // Version 4 only added thumbnails, which backups leave out: version 3 data is the same.
    // Version 5 added merged_ids to sources and frame to captures; version 6 added important to sources, navigation to captures and visits.
    if (typeof schemaVersion !== 'number' || ![1, 2, 3, 4, 5, DB_SCHEMA_VERSION].includes(schemaVersion)) {
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
    if (schemaVersion < 5) {
      // As the database upgrade does: no merged sources, and no frame recorded for earlier captures.
      data.sources = data.sources.map((s) => ({ merged_ids: [], ...s }));
      data.captures = data.captures.map((c) => ({ frame: null, ...c }));
    }
    if (schemaVersion < 6) {
      // As the database upgrade does: nothing marked important, and no navigation recorded for earlier captures.
      data.sources = data.sources.map((s) => ({ important: false, ...s }));
      data.captures = data.captures.map((c) => ({ navigation: null, ...c }));
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
      bool(s, 'important', where);
    }
    // An ID a source took over when another source joined it belongs to that source alone, and to no current source.
    const mergedOwner = new Map<string, unknown>();
    for (const s of sources.values()) {
      const where = `source ${String(s.id)}`;
      for (const id of strings(s.merged_ids, `${where}: "merged_ids"`)) {
        if (sources.has(id)) throw new Invalid(`${where}: merged ID ${id} is the ID of a current source.`);
        if (mergedOwner.has(id)) throw new Invalid(`${where}: merged ID ${id} is listed ${mergedOwner.get(id) === s.id ? 'twice' : 'by two sources'}.`);
        mergedOwner.set(id, s.id);
      }
    }

    const snapshots = uniqueIds(data.snapshots, 'snapshots');
    const captures = uniqueIds(data.captures, 'captures');
    const usedSnapshots = new Set<string>();
    for (const c of captures.values()) {
      const where = `capture ${String(c.id)}`;
      const source = sources.get(str(c, 'source_id', where, false));
      if (!source || source.session_id !== c.session_id) throw new Invalid(`${where}: unknown source or session mismatch.`);
      const kind = oneOf(c, 'kind', ['page', 'selection', 'link', 'tab', 'visit'] as const, where);
      str(c, 'captured_at', where, false);
      webUrl(c, 'original_url', where);
      str(c, 'tab_title', where);
      provenanceUrlOrNull(c, 'found_on', where);
      strOrNull(c, 'anchor_text', where);
      str(c, 'note', where);
      const snapshotId = strOrNull(c, 'snapshot_id', where);
      if (c.frame !== null) {
        if (kind !== 'selection') throw new Invalid(`${where}: only selection captures have a frame.`);
        const frame = obj(c.frame, `${where} frame`);
        if (frame.url !== null && frameAddress(frame.url) !== frame.url) throw new Invalid(`${where}: the frame address is not valid.`);
      }
      if (c.navigation !== null) {
        if (kind !== 'tab' && kind !== 'visit') throw new Invalid(`${where}: only recorded pages and visits have a navigation.`);
        navigation(c, where);
      }
      if (kind === 'visit') {
        // A visit notes a return to a page: no text, no selection, no link text.
        if (c.navigation === null || snapshotId !== null || c.fragment !== null || c.anchor_text !== null) throw new Invalid(`${where}: a visit has only a navigation.`);
      } else if (kind === 'selection') {
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
    // A source exists while it has a capture other than a visit, as in the database.
    const capturedSources = new Set([...captures.values()].filter((c) => c.kind !== 'visit').map((c) => c.source_id));
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
        oneOf(s, 'error_code', ['page_unavailable', 'http_error', 'empty_text', 'extraction_error', 'timeout', 'text_missing'] as const, where);
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
        sessions: data.sessions.map((r) => pick(r, SESSION_KEYS)) as unknown as Session[],
        sources: data.sources.map((r) => pick(r, SOURCE_KEYS)) as unknown as Source[],
        captures: data.captures.map(cleanCapture) as unknown as Capture[],
        snapshots: data.snapshots.map((r) => pick(r, SNAPSHOT_KEYS[r.status as keyof typeof SNAPSHOT_KEYS])) as unknown as Snapshot[],
        jobs: data.jobs.map(cleanJob),
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
