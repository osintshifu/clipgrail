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
    expect(document.querySelector('[data-session="inbox"]')).toBeNull();
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
    await vi.waitFor(() => expect(fake.local.libraryLayout).toEqual({ sessions_hidden: true, reader_expanded: true }));

    // With no source open the list comes back, so there is always something to pick from.
    location.hash = '#view=all';
    await vi.waitFor(() => expect(document.body.classList.contains('reader-expanded')).toBe(false));
    expect(document.getElementById('expand-reader')).toBeNull();
    $('show-sessions').click();
    expect(document.body.classList.contains('sessions-hidden')).toBe(false);
  });
});
