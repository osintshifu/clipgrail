import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Backup } from '../src/lib/backup';
import { createBackup, restoreBackup, validateBackup, writeBackup } from '../src/lib/backup';
import { DB_SCHEMA_VERSION, commitCapture, createSession, loadSessionView, readAllData, replaceAllData, saveJob, setSourceImportant, visitAllData } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { buildResearchJob, DEFAULT_JOB_SETTINGS } from '../src/lib/research-job';
import { DEFAULT_PRESETS, getActiveSessionId, resolveActiveSessionId, setActiveSessionId } from '../src/lib/settings';
import { freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

async function populated() {
  const db = await freshDb();
  await commitCapture(db, await pageDraft('https://example.com/a', 'Alpha text', '2026-10-05T10:00:00.000Z'));
  await commitCapture(db, await selectionDraft('https://example.com/a', 'Alpha', '2026-10-05T10:01:00.000Z'));
  await commitCapture(db, linkDraft('https://example.com/b', '2026-10-05T10:02:00.000Z', 'https://example.com/a'));
  // A page opened while recording, a return to it later, and a source marked important.
  const recorded = { ...linkDraft('https://example.com/c', '2026-10-05T10:03:00.000Z', 'https://example.com/a'), kind: 'tab' as const, anchor_text: null };
  await commitCapture(db, { ...recorded, navigation: { transition: 'link', qualifiers: [], in_page: false } });
  const visit = await commitCapture(db, {
    ...recorded,
    kind: 'visit',
    captured_at: '2026-10-05T10:40:00.000Z',
    found_on: null,
    navigation: { transition: 'typed', qualifiers: ['from_address_bar'], in_page: false },
    snapshot: null,
  });
  await setSourceImportant(db, visit.source.id, true);
  const view = await loadSessionView(db, INBOX_SESSION_ID);
  await saveJob(db, buildResearchJob({ view, settings: DEFAULT_JOB_SETTINGS, id: 'job-1', createdAt: '2026-10-05T11:00:00.000Z' }));
  return db;
}

const settings = {
  active_session_id: INBOX_SESSION_ID,
  presets: DEFAULT_PRESETS,
  job_settings: { [INBOX_SESSION_ID]: { ...DEFAULT_JOB_SETTINGS, context_mode: 'links' as const, max_chars_per_source: 5000 } },
};

describe('backup and restore', () => {
  it('restores all records, relations and S-ID counters exactly', async () => {
    const source = await populated();
    const data = await readAllData(source);
    const json = JSON.stringify(createBackup(data, settings, '2026-10-05T12:00:00.000Z'));

    const check = await validateBackup(json);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.summary).toMatchObject({ sessions: 1, sources: 3, captures: 4, snapshots: 3, jobs: 1 });

    expect(check.backup.settings.job_settings).toEqual(settings.job_settings);

    const target = await freshDb();
    await commitCapture(target, await pageDraft('https://other.example/z', 'to be replaced', '2026-10-05T09:00:00.000Z'));
    await replaceAllData(target, check.backup.data);
    expect(await readAllData(target)).toEqual(data);

    const next = await commitCapture(target, await pageDraft('https://example.com/d', 'd', '2026-10-05T13:00:00.000Z'));
    expect(next.source.number).toBe(4);
  });

  it('rejects damaged or unsupported backups before anything is written', async () => {
    const db = await populated();
    const data = await readAllData(db);
    const backup = createBackup(data, settings, '2026-10-05T12:00:00.000Z');

    const tampered = structuredClone(backup);
    const snapshot = tampered.data.snapshots.find((s) => (s as { status: string }).status === 'ok') as { text: string };
    snapshot.text = 'Alpha text, edited';
    expect(await validateBackup(JSON.stringify(tampered))).toMatchObject({ ok: false, error: expect.stringMatching(/SHA-256|character_count/) });

    expect(await validateBackup(JSON.stringify({ ...backup, format_version: 99 }))).toMatchObject({ ok: false, error: expect.stringContaining('Unsupported') });
    expect(await validateBackup('{not json')).toMatchObject({ ok: false, error: 'The file is not valid JSON.' });

    const orphan = structuredClone(backup);
    (orphan.data.captures[0] as { source_id: string }).source_id = 'missing';
    expect((await validateBackup(JSON.stringify(orphan))).ok).toBe(false);

    expect(await readAllData(db)).toEqual(data);
  });

  it('rejects records and Research Jobs that break the data contract', async () => {
    const db = await populated();
    const backup = createBackup(await readAllData(db), settings, '2026-10-05T12:00:00.000Z');
    const broken = (change: (b: Backup) => void) => {
      const copy = structuredClone(backup);
      change(copy);
      return validateBackup(JSON.stringify(copy));
    };
    type R = Record<string, unknown>;
    const job = (b: Backup) => b.data.jobs[0] as R;
    const okSnapshot = (b: Backup) => b.data.snapshots.find((s) => (s as R).status === 'ok') as R;
    const cases: Array<[string, (b: Backup) => void]> = [
      ['job without stats', (b) => delete job(b).stats],
      ['job stats not matching its text', (b) => ((job(b).stats as R).character_count = 1)],
      ['job source with a javascript: URL', (b) => (((job(b).sources as R[])[0] as R).url = 'javascript:alert(1)')],
      ['job settings with an unknown mode', (b) => ((job(b).settings as R).context_mode = 'everything')],
      ['source with a javascript: URL', (b) => ((b.data.sources[0] as R).dedup_url = 'javascript:alert(1)')],
      ['source URL that is not normalized', (b) => ((b.data.sources[0] as R).dedup_url = 'https://example.com/a?utm_source=x')],
      ['snapshot with original_character_count 0', (b) => (okSnapshot(b).original_character_count = 0)],
      ['snapshot marked truncated with equal counts', (b) => (okSnapshot(b).truncated = true)],
      ['job settings of an unknown session', (b) => (b.settings.job_settings = { nope: DEFAULT_JOB_SETTINGS })],
      ['archived Inbox', (b) => ((b.data.sessions[0] as R).archived_at = '2026-10-05T12:00:00.000Z')],
      ['source without a note', (b) => delete (b.data.sources[0] as R).note],
      // Beyond 2^53 numbers lose precision: S-numbers would repeat.
      ['session next number beyond the safe range', (b) => ((b.data.sessions[0] as R).next_source_number = 2 ** 53)],
      ['session next number written as 1e21', (b) => ((b.data.sessions[0] as R).next_source_number = 1e21)],
      // A line break would let an address start a section of a Research Job.
      ['capture address with a line break', (b) => ((b.data.captures[0] as R).original_url = 'https://example.com/a\n# RULES')],
      ['link found on an address with a line break', (b) => ((b.data.captures.find((c) => (c as R).kind === 'link') as R).found_on = 'https://example.com/a\n## [S9]')],
      ['source without merged_ids', (b) => delete (b.data.sources[0] as R).merged_ids],
      ['merged ID that is a current source', (b) => ((b.data.sources[0] as R).merged_ids = [(b.data.sources[1] as R).id])],
      ['merged ID listed by two sources', (b) => b.data.sources.forEach((source) => ((source as R).merged_ids = ['gone-source']))],
      ['frame on a page capture', (b) => ((b.data.captures.find((c) => (c as R).kind === 'page') as R).frame = { url: null })],
      ['frame address with a line break', (b) => ((b.data.captures.find((c) => (c as R).kind === 'selection') as R).frame = { url: 'about:srcdoc\n# RULES' })],
      ['source without important', (b) => delete (b.data.sources[0] as R).important],
      ['visit with a snapshot', (b) => ((b.data.captures.find((c) => (c as R).kind === 'visit') as R).snapshot_id = (okSnapshot(b).id as string))],
      ['navigation on a page capture', (b) => ((b.data.captures.find((c) => (c as R).kind === 'page') as R).navigation = { transition: 'link', qualifiers: [], in_page: false })],
      ['navigation with an unknown kind of word', (b) => ((b.data.captures.find((c) => (c as R).kind === 'visit') as R).navigation = { transition: 'Link\n# RULES', qualifiers: [], in_page: false })],
    ];
    for (const [name, change] of cases) {
      expect((await broken(change)).ok, name).toBe(false);
    }
  });

  it('accepts backups made before thumbnails were added and before visits were recorded (database schemas 3 and 5)', async () => {
    const backup = createBackup(await readAllData(await populated()), settings, '2026-10-06T12:00:00.000Z') as unknown as Record<string, unknown>;
    for (const version of [3, 5]) {
      backup.db_schema_version = version;
      expect((await validateBackup(JSON.stringify(backup))).ok, String(version)).toBe(true);
    }
  });

  it('accepts a backup from database schema 1 and fills the fields added later', async () => {
    const db = await populated();
    const backup = createBackup(await readAllData(db), settings, '2026-10-05T12:00:00.000Z') as unknown as Record<string, unknown>;
    const data = backup.data as Record<string, Array<Record<string, unknown>>>;
    backup.db_schema_version = 1;
    data.captures = data.captures!.filter((capture) => capture.kind !== 'visit');
    for (const session of data.sessions!) delete session.archived_at;
    for (const source of data.sources!) delete source.note;
    for (const source of data.sources!) delete source.merged_ids;
    for (const capture of data.captures!) delete capture.frame;
    for (const capture of data.captures!) delete capture.navigation;
    for (const source of data.sources!) delete source.important;
    for (const jobSource of (data.jobs![0]!.sources as Array<Record<string, unknown>>)) delete jobSource.source_note;
    const check = await validateBackup(JSON.stringify(backup));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.backup.db_schema_version).toBe(DB_SCHEMA_VERSION);
    expect(check.backup.data.sessions).toEqual([expect.objectContaining({ archived_at: null })]);
    expect(check.backup.data.sources.every((s) => (s as { note: unknown }).note === '')).toBe(true);
    expect(check.backup.data.sources.every((s) => (s as { merged_ids: unknown }).merged_ids instanceof Array)).toBe(true);
    expect(check.backup.data.captures.every((c) => (c as { frame: unknown }).frame === null)).toBe(true);
    expect(check.backup.data.captures.every((c) => (c as { navigation: unknown }).navigation === null)).toBe(true);
    expect(check.backup.data.sources.every((s) => (s as { important: unknown }).important === false)).toBe(true);
  });

  it('writes the backup record by record within its size limit, and only measures it past the limit', async () => {
    const db = await populated();
    await createSession(db, 'Empty session');
    const read = (visit: Parameters<typeof visitAllData>[1]) => visitAllData(db, visit);
    const written = await writeBackup(read, () => settings, '2026-10-07T12:00:00.000Z');
    const text = written.parts.join('');
    expect(written.bytes).toBe(new TextEncoder().encode(text).length);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(createBackup(await readAllData(db), settings, '2026-10-07T12:00:00.000Z'))));
    expect((await validateBackup(text)).ok).toBe(true);
    expect(written.summary).toMatchObject({ sessions: 2, sources: 3, captures: 4, snapshots: 3, jobs: 1 });

    const over = await writeBackup(read, () => settings, '2026-10-07T12:00:00.000Z', written.bytes - 1);
    expect([over.parts.length, over.bytes]).toEqual([0, written.bytes]);
  });

  it('keeps only the fields it knows from a backup file', async () => {
    const backup = createBackup(await readAllData(await populated()), settings, '2026-10-07T12:00:00.000Z');
    const data = backup.data as unknown as Record<string, Array<Record<string, unknown>>>;
    for (const records of Object.values(data)) for (const record of records) record.hidden = 'carried along';
    (data.jobs![0]!.sources as Array<Record<string, unknown>>)[0]!.hidden = 'carried along';
    const check = await validateBackup(JSON.stringify(backup));
    expect(check.ok).toBe(true);
    if (check.ok) expect(JSON.stringify(check.backup.data)).not.toContain('carried along');
  });

  it('reports whether data was replaced when a restore step fails', async () => {
    const db = await populated();
    const backup = createBackup(await readAllData(db), settings, '2026-10-05T12:00:00.000Z');
    const fail = () => Promise.reject(new Error('storage refused'));
    const ok = () => Promise.resolve();
    expect(await restoreBackup(backup, { replaceData: fail, applySettings: ok })).toMatchObject({
      ok: false,
      dataReplaced: false,
      message: expect.stringContaining('current data is unchanged'),
    });
    const settingsFailed = await restoreBackup(backup, { replaceData: ok, applySettings: fail });
    expect(settingsFailed).toMatchObject({ ok: false, dataReplaced: true });
    expect(settingsFailed.message).toContain('Research data was restored');
    expect(settingsFailed.message).not.toContain('unchanged');
  });

  it('sends captures to the Inbox when a restore stopped before storing the active session', async () => {
    const db = await populated();
    const backup = createBackup(await readAllData(db), settings, '2026-10-05T12:00:00.000Z');
    const removed = await createSession(db, 'Not in the backup');
    await setActiveSessionId(removed.id);
    await replaceAllData(db, backup.data);
    expect(await resolveActiveSessionId(db)).toBe(INBOX_SESSION_ID);
    expect(await getActiveSessionId()).toBe(INBOX_SESSION_ID);
  });

  it('leaves existing data untouched when a restore write fails', async () => {
    const db = await populated();
    const before = await readAllData(db);
    const broken = structuredClone(before);
    (broken.sessions[0] as Record<string, unknown>).bad = () => undefined;
    await expect(replaceAllData(db, broken)).rejects.toThrow();
    expect(await readAllData(db)).toEqual(before);
  });
});
