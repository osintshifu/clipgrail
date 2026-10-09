import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitCapture, createSession, loadLibrary, updateCaptureNote, updateSourceNote, visitSnapshotTexts } from '../src/lib/db';
import { libraryRows, textIdsOf } from '../src/lib/library';
import type { PageCode } from '../src/lib/model';
import { collectPivots, filterPivots, textFinds } from '../src/lib/pivots';
import type { TextFind } from '../src/lib/pivots';
import { freshDb, pageDraft, selectionDraft } from './helpers';

describe('pivots', () => {
  it('lists each value with the sources it is in, one use per source from its newest capture, values on more sites first', async () => {
    const db = await freshDb();
    const strike = await createSession(db, 'Port strike');
    const code = (gtm: string, author: string, x: string): PageCode => ({
      declared: [
        { field: 'author', value: author, from: ['meta author'] },
        { field: 'x_account', value: x, from: ['twitter:site'] },
        { field: 'generator', value: 'WordPress 6.6', from: ['meta generator'] },
      ],
      trackers: [{ kind: 'gtm', id: gtm, where: ['inline_script'] }],
    });
    // The same GTM container and author on two sites in two sessions; the second site writes the name and account differently, and
    // the first, clipped again later, writes the name in capitals. Notes are private and not read.
    const blog = await commitCapture(db, { ...(await pageDraft('https://blog.example.org/a', 'Tips: tips@harbour.example.org.', '2026-10-01T10:00:00.000Z')), page_code: code('GTM-W8R3KD', 'Anna Nowák', '@HarbourWatch') });
    await commitCapture(db, { ...(await pageDraft('https://www.union.example.com/b', 'Statement.', '2026-10-02T10:00:00.000Z', strike.id)), page_code: code('GTM-W8R3KD', 'anna  nowak', 'https://x.com/HarbourWatch') });
    const blogAgain = await commitCapture(db, { ...(await pageDraft('https://blog.example.org/a', 'Tips: tips@harbour.example.org.', '2026-10-06T10:00:00.000Z')), page_code: code('GTM-W8R3KD', 'ANNA NOWAK', '@HarbourWatch') });
    await updateSourceNote(db, blog.source.id, 'Ask secret@note.example.org');
    await updateCaptureNote(db, blog.capture.id, 'And secret@note.example.org again');
    // Two sites whose template left the X account empty.
    for (const site of ['https://q.example.org/', 'https://r.example.org/']) {
      await commitCapture(db, { ...(await pageDraft(site, 'Empty.', '2026-10-07T10:00:00.000Z', strike.id)), page_code: { declared: [{ field: 'x_account', value: '@', from: ['twitter:site'] }], trackers: [] } });
    }
    // Two pages of one site with one container; the address is in the earlier text of the first and in a selection of the second.
    await commitCapture(db, { ...(await pageDraft('https://port.example.org/41', 'Press: TIPS@harbour.example.org', '2026-10-03T10:00:00.000Z', strike.id)), page_code: code('GTM-5JX9ZQ', 'Port desk', '@port') });
    await commitCapture(db, { ...(await pageDraft('https://port.example.org/41', 'Notice withdrawn.', '2026-10-04T10:00:00.000Z', strike.id)), page_code: code('GTM-5JX9ZQ', 'Port desk', '@port') });
    await commitCapture(db, await selectionDraft('https://port.example.org/42', 'IBAN DE89 3704 0044 0532 0130 00, mail tips@harbour.example.org', '2026-10-05T10:00:00.000Z', strike.id));
    await commitCapture(db, { ...(await pageDraft('https://port.example.org/42', 'Berths.', '2026-10-05T11:00:00.000Z', strike.id)), page_code: code('GTM-5JX9ZQ', 'Port desk', '@port') });

    const entries = libraryRows(await loadLibrary(db)).map((row) => row.entry);
    const finds = new Map<string, TextFind[]>();
    await visitSnapshotTexts(db, entries.flatMap(textIdsOf), (id, text) => !!finds.set(id, textFinds(text)));
    const pivots = collectPivots(entries, (id) => finds.get(id));
    const label = (url: string) => url.replace('https://', '');
    expect(pivots.map((p) => [p.key, p.value, p.sites.join(' '), p.sessions, p.uses.map((u) => `${label(u.entry.source.dedup_url)} ${u.where}`)])).toEqual([
      ['email tips@harbour.example.org', 'tips@harbour.example.org', 'blog.example.org port.example.org', 2, [
        'blog.example.org/a Saved text', 'port.example.org/41 Earlier text · capture 1', 'port.example.org/42 Selection',
      ]],
      ['gtm GTM-W8R3KD', 'GTM-W8R3KD', 'blog.example.org union.example.com', 2, ['blog.example.org/a inline script', 'www.union.example.com/b inline script']],
      ['author anna nowak', 'Anna Nowák', 'blog.example.org union.example.com', 2, ['blog.example.org/a meta author', 'www.union.example.com/b meta author']],
      ['x harbourwatch', '@HarbourWatch', 'blog.example.org union.example.com', 2, ['blog.example.org/a twitter:site', 'www.union.example.com/b twitter:site']],
      ['gtm GTM-5JX9ZQ', 'GTM-5JX9ZQ', 'port.example.org', 1, ['port.example.org/41 inline script', 'port.example.org/42 inline script']],
      ['author port desk', 'Port desk', 'port.example.org', 1, ['port.example.org/41 meta author', 'port.example.org/42 meta author']],
      ['x port', '@port', 'port.example.org', 1, ['port.example.org/41 twitter:site', 'port.example.org/42 twitter:site']],
      ['iban DE89 3704 0044 0532 0130 00', 'DE89 3704 0044 0532 0130 00', 'port.example.org', 1, ['port.example.org/42 Selection']],
    ]);
    // A source's use opens its newest capture with the value, also when only an earlier text has it, and a value in a text keeps the passage around it.
    const port41 = entries.find((e) => e.source.dedup_url === 'https://port.example.org/41')!;
    expect(pivots.find((p) => p.key === 'gtm GTM-5JX9ZQ')!.uses[0]!.capture_id).toBe(port41.captures[1]!.capture.id);
    expect(pivots.find((p) => p.key === 'author anna nowak')!.uses[0]!.capture_id).toBe(blogAgain.capture.id);
    const mail = pivots.find((p) => p.kind === 'email')!.uses[1]!;
    expect(mail.capture_id).toBe(port41.captures[0]!.capture.id);
    expect([mail.raw, mail.snippet]).toEqual(['TIPS@harbour.example.org', { text: 'Press: TIPS@harbour.example.org', marks: [[7, 31]], cut_before: false, cut_after: false }]);

    const filtered = (filter: Partial<Parameters<typeof filterPivots>[1]>) =>
      filterPivots(pivots, { query: '', group: 'all', shared: true, ...filter }).map((p) => p.value);
    expect(filtered({})).toEqual(['tips@harbour.example.org', 'GTM-W8R3KD', 'Anna Nowák', '@HarbourWatch', 'GTM-5JX9ZQ', 'Port desk', '@port']);
    expect(filtered({ group: 'tracker' })).toEqual(['GTM-W8R3KD', 'GTM-5JX9ZQ']);
    // A value is found also as another source wrote it.
    expect(filtered({ query: 'x.com/harbourwatch' })).toEqual(['@HarbourWatch']);
    expect(filtered({ shared: false, query: 'de89370400440532013000' })).toEqual(['DE89 3704 0044 0532 0130 00']);
    expect(filtered({ query: '"x account" harbour' })).toEqual(['@HarbourWatch']);
  });

  it('joins a value read from the links or text of a page to the same value in saved text and to the X account another page declares', async () => {
    const db = await freshDb();
    await commitCapture(db, {
      ...(await pageDraft('https://b.example.net/statement', 'Statement.', '2026-10-01T10:00:00.000Z')),
      page_code: { declared: [{ field: 'x_account', value: '@HarbourWatch', from: ['twitter:site'] }], trackers: [], values: [{ kind: 'email', value: 'tips@harbour.example.org', where: ['page_text'] }] },
    });
    await commitCapture(db, {
      ...(await pageDraft('https://a.example.org/', 'Write to tips@harbour.example.org.', '2026-10-02T10:00:00.000Z')),
      page_code: {
        declared: [],
        trackers: [],
        values: [
          { kind: 'email', value: 'tips@harbour.example.org', where: ['link', 'page_text'] },
          { kind: 'x', value: '@harbourwatch', where: ['link'] },
        ],
      },
    });
    const entries = libraryRows(await loadLibrary(db)).map((row) => row.entry);
    const finds = new Map<string, TextFind[]>();
    await visitSnapshotTexts(db, entries.flatMap(textIdsOf), (id, text) => !!finds.set(id, textFinds(text)));
    // A value also in the saved text opens there, with the passage around it.
    expect(collectPivots(entries, (id) => finds.get(id)).map((p) => [p.key, p.value, p.uses.map((u) => `${u.entry.source.dedup_url} ${u.where} ${!!u.snippet}`)])).toEqual([
      ['email tips@harbour.example.org', 'tips@harbour.example.org', ['https://b.example.net/statement Page text false', 'https://a.example.org/ Saved text true']],
      ['x harbourwatch', '@HarbourWatch', ['https://b.example.net/statement twitter:site false', 'https://a.example.org/ Page link false']],
    ]);
  });
});
