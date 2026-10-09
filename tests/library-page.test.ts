// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { commitCapture, createSession, openDb, loadNote, loadSessionView, updateSourceNote, listSessions } from '../src/lib/db';
import { linkDraft, pageDraft } from './helpers';

const fake = vi.hoisted(() => ({ local: {} as Record<string, unknown>, refresh: () => undefined as void }));

vi.mock('../src/lib/changes', () => ({ announceDataChange: () => undefined, onDataChange: (fn: () => void) => { fake.refresh = fn; } }));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in fake.local).map((k) => [k, fake.local[k]]));
        },
        set: async (values: Record<string, unknown>) => void Object.assign(fake.local, values),
      },
      onChanged: { addListener: () => undefined },
    },
    runtime: { id: 'clipgrail-test' },
  },
}));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const versions = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#reader .ver'));

describe('library page', () => {
  it('opens a source from its address, reads earlier versions without changing the current one, and explains where clips go', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    Element.prototype.scrollIntoView = () => undefined;
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
    document.documentElement.innerHTML = readFileSync('src/entrypoints/library/index.html', 'utf8');
    const db = await openDb();
    const strike = await createSession(db, 'Port strike');
    const first = await commitCapture(db, await pageDraft('https://docs.example.org/report', 'Version one of the report.', '2026-10-01T10:00:00.000Z'));
    await commitCapture(db, {
      ...(await pageDraft('https://docs.example.org/report', 'Version two of the report.', '2026-10-05T10:00:00.000Z')),
      page_code: { declared: [], trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: ['inline_script', 'noscript'] }] },
    });
    const link = await commitCapture(db, linkDraft('https://news.example.net/statement', '2026-10-05T11:00:00.000Z', 'https://news.example.net/', strike.id));
    // A notice that changed in its first and last paragraphs, with four unchanged paragraphs between.
    const paragraphs = ['Berths 4 to 7 are closed.', 'Tugs are mandatory.', 'Waste reception is suspended.', 'Security level 1.', 'Dues are waived.', 'Questions: channel 12.'];
    const notice = await commitCapture(db, await pageDraft('https://port.example.org/notice', paragraphs.join('\n\n'), '2026-09-01T12:00:00.000Z'));
    const changedNotice = paragraphs.map((p, i) => (i === 0 ? 'Berths 4 to 8 are closed.' : i === 5 ? 'Questions: channel 14.' : p)).join('\n\n');
    const noticeLater = await commitCapture(db, await pageDraft('https://port.example.org/notice', changedNotice, '2026-09-02T12:00:00.000Z'));
    location.hash = `#view=all&source=${first.source.id}`;
    await import('../src/entrypoints/library/main');

    await vi.waitFor(() => expect($('reader').querySelector('h3')?.textContent).toBe('Example article'));
    expect(Array.from(document.querySelectorAll('#rows .sess')).map((e) => e.textContent)).toEqual(['Port strike', 'Inbox', 'Inbox']);
    expect(versions().map((v) => [v.querySelector('.ver-title')?.textContent, v.getAttribute('aria-checked'), !!v.querySelector('.current-tag')])).toEqual([
      ['Capture 2 · Page', 'true', true],
      ['Capture 1 · Page', 'false', false],
    ]);
    expect(versions()[0]!.querySelector('.ver-meta')?.textContent).toContain('Text differs from capture\u00a01');
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version two of the report.'));
    // Details show the trackers the viewed capture read from the page code.
    expect($('reader').querySelector('.page-code dl')?.textContent).toBe('Google Tag ManagerGTM-5JX9ZQ · inline script, noscript frame');

    // An earlier version is shown for reading; the current text stays marked as the one Research Jobs use.
    versions()[1]!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version one of the report.'));
    expect($('reader').querySelector('.banner.earlier')?.textContent).toContain('Research Jobs use the current text from capture 2');
    expect(versions()[0]!.querySelector('.current-tag')).not.toBeNull();
    $('show-current').click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version two of the report.'));

    // Comparing the current text with the earlier one marks the changed word; Close shows the text again.
    const compareWith = $<HTMLSelectElement>('compare-with');
    compareWith.value = first.capture.id;
    compareWith.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($('reader').querySelector('.diff-box')).not.toBeNull());
    expect($('reader').querySelector('.text-head')?.textContent).toBe('Changes from capture 1 to capture 2 · 1 change · 3 characters added, 3 removed');
    expect(Array.from(document.querySelectorAll('#reader .chg'), (c) => c.innerHTML)).toEqual(['<del>one</del><ins>two</ins>']);
    expect(versions()[1]!.querySelector('.compare-tag')).not.toBeNull();
    $('close-compare').click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version two of the report.'));
    expect($<HTMLSelectElement>('compare-with').value).toBe('');

    // The side panel opens a comparison of another source with the address; the address then keeps only the source.
    location.hash = `#view=all&source=${notice.source.id}&capture=${notice.capture.id}&compare=${noticeLater.capture.id}`;
    await vi.waitFor(() => expect($('reader').querySelector('.diff-box')).not.toBeNull());
    expect(location.hash).toBe(`#view=all&source=${notice.source.id}`);
    expect(versions().map((v) => v.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    // Unchanged paragraphs away from the changes are folded; Previous and Next move between changes and say what changed.
    const fold = document.querySelector<HTMLButtonElement>('#reader .diff-fold')!;
    expect([fold.textContent, fold.getAttribute('aria-label')]).toEqual(['2 unchanged paragraphs', 'Show 2 unchanged paragraphs']);
    $('next-change').click();
    expect([$('change-count').textContent, document.querySelector('#reader .chg.now')?.textContent]).toEqual(['2 of 2', '1214']);
    expect($('compare-said').textContent).toBe('Change 2 of 2: removed “12”, added “14”.');
    $('next-change').click();
    expect($('change-count').textContent).toBe('1 of 2');
    $('previous-change').click();
    expect($('change-count').textContent).toBe('2 of 2');
    fold.click();
    await vi.waitFor(() => expect($('reader').querySelector('.diff-fold')).toBeNull());
    expect($('reader').querySelector('.diff-box')?.textContent).toContain('Waste reception is suspended.');
    // Leaving the source ends the comparison.
    document.querySelector<HTMLButtonElement>(`#rows [data-id="${first.source.id}"]`)!.click();
    document.querySelector<HTMLButtonElement>(`#rows [data-id="${notice.source.id}"]`)!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre.text-box')).not.toBeNull());
    expect($('reader').querySelector('.diff-box')).toBeNull();

    // A source of another session without text: clips go to the active session unless that session is made active.
    (document.querySelector<HTMLButtonElement>(`#rows [data-id="${link.source.id}"]`))!.click();
    expect($('reader').querySelector('.banner.info')?.textContent).toBe(
      'Clip page saves to the active session, Inbox. To add the text to S1, make Port strike active, open the page and clip it.Make active',
    );
    $('make-active').click();
    await vi.waitFor(() => expect($('reader').querySelector('.banner.info')).toBeNull());
    expect(fake.local.activeSessionId).toBe(strike.id);
    expect(location.hash).toBe(`#view=all&source=${link.source.id}`);
  });
});


