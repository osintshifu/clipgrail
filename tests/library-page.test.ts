// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { commitCapture, createSession, openDb } from '../src/lib/db';
import { linkDraft, pageDraft } from './helpers';

const fake = vi.hoisted(() => ({ local: {} as Record<string, unknown> }));

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
