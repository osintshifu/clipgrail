import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, createSession, loadSessionView, saveJob, latestJob, updateCaptureNote, updateSessionText } from '../src/lib/db';
import type { JobSettings } from '../src/lib/research-job';
import { DEFAULT_JOB_SETTINGS, buildResearchJob, fenced, isJobOutdated, researchJobToJson } from '../src/lib/research-job';
import { failedDraft, freshDb, linkDraft, pageDraft, selectionDraft } from './helpers';

async function sessionWithMaterial() {
  const db = await freshDb();
  const session = await createSession(db, 'Election claims');
  const s = session.id;
  const page = await commitCapture(db, await pageDraft('https://news.example.com/recount', 'Turnout was 61.2 percent.', '2026-10-05T10:00:00.000Z', s));
  await commitCapture(db, await selectionDraft('https://news.example.com/recount', 'The commission confirmed 61.2 percent.', '2026-10-05T10:05:00.000Z', s));
  await commitCapture(db, linkDraft('https://data.example.org/turnout.csv', '2026-10-05T10:06:00.000Z', 'https://news.example.com/recount', s));
  await commitCapture(db, failedDraft('https://maps.example.net/results', '2026-10-05T10:07:00.000Z', s));
  await updateSessionText(db, s, { prompt: 'Check the turnout figures.', notes: 'Ask the commission about late ballots.' });
  await updateCaptureNote(db, page.capture.id, 'First version, before the correction.');
  return { db, sessionId: s };
}

const settings = (overrides: Partial<JobSettings> = {}): JobSettings => ({ ...DEFAULT_JOB_SETTINGS, ...overrides });

describe('buildResearchJob', () => {
  it('separates TASK, RULES and SOURCE MATERIAL, keeps session S-IDs and marks missing material', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const view = await loadSessionView(db, sessionId);
    const failedId = view.sources[2]!.source.id;
    const job = buildResearchJob({ view, settings: settings({ excluded_source_ids: [failedId] }), id: 'job-1', createdAt: '2026-10-05T12:00:00.000Z' });

    const { text } = job;
    expect(text.indexOf('# TASK')).toBeLessThan(text.indexOf('# RULES'));
    expect(text.indexOf('# RULES')).toBeLessThan(text.indexOf('# SOURCE MATERIAL'));
    expect(text).toContain('Check the turnout figures.');
    expect(text).toContain('untrusted data');
    expect(text).toContain('[S1]');
    expect(job.sources.map((s) => s.label)).toEqual(['S1', 'S2']);
    expect(text).toContain('Snapshot: complete, 25 characters');
    expect(text).toContain('```text\nTurnout was 61.2 percent.\n```');
    expect(text).toContain('The commission confirmed 61.2 percent.');
    expect(text).toContain('MISSING: Snapshot pending');
    expect(text).not.toContain('maps.example.net');
    expect(job.stats).toMatchObject({ source_count: 2, missing_count: 1, partial_count: 0 });
    expect(job.stats.utf8_bytes).toBe(new TextEncoder().encode(text).length);

    // Private data stays out by default.
    expect(text).not.toContain('Ask the commission');
    expect(text).not.toContain('First version, before the correction.');
    expect(text).not.toContain('utm_source');
    expect(text).not.toContain('fbclid');
    expect(text).not.toContain('2026-10-05T10:0');
    expect(JSON.stringify(job.sources)).not.toContain('news.example.com/recount?');
  });

  it('includes each private field only when its own option is enabled', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const view = await loadSessionView(db, sessionId);
    const build = (s: Partial<JobSettings>) => buildResearchJob({ view, settings: settings(s), id: 'j', createdAt: 'now' }).text;

    const times = build({ include_capture_times: true });
    expect(times).toContain('Captured (page): 2026-10-05T10:00:00.000Z');
    expect(times).not.toContain('utm_source');

    const urls = build({ include_original_urls: true });
    expect(urls).toContain('<https://news.example.com/recount?utm_source=newsletter>');
    expect(urls).not.toContain('2026-10-05T10:00:00.000Z');

    const notes = build({ include_notes: true });
    expect(notes).toContain('Ask the commission about late ballots.');
    expect(notes).toContain('First version, before the correction.');

    const links = build({ include_link_context: true });
    expect(links).toContain('found on <https://news.example.com/recount>, link text "Turnout data"');
  });

  it('applies the per-source limit visibly and counts partial sources', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const view = await loadSessionView(db, sessionId);
    const job = buildResearchJob({ view, settings: settings({ max_chars_per_source: 45 }), id: 'j', createdAt: 'now' });
    const s1 = job.sources[0]!;
    // Selections are included first (38 characters), so only 7 snapshot characters fit.
    expect(s1.selections[0]!.shortened_by_limit).toBe(false);
    expect(s1.snapshot).toMatchObject({ character_count: 7, available_character_count: 25, shortened_by_limit: true });
    expect(s1.material).toBe('partial');
    expect(job.text).toContain('Snapshot: PARTIAL, shortened by the job limit to 7 of 25 characters');
    expect(job.text).toContain('[Snapshot text shortened here by the job limit.]');
    expect(job.stats.partial_count).toBe(1);
  });

  it('includes only titles and URLs in Links only mode', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const view = await loadSessionView(db, sessionId);
    const job = buildResearchJob({ view, settings: settings({ context_mode: 'links' }), id: 'j', createdAt: 'now' });
    expect(job.text).toContain('Context: Links only. 3 sources: [S1], [S2], [S3].');
    expect(job.text).not.toContain('Turnout was 61.2 percent.');
    expect(job.stats.missing_count).toBe(0);
  });

  it('escapes page titles and fences text containing backticks', async () => {
    const db = await freshDb();
    const draft = await pageDraft('https://example.com/x', 'Code: ```js\nalert(1)\n```', '2026-10-05T10:00:00.000Z');
    if (draft.snapshot?.status === 'ok') draft.snapshot.title = 'Hello ![img](https://tracker.example/p.png) <script>';
    const { source } = await commitCapture(db, draft);
    const view = await loadSessionView(db, source.session_id);
    const job = buildResearchJob({ view, settings: settings(), id: 'j', createdAt: 'now' });
    expect(job.text).toContain('## [S1] Hello \\!\\[img\\](https://tracker.example/p.png) \\<script\\>');
    expect(job.text).toContain('````text\nCode: ```js\nalert(1)\n```\n````');
  });
});

