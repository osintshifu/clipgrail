import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createBackup, validateBackup } from '../src/lib/backup';
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

const settings = { active_session_id: INBOX_SESSION_ID, presets: DEFAULT_PRESETS };

describe('backup and restore', () => {
  it('restores all records, relations and S-ID counters exactly', async () => {
    const source = await populated();
    const data = await readAllData(source);
    const json = JSON.stringify(createBackup(data, settings, '2026-10-05T12:00:00.000Z'));

    const check = await validateBackup(json);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.summary).toMatchObject({ sessions: 1, sources: 2, captures: 3, snapshots: 2, jobs: 1 });

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

  it('leaves existing data untouched when a restore write fails', async () => {
    const db = await populated();
    const before = await readAllData(db);
    const broken = structuredClone(before);
    (broken.sessions[0] as Record<string, unknown>).bad = () => undefined;
    await expect(replaceAllData(db, broken)).rejects.toThrow();
    expect(await readAllData(db)).toEqual(before);
  });
});
