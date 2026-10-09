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
    await commitCapture(db, await pageDraft('https://docs.example.org/report', 'Version two of the report.', '2026-10-05T10:00:00.000Z'));
    const link = await commitCapture(db, linkDraft('https://news.example.net/statement', '2026-10-05T11:00:00.000Z', 'https://news.example.net/', strike.id));
    location.hash = `#view=all&source=${first.source.id}`;
    await import('../src/entrypoints/library/main');

    await vi.waitFor(() => expect($('reader').querySelector('h3')?.textContent).toBe('Example article'));
    expect(Array.from(document.querySelectorAll('#rows .sess')).map((e) => e.textContent)).toEqual(['Port strike', 'Inbox']);
    expect(versions().map((v) => [v.querySelector('.ver-title')?.textContent, v.getAttribute('aria-checked'), !!v.querySelector('.current-tag')])).toEqual([
      ['Capture 2 · Page', 'true', true],
      ['Capture 1 · Page', 'false', false],
    ]);
    expect(versions()[0]!.querySelector('.ver-meta')?.textContent).toContain('Text differs from capture\u00a01');
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version two of the report.'));

    // An earlier version is shown for reading; the current text stays marked as the one Research Jobs use.
    versions()[1]!.click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version one of the report.'));
    expect($('reader').querySelector('.banner.earlier')?.textContent).toContain('Research Jobs use the current text from capture 2');
    expect(versions()[0]!.querySelector('.current-tag')).not.toBeNull();
    $('show-current').click();
    await vi.waitFor(() => expect($('reader').querySelector('pre')?.textContent).toBe('Version two of the report.'));

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
  });
});