describe('fenced', () => {
  it('handles text with very many backtick runs and keeps the fence longer than any run', () => {
    expect(fenced('`x'.repeat(150_000))[0]).toBe('```text');
    expect(fenced('a ````` b')[0]).toBe('``````text');
  });
});

describe('generated jobs', () => {
  it('stay unchanged after the session changes and are detected as outdated', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const view = await loadSessionView(db, sessionId);
    const job = await saveJob(db, buildResearchJob({ view, settings: settings(), id: 'job-1', createdAt: '2026-10-05T12:00:00.000Z' }));

    await updateSessionText(db, sessionId, { prompt: 'A different task.' });
    await commitCapture(db, await pageDraft('https://news.example.com/new', 'New material', '2026-10-05T13:00:00.000Z', sessionId));
    const stored = await latestJob(db, sessionId);
    expect(stored).toEqual(job);

    const current = buildResearchJob({ view: await loadSessionView(db, sessionId), settings: settings(), id: 'x', createdAt: 'now' });
    expect(isJobOutdated(job, current)).toBe(true);
    const same = buildResearchJob({ view, settings: settings(), id: 'y', createdAt: 'later' });
    expect(isJobOutdated(job, same)).toBe(false);
    expect(isJobOutdated(job, buildResearchJob({ view, settings: settings({ include_notes: true }), id: 'z', createdAt: 'later' }))).toBe(true);
  });

  it('export the same content as Markdown and as versioned JSON', async () => {
    const { db, sessionId } = await sessionWithMaterial();
    const job = buildResearchJob({ view: await loadSessionView(db, sessionId), settings: settings(), id: 'job-1', createdAt: '2026-10-05T12:00:00.000Z' });
    const parsed = JSON.parse(researchJobToJson(job));
    expect(parsed.format).toBe('clipgrail-research-job');
    expect(parsed.format_version).toBe(1);
    expect(parsed.job.text).toBe(job.text);
    expect(parsed.job.sources.map((s: { label: string }) => s.label)).toEqual(['S1', 'S2', 'S3']);
  });
});
