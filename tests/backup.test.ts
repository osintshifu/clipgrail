import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Backup } from '../src/lib/backup';
import { createBackup, restoreBackup, validateBackup } from '../src/lib/backup';
import { commitCapture, loadSessionView, readAllData, replaceAllData, saveJob } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { buildResearchJob, DEFAULT_JOB_SETTINGS } from '../src/lib/research-job';
import { DEFAULT_PRESETS } from '../src/lib/settings';
import { freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

async function populated() {
  const db = await freshDb();
  await commitCapture(db, await pageDraft('https://example.com/a', 'Alpha text', '2026-10-05T10:00:00.000Z'));
  await commitCapture(db, await selectionDraft('https://example.com/a', 'Alpha', '2026-10-05T10:01:00.000Z'));
  await commitCapture(db, linkDraft('https://example.com/b', '2026-10-05T10:02:00.000Z', 'https://example.com/a'));
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
    expect(check.summary).toMatchObject({ sessions: 1, sources: 2, captures: 3, snapshots: 2, jobs: 1 });

    expect(check.backup.settings.job_settings).toEqual(settings.job_settings);

    const target = await freshDb();
    await commitCapture(target, await pageDraft('https://other.example/z', 'to be replaced', '2026-10-05T09:00:00.000Z'));
    await replaceAllData(target, check.backup.data);
    expect(await readAllData(target)).toEqual(data);

    const next = await commitCapture(target, await pageDraft('https://example.com/c', 'c', '2026-10-05T13:00:00.000Z'));
    expect(next.source.number).toBe(3);
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
    ];
    for (const [name, change] of cases) {
      expect((await broken(change)).ok, name).toBe(false);
    }
  });

  it('accepts a backup from database schema 1 and fills the fields added later', async () => {
    const db = await populated();
    const backup = createBackup(await readAllData(db), settings, '2026-10-05T12:00:00.000Z') as unknown as Record<string, unknown>;
    const data = backup.data as Record<string, Array<Record<string, unknown>>>;
    backup.db_schema_version = 1;
    for (const session of data.sessions!) delete session.archived_at;
    for (const source of data.sources!) delete source.note;
    for (const jobSource of (data.jobs![0]!.sources as Array<Record<string, unknown>>)) delete jobSource.source_note;
    const check = await validateBackup(JSON.stringify(backup));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.backup.db_schema_version).toBe(2);
    expect(check.backup.data.sessions).toEqual([expect.objectContaining({ archived_at: null })]);
    expect(check.backup.data.sources.every((s) => (s as { note: unknown }).note === '')).toBe(true);
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

  it('leaves existing data untouched when a restore write fails', async () => {
    const db = await populated();
    const before = await readAllData(db);
    const broken = structuredClone(before);
    (broken.sessions[0] as Record<string, unknown>).bad = () => undefined;
    await expect(replaceAllData(db, broken)).rejects.toThrow();
    expect(await readAllData(db)).toEqual(before);
  });
});