describe('organizing in the library', () => {
  async function openExample(name: string) {
    const db = await openDb();
    const session = await createSession(db, name);
    const capture = await commitCapture(db, await pageDraft(`https://example.test/${name}`, 'Controlled text.', new Date().toISOString(), session.id));
    document.querySelector<HTMLButtonElement>('#nav-list > .nav-item')!.click();
    fake.refresh();
    await vi.waitFor(() => expect(document.querySelector(`#rows [data-id="${capture.source.id}"]`)).not.toBeNull());
    document.querySelector<HTMLButtonElement>(`#rows [data-id="${capture.source.id}"]`)!.click();
    return { db, session, capture };
  }

  it('writes both notes for the panel reader and preserves a focused draft on external edits without writing it back on blur', async () => {
    const { db, session, capture } = await openExample('Notes');
    const id = `source-note-${capture.source.id}`;
    const note = $<HTMLTextAreaElement>(id);
    note.focus();
    note.value = 'Library note';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(async () => expect((await loadSessionView(db, session.id)).sources[0]!.source.note).toBe('Library note'));
    note.setSelectionRange(3, 7);
    await updateSourceNote(db, capture.source.id, 'Panel note');
    fake.refresh();
    await vi.waitFor(() => expect(note.closest('.note-editor')!.querySelector('.note-warning')?.textContent).toContain('Changed elsewhere'));
    expect(document.activeElement).toBe(note);
    expect([note.value, note.selectionStart, note.selectionEnd]).toEqual(['Library note', 3, 7]);
    note.blur();
    await vi.waitFor(() => expect(note.value).toBe('Panel note'));
    expect(await loadNote(db, 'source', capture.source.id)).toBe('Panel note');
    note.focus();
    note.value = 'Latest library edit';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    const captureNote = $<HTMLTextAreaElement>(`capture-note-${capture.capture.id}`);
    captureNote.value = 'Observation';
    captureNote.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(async () => {
      const view = await loadSessionView(db, session.id);
      expect(view.sources[0]!.source.note).toBe('Latest library edit');
      expect(view.sources[0]!.captures[0]!.capture.note).toBe('Observation');
    });
  });

  it('joins a moved source, shows the target, and clears exclusions of the source session rather than the active session', async () => {
    const { db, session, capture } = await openExample('Move');
    const target = await createSession(db, 'Target');
    const existing = await commitCapture(db, await pageDraft(capture.source.dedup_url, 'Target text.', new Date().toISOString(), target.id));
    fake.local[`jobSettings.${session.id}`] = { excluded_source_ids: [capture.source.id, 'another-source'] };
    fake.local.activeSessionId = 'inbox';
    fake.refresh();
    await vi.waitFor(() => expect(document.querySelector(`[data-session="${target.id}"]`)).not.toBeNull());
    $('move-source').click();
    document.querySelector<HTMLButtonElement>(`[data-target="${target.id}"]`)!.click();
    await vi.waitFor(() => expect($('library-notice').textContent).toContain('joined'));
    expect(location.hash).toBe(`#view=${target.id}&source=${existing.source.id}`);
    expect($('reader').querySelector('.crumb')!.textContent).toContain('Target');
    expect((fake.local[`jobSettings.${session.id}`] as { excluded_source_ids: string[] }).excluded_source_ids).toEqual(['another-source']);
    expect((await loadSessionView(db, session.id)).sources).toHaveLength(0);
    expect((await loadSessionView(db, target.id)).sources[0]!.captures).toHaveLength(2);
  });

  it('archives the active session to Inbox, keeps its data and unarchives without changing the active session', async () => {
    const { db, session } = await openExample('Archive');
    fake.local.activeSessionId = session.id;
    document.querySelector<HTMLButtonElement>(`[data-session="${session.id}"]`)!.click();
    $('archive-session').click();
    await vi.waitFor(() => expect(fake.local.activeSessionId).toBe('inbox'));
    await vi.waitFor(() => expect($('library-notice').textContent).toContain('archived'));
    expect((await listSessions(db)).find((s) => s.id === session.id)!.archived_at).not.toBeNull();
    expect((await loadSessionView(db, session.id)).sources).toHaveLength(1);
    document.querySelector<HTMLButtonElement>(`[data-session="${session.id}"]`)!.click();
    expect($('archive-session').textContent).toBe('Unarchive session');
    $('archive-session').click();
    await vi.waitFor(async () => expect((await listSessions(db)).find((s) => s.id === session.id)!.archived_at).toBeNull());
    expect(fake.local.activeSessionId).toBe('inbox');
    // The Inbox can only be emptied, never archived.
    document.querySelector<HTMLButtonElement>('[data-session="inbox"]')!.click();
    expect([document.getElementById('archive-session'), document.getElementById('empty-inbox')?.textContent]).toEqual([null, 'Empty Inbox…']);
    // A press anywhere else closes the menu, and the click still opens what it was aimed at.
    const source = document.querySelector<HTMLButtonElement>('#rows .src')!;
    source.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    source.click();
    expect($<HTMLDialogElement>('library-dialog').open).toBe(false);
    await vi.waitFor(() => expect(source.getAttribute('aria-current')).toBe('true'));
  });

  it('hides the sessions and expands the reader only while a source is open, and remembers the layout', async () => {
    await openExample('Layout');
    $('hide-sessions').click();
    expect(document.body.classList.contains('sessions-hidden')).toBe(true);
    expect($('show-sessions').hidden).toBe(false);
    expect(document.activeElement?.id).toBe('show-sessions');

    const expand = () => $<HTMLButtonElement>('expand-reader');
    expect(expand().closest('.crumb')).not.toBeNull();
    expand().click();
    expect(document.body.classList.contains('reader-expanded')).toBe(true);
    expect(expand().getAttribute('aria-label')).toBe('Show all columns');
    await vi.waitFor(() => expect(fake.local.libraryLayout).toMatchObject({ sessions_hidden: true, reader_expanded: true }));

    // With no source open the list comes back, so there is always something to pick from.
    location.hash = '#view=all';
    await vi.waitFor(() => expect(document.body.classList.contains('reader-expanded')).toBe(false));
    expect(document.getElementById('expand-reader')).toBeNull();
    $('show-sessions').click();
    expect(document.body.classList.contains('sessions-hidden')).toBe(false);
  });

  it('changes the widths of the sessions and sources columns from their borders and remembers them', async () => {
    await openExample('Widths');
    const key = (id: string, init: KeyboardEventInit) => $(id).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    key('resize-list', { key: 'ArrowRight' });
    key('resize-list', { key: 'ArrowRight', shiftKey: true });
    expect(document.body.style.getPropertyValue('--list-w')).toBe('492px');
    expect($('resize-list').getAttribute('aria-valuenow')).toBe('492');
    await vi.waitFor(() => expect(fake.local.libraryLayout).toMatchObject({ nav_width: 240, list_width: 492 }));
    // Never narrower than the minimum, and a double-click restores the usual width.
    for (let i = 0; i < 10; i++) key('resize-nav', { key: 'ArrowLeft', shiftKey: true });
    expect(document.body.style.getPropertyValue('--nav-w')).toBe('180px');
    $('resize-nav').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(document.body.style.getPropertyValue('--nav-w')).toBe('240px');
  });

  it('deletes the open source and empties the Inbox after confirmation', async () => {
    const { db, session, capture } = await openExample('Delete');
    $('delete-source').click();
    await vi.waitFor(() => expect(document.getElementById('confirm-delete')).not.toBeNull());
    expect($('library-dialog').querySelector('h2')!.textContent).toBe('Delete S1?');
    expect(document.activeElement?.textContent).toBe('Cancel');
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('S1 deleted.'));
    expect((await loadSessionView(db, session.id)).sources).toHaveLength(0);
    expect(location.hash).not.toContain(capture.source.id);

    const inboxSources = (await loadSessionView(db, 'inbox')).sources.length;
    expect(inboxSources).toBeGreaterThan(0);
    document.querySelector<HTMLButtonElement>('[data-session="inbox"]')!.click();
    $('empty-inbox').click();
    await vi.waitFor(() => expect($('library-dialog').querySelector('h2')!.textContent).toBe('Empty Inbox?'));
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('Inbox emptied.'));
    expect((await loadSessionView(db, 'inbox')).sources).toHaveLength(0);
    expect((await listSessions(db)).some((s) => s.id === 'inbox')).toBe(true);
  });

  it('selects several sources with checkboxes, Shift+click and Ctrl+click and deletes them together', async () => {
    const { db, session } = await openExample('Several');
    for (const n of [2, 3, 4]) await commitCapture(db, await pageDraft(`https://example.test/several-${n}`, `Text ${n}.`, new Date(Date.now() + n * 1000).toISOString(), session.id));
    fake.refresh();
    document.querySelector<HTMLButtonElement>(`[data-session="${session.id}"]`)!.closest('.nav-row')!.querySelector<HTMLButtonElement>('.nav-item')!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#rows .src')).toHaveLength(4));
    expect($('selection-bar').hidden).toBe(true);
    const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('#rows .pick-box'));
    const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .src'));

    // Checkbox, then Shift+click selects the range; Ctrl+click takes one out again.
    boxes()[0]!.click();
    rows()[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(boxes().map((b) => b.checked)).toEqual([true, true, true, false]);
    rows()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true, false]);
    expect($('selection-count').textContent).toBe('2 of 4 selected');
    expect($<HTMLInputElement>('select-all').indeterminate).toBe(true);

    $('delete-selected').click();
    await vi.waitFor(() => expect($('library-dialog').querySelector('h2')?.textContent).toBe('Delete 2 sources?'));
    expect($('library-dialog').textContent).toContain('S2 and S4 are deleted with their 2 captures');
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('2 sources deleted.'));
    expect((await loadSessionView(db, session.id)).sources).toHaveLength(2);
    expect($('selection-bar').hidden).toBe(true);

    // Select all shown, then a new view starts without a selection.
    $<HTMLInputElement>('select-all').click();
    expect(boxes().every((b) => b.checked)).toBe(true);
    document.querySelector<HTMLButtonElement>('#nav-list > .nav-item')!.click();
    expect($('selection-bar').hidden).toBe(true);
  });

  it('shows a session as a timeline, opens the capture an event names, and marks and filters important sources', async () => {
    const { db, session, capture } = await openExample('Timeline');
    const page = capture.source.dedup_url;
    // While recording, a link on the page led to another page, and the page was opened again later.
    const recorded = { ...linkDraft('https://example.test/timeline-next', '2026-10-01T09:00:00.000Z', page, session.id), kind: 'tab' as const, anchor_text: null };
    await commitCapture(db, { ...recorded, navigation: { transition: 'link', qualifiers: [], in_page: false } });
    await commitCapture(db, {
      ...recorded,
      kind: 'visit',
      dedup_url: page,
      original_url: page,
      found_on: null,
      captured_at: '2026-10-02T09:00:00.000Z',
      navigation: { transition: 'typed', qualifiers: [], in_page: false },
      snapshot: null,
    });
    fake.refresh();
    const events = () => Array.from(document.querySelectorAll('#rows .tl-what')).map((e) => e.textContent);
    // All sources has no timeline; a session has.
    $('mode-timeline').click();
    expect(location.hash).not.toContain('mode=timeline');
    Array.from(document.querySelectorAll<HTMLButtonElement>('#nav-list .nav-item')).find((b) => b.textContent?.startsWith('Timeline'))!.click();
    expect($('mode-switch').hidden).toBe(false);
    $('mode-timeline').click();
    await vi.waitFor(() => expect(events()).toEqual(['Opened · Link from S1', 'Visited again · Typed address', 'Clipped · 16 characters']));
    expect(location.hash).toContain('mode=timeline');
    expect($('result-count').textContent).toBe('3 events');

    // An event opens its source at that capture; the page shows its return visit and the page it led to.
    const event = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .tl-event')).find((b) => b.textContent?.includes(text))!;
    event('Opened').click();
    await vi.waitFor(() => expect(versions().map((v) => v.getAttribute('aria-checked'))).toEqual(['true']));
    expect($('reader').querySelector('.ver-title')?.textContent).toBe('Capture 1 · Tab');
    event('Clipped').click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Controlled text.'));
    expect(Array.from($('reader').querySelectorAll('.path-block')).map((b) => b.textContent)).toEqual([
      'Visited again · 12026-10-02 11:00 · Typed address'.replace('11:00', new Date('2026-10-02T09:00:00.000Z').toTimeString().slice(0, 5)),
      'Led to · 1S2https://example.test/timeline-next',
    ]);

    // Marked important, the source has a star in the list and passes the Important filter alone.
    $('important-source').click();
    await vi.waitFor(() => expect($('important-source').getAttribute('aria-pressed')).toBe('true'));
    expect((await loadSessionView(db, session.id)).sources.find((s) => s.source.id === capture.source.id)?.source.important).toBe(true);
    $('important-filter').click();
    expect(events()).toEqual(['Visited again · Typed address', 'Clipped · 16 characters']);
    expect($('result-count').textContent).toBe('2 of 3 events');
    $('mode-sources').click();
    expect(Array.from(document.querySelectorAll('#rows .src .star')).length).toBe(1);
    expect($('result-count').textContent).toMatch(/^1 of 2 sources$/);
    $('clear-filters').click();
    expect(location.hash).not.toContain('mode=timeline');
  });

  it('lists the values found in several sources, shows the sources of one, opens a source where it is, and lists those sources', async () => {
    // jsdom has no layout; the reader scrolls to the marked value by its position.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    const { db, session, capture } = await openExample('Pivots');
    const code = { declared: [], trackers: [{ kind: 'ga4' as const, id: 'G-PIV0T2K9QX', where: ['script_address' as const] }] };
    const wallet = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const a = await commitCapture(db, { ...(await pageDraft('https://a.example.test/', `Donate: ${wallet}.`, '2026-10-06T10:00:00.000Z', session.id)), page_code: code });
    const b = await commitCapture(db, { ...(await pageDraft('https://b.example.test/', `Fund ${wallet}`, '2026-10-06T11:00:00.000Z', session.id)), page_code: code });
    fake.refresh();
    Array.from(document.querySelectorAll<HTMLButtonElement>('#nav-list .nav-item')).find((n) => n.textContent?.startsWith('Pivots'))!.click();
    // Each list keeps its own search.
    const search = $<HTMLInputElement>('search');
    search.value = 'a.example';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect($('result-count').textContent).toBe('1 of 3 sources'));
    $('mode-pivots').click();
    await vi.waitFor(() => expect($('result-count').textContent).toBe('2 shared of 2 values'));
    expect([search.value, search.placeholder]).toEqual(['', 'Search values']);
    $('mode-sources').click();
    expect(search.value).toBe('a.example');
    $('mode-pivots').click();
    expect(location.hash).toBe(`#view=${session.id}&mode=pivots&source=${capture.source.id}`);
    const values = () => Array.from(document.querySelectorAll('#rows .pv-row'), (r) => r.textContent);
    expect(values()).toEqual([
      'GA4G-PIV0T2K9QX2 sourcesGoogle Analytics 4 · a.example.test, b.example.test',
      `BTC${wallet}2 sourcesBitcoin address · a.example.test, b.example.test`,
    ]);
    // The kind and the search narrow the values; the search of sources is kept for the Sources list.
    const kind = $<HTMLSelectElement>('pivot-kind');
    kind.value = 'text';
    kind.dispatchEvent(new Event('change'));
    expect([values(), $('result-count').textContent]).toEqual([[`BTC${wallet}2 sourcesBitcoin address · a.example.test, b.example.test`], '1 of 2 values']);
    $('clear-filters').click();
    search.value = 'btc';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(values()).toEqual([`BTC${wallet}2 sourcesBitcoin address · a.example.test, b.example.test`]));
    search.value = 'g-piv0t';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(values().map((v) => v?.slice(0, 15))).toEqual(['GA4G-PIV0T2K9QX']));

    // The open value lists its sources; one opens at the capture where the value was found, with Details open for page code.
    document.querySelector<HTMLButtonElement>('#rows .pv-row')!.click();
    expect($('reader').querySelector('h3')?.textContent).toBe('G-PIV0T2K9QX');
    expect($('reader').querySelector('.status-line')?.textContent).toBe('In 2 sources on 2 sites. Read from the page code when the pages were clipped.');
    expect(Array.from(document.querySelectorAll('#reader .pv-use .pv-use-meta'), (m) => m.textContent)).toEqual(['a.example.test · script address', 'b.example.test · script address']);
    document.querySelector<HTMLButtonElement>(`#reader .pv-use[data-id="${b.source.id}"]`)!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe(`Fund ${wallet}`));
    expect($('reader').querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
    expect(document.querySelector('#rows .pv-row')?.getAttribute('aria-current')).toBe('true');

    // Copy puts the value on the clipboard.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    document.querySelector<HTMLButtonElement>('#rows .pv-row')!.click();
    $('copy-pivot').click();
    await vi.waitFor(() => expect($('copy-pivot').textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith('G-PIV0T2K9QX');

    // Show sources lists the sources the value is in, until its filter is removed with its button or Clear filters.
    $('show-pivot-sources').click();
    expect([$('mode-sources').getAttribute('aria-pressed'), search.value, $('pivot-filter').textContent, $('result-count').textContent]).toEqual(['true', '', 'G-PIV0T2K9QX', '2 of 3 sources']);
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .src'), (r) => r.dataset.id).sort()).toEqual([a.source.id, b.source.id].sort());
    $('pivot-filter').click();
    expect([$('pivot-filter').hidden, $('result-count').textContent]).toEqual([true, '3 sources']);
    $('mode-pivots').click();
    document.querySelector<HTMLButtonElement>('#rows .pv-row')!.click();
    $('show-pivot-sources').click();
    $('clear-filters').click();
    expect([$('pivot-filter').hidden, $('result-count').textContent]).toEqual([true, '3 sources']);
  });

  it('finds a source by its saved text, shows where, and opens the earlier version the words are in', async () => {
    // jsdom has no layout; the reader scrolls to the first match by its position.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    const { db, session } = await openExample('Search');
    await commitCapture(db, await pageDraft('https://example.test/search-versions', 'Harbour cranes were repaired.', '2026-10-02T10:00:00.000Z', session.id));
    await commitCapture(db, await pageDraft('https://example.test/search-versions', 'Night closures continue.', '2026-10-03T10:00:00.000Z', session.id));
    fake.refresh();
    const search = $<HTMLInputElement>('search');
    search.value = 'CRANES';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect($('result-count').textContent).toMatch(/^1 of /));
    const row = document.querySelector<HTMLButtonElement>('#rows .src')!;
    expect(row.querySelector('.src-snippet')?.textContent).toBe('Earlier text · capture 1Harbour cranes were repaired.');
    expect(row.querySelector('.src-snippet mark')?.textContent).toBe('cranes');
    row.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Harbour cranes were repaired.'));
    expect($('reader').querySelector('.banner.earlier')).not.toBeNull();
    // Back on the current text, a click on the open source's row shows the capture with the words again.
    $('show-current').click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Night closures continue.'));
    document.querySelector<HTMLButtonElement>('#rows .src')!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Harbour cranes were repaired.'));

    // A tracker ID is found in the page code; the source opens with Details showing it.
    await commitCapture(db, {
      ...(await pageDraft('https://example.test/search-code', 'Berth notice.', '2026-10-04T10:00:00.000Z', session.id)),
      page_code: { declared: [], trackers: [{ kind: 'gtm', id: 'GTM-K7Q2P9', where: ['inline_script'] }] },
    });
    fake.refresh();
    search.value = 'gtm-k7q2p9';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(document.querySelector('#rows .src .src-snippet')?.textContent).toBe('Page codeGTM-K7Q2P9'));
    document.querySelector<HTMLButtonElement>('#rows .src')!.click();
    await vi.waitFor(() => expect($('reader').querySelector('h3')?.textContent).toBe('Example article'));
    expect($('reader').querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
  });

  it('notes a deleted source in the deletion log, shows what its label was, and removes entries from the log', async () => {
    // The search of the test before is still on.
    $('clear-filters').click();
    const { db, session, capture } = await openExample('Gaps');
    const second = await commitCapture(db, await pageDraft('https://example.test/gaps-second', 'Second.', '2026-10-09T10:00:00.000Z', session.id));
    fake.refresh();
    await vi.waitFor(() => expect(document.querySelector(`#rows [data-id="${second.source.id}"]`)).not.toBeNull());
    $('delete-source').click();
    await vi.waitFor(() => expect($('library-dialog').textContent).toContain('Its label, title and address stay in the deletion log.'));
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('S1 deleted.'));
    // S2 moves to the Inbox.
    document.querySelector<HTMLButtonElement>(`#rows [data-id="${second.source.id}"]`)!.click();
    $('move-source').click();
    document.querySelector<HTMLButtonElement>('#library-dialog [data-target="inbox"]')!.click();
    await vi.waitFor(() => expect($('library-notice').textContent).toMatch(/^Moved S2 to Inbox as S\d+\.$/));

    // The log lists the removals; the session filter keeps the entries of one session.
    Array.from(document.querySelectorAll<HTMLButtonElement>('#nav-list .nav-item')).find((n) => n.textContent?.startsWith('Deletion log'))!.click();
    expect([$('list-title').textContent, location.hash, $('mode-switch').hidden]).toEqual(['Deletion log', '#view=deletion-log', true]);
    const sessionFilter = $<HTMLSelectElement>('log-session');
    sessionFilter.value = session.id;
    sessionFilter.dispatchEvent(new Event('change'));
    const entries = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#rows .dl-row'));
    const inboxLabel = `S${(await loadSessionView(db, 'inbox')).sources.find((s) => s.source.dedup_url === second.source.dedup_url)!.source.number}`;
    expect(entries().map((e) => e.querySelector('.tl-body')?.textContent)).toEqual([
      `MovedS2→ Inbox ${inboxLabel}GapsExample article · example.test`,
      'DeletedS1GapsExample article · example.test',
    ]);
    expect($('result-count').textContent).toMatch(/^2 of \d+ entries$/);
    // A moved source opens from its entry.
    entries()[0]!.click();
    expect($('reader').querySelector('.status-line')?.textContent).toMatch(/Moved with 1 capture to Inbox as S\d+\.$/);
    $('open-moved').click();
    expect([$('list-title').textContent, location.hash]).toEqual(['Inbox', `#view=inbox&source=${second.source.id}`]);
    Array.from(document.querySelectorAll<HTMLButtonElement>('#nav-list .nav-item')).find((n) => n.textContent?.startsWith('Deletion log'))!.click();
    sessionFilter.value = session.id;
    sessionFilter.dispatchEvent(new Event('change'));
    entries()[1]!.click();
    expect([$('reader').querySelector('h3')?.textContent, $('reader').querySelector('.dl-url')?.textContent]).toEqual(['S1 deleted', capture.source.dedup_url]);
    expect(location.hash).toMatch(/^#view=deletion-log&entry=/);
    // The search finds entries by a whole label, by title or by address.
    const search = $<HTMLInputElement>('search');
    const finds = async (words: string, verbs: string[]) => {
      search.value = words;
      search.dispatchEvent(new Event('input'));
      await vi.waitFor(() => expect(entries().map((e) => e.querySelector('.dl-verb')?.textContent)).toEqual(verbs));
    };
    await finds('s1', ['Deleted']);
    await finds('"example article" gaps-second', ['Moved']);
    search.value = 'no such page';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect($('list-empty').textContent).toBe('No entries match the search and session.Clear filters'));
    $('clear-filters').click();
    expect(sessionFilter.value).toBe('all');

    // One entry is removed after confirmation; Clear log removes the rest.
    $('remove-entry').click();
    await vi.waitFor(() => expect($('library-dialog').querySelector('h2')!.textContent).toBe('Remove this entry from the deletion log?'));
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('Entry removed from the deletion log.'));
    expect(entries().filter((e) => e.textContent?.includes('Gaps')).map((e) => e.querySelector('.dl-verb')?.textContent)).toEqual(['Moved']);
    $('clear-log').click();
    await vi.waitFor(() => expect($('library-dialog').querySelector('h2')!.textContent).toBe('Clear the deletion log?'));
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('library-notice').textContent).toBe('Deletion log cleared.'));
    expect([$('result-count').textContent, $<HTMLButtonElement>('clear-log').disabled]).toEqual(['0 entries', true]);
  });

  it('keeps focus on a version whose ID would break a CSS selector, as one from an edited backup can', async () => {
    const db = await openDb();
    const ids = vi.spyOn(crypto, 'randomUUID');
    for (const id of ['odd-source', 'c"1', 'odd-snapshot-1', 'c\\2', 'odd-snapshot-2']) ids.mockReturnValueOnce(id as `${string}-${string}-${string}-${string}-${string}`);
    await commitCapture(db, await pageDraft('https://odd.example.org/a', 'First text.', '2026-10-06T10:00:00.000Z'));
    await commitCapture(db, await pageDraft('https://odd.example.org/a', 'Second text.', '2026-10-06T11:00:00.000Z'));
    ids.mockRestore();
    fake.refresh();
    location.hash = '#view=all&source=odd-source';
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Second text.'));
    versions()[1]!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('First text.'));
    expect((document.activeElement as HTMLElement).dataset.id).toBe('c"1');
  });
});
