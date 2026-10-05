import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCaptures, loadSessionView } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { DEFAULT_JOB_SETTINGS, buildResearchJob } from '../src/lib/research-job';
import { chooseSnapshot } from '../src/lib/selection';
import { savedTabsMessage, tabDrafts } from '../src/lib/tabs';
import { freshDb, pageDraft } from './helpers';

describe('saving tabs', () => {
  it('saves only the address and title of web tabs, once per address, as PENDING', async () => {
    const db = await freshDb();
    await commitCaptures(db, [await pageDraft('https://example.com/a', 'Page text', '2026-10-05T10:00:00.000Z')]);
    const { drafts, skipped } = tabDrafts(
      [
        { url: 'https://example.com/b?utm_source=x', title: 'B page' },
        { url: 'chrome://settings/', title: 'Settings' },
        { url: 'https://example.com/a', title: 'A page' },
        { url: 'https://example.com/b', title: 'B again' },
        { title: 'Address not reported' },
      ],
      INBOX_SESSION_ID,
      '2026-10-05T11:00:00.000Z',
    );
    expect(skipped).toBe(2);
    expect(drafts.map((d) => [d.kind, d.dedup_url, d.original_url, d.tab_title])).toEqual([
      ['tab', 'https://example.com/b', 'https://example.com/b?utm_source=x', 'B page'],
      ['tab', 'https://example.com/a', 'https://example.com/a', 'A page'],
    ]);

    const results = await commitCaptures(db, drafts);
    expect(savedTabsMessage(results, skipped)).toBe(
      'Saved 2 tabs: 1 new source (S2), 1 already in this session (S1). Skipped 2 tabs without an http or https address.',
    );
    const view = await loadSessionView(db, INBOX_SESSION_ID);
    expect(view.sources.map((s) => chooseSnapshot(s).status)).toEqual(['ok', 'pending']);
    const job = buildResearchJob({ view, settings: DEFAULT_JOB_SETTINGS, id: 'j', createdAt: 'now' });
    expect(job.text).toContain('## [S2] B page');
    expect(job.text).toContain('MISSING: Snapshot pending: only the tab address was saved, so no text was captured.');
  });
});
