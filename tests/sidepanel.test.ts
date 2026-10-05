// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { commitCapture, createSession, loadSessionView, openDb, updateCaptureNote, updateSessionText } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { pageDraft } from './helpers';

const fake = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  copied: [] as string[],
  tabsPermission: false,
  tabs: [] as Array<{ index: number; highlighted: boolean; url?: string; title?: string }>,
}));
const tabEvent = vi.hoisted(() => ({ addListener: () => undefined }));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (keys: string | string[] | null) => {
          if (keys === null) return { ...fake.local };
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in fake.local).map((k) => [k, fake.local[k]]));
        },
        set: async (values: Record<string, unknown>) => void Object.assign(fake.local, structuredClone(values)),
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete fake.local[k];
        },
      },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    commands: { getAll: async () => [] },
    runtime: { sendMessage: async () => undefined },
    tabs: {
      create: async () => ({}),
      query: async (query: { highlighted?: boolean }) => fake.tabs.filter((t) => !query.highlighted || t.highlighted),
      onCreated: tabEvent,
      onRemoved: tabEvent,
      onHighlighted: tabEvent,
      onAttached: tabEvent,
      onDetached: tabEvent,
    },
    permissions: {
      request: async () => fake.tabsPermission,
      contains: async () => fake.tabsPermission,
      remove: async () => !(fake.tabsPermission = false),
    },
  },
}));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function pickSession(name: string) {
  $('session-button').click();
  return vi.waitFor(() => {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body .pick')).find((b) => b.textContent?.startsWith(name));
    expect(row).toBeTruthy();
    row!.click();
  });
}
function type(id: string, value: string) {
  const el = $<HTMLTextAreaElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('side panel', () => {
  it('saves every edit and never hands over an outdated Research Job', async () => {
    vi.stubGlobal('crypto', webcrypto);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => void fake.copied.push(text) },
      configurable: true,
    });
    document.documentElement.innerHTML = readFileSync('src/entrypoints/sidepanel/index.html', 'utf8');
    const db = await openDb();
    const second = await createSession(db, 'Second');
    const a = await commitCapture(db, await pageDraft('https://example.com/a', 'text A', '2026-10-05T10:00:00.000Z'));
    const b = await commitCapture(db, await pageDraft('https://example.com/a', 'text A v2', '2026-10-05T10:01:00.000Z'));
    await updateSessionText(db, INBOX_SESSION_ID, { prompt: 'Initial prompt' });
    await import('../src/entrypoints/sidepanel/main');
    await vi.waitFor(() => expect(document.querySelectorAll('#source-list .src')).toHaveLength(1));

    // Two notes edited right after each other are both saved.
    document.querySelector<HTMLButtonElement>('#source-list .src')!.click();
    $('detail-tab-captures').click();
    type(`note-${a.capture.id}`, 'First note');
    type(`note-${b.capture.id}`, 'Second note');
    await vi.waitFor(async () =>
      expect((await loadSessionView(db, INBOX_SESSION_ID)).sources[0]!.captures.map((c) => c.capture.note)).toEqual([
        'First note',
        'Second note',
      ]),
    );

    // A prompt edit followed at once by a session switch is saved for the session it was typed in.
    type('prompt', 'Changed Inbox prompt');
    await pickSession('Second');
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('prompt').value).toBe(''));
    type('prompt', 'Second session prompt');
    await vi.waitFor(async () => {
      expect((await loadSessionView(db, INBOX_SESSION_ID)).session.prompt).toBe('Changed Inbox prompt');
      expect((await loadSessionView(db, second.id)).session.prompt).toBe('Second session prompt');
    });

    // Back in the Inbox: generate a job that includes notes.
    await pickSession('Inbox');
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('prompt').value).toBe('Changed Inbox prompt'));
    expect(second.id).not.toBe(INBOX_SESSION_ID);
    $<HTMLInputElement>('inc-notes').checked = true;
    $('inc-notes').dispatchEvent(new Event('change'));
    $('generate').click();
    await vi.waitFor(() => expect($('job-preview').textContent).toContain('Second note'));
    const copy = $<HTMLButtonElement>('copy-job');
    expect(copy.disabled).toBe(false);

    // A note changed elsewhere (another window): Copy re-reads the data and refuses the outdated job.
    await updateCaptureNote(db, b.capture.id, 'Changed in another window');
    copy.click();
    await vi.waitFor(() => expect($('delivery-status').textContent).toBe('Settings changed. Generate a new Research Job.'));
    expect(fake.copied).toHaveLength(0);
    expect(copy.disabled).toBe(true);
    expect($('job-stale').hidden).toBe(false);

    // A note edited in this panel marks the job outdated immediately.
    $('generate').click();
    await vi.waitFor(() => expect(copy.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>('#source-list .src')!.click();
    $('detail-tab-captures').click();
    type(`note-${a.capture.id}`, 'Edited here');
    expect(copy.disabled).toBe(true);
  });

  it('saves tabs only with Chrome permission, as addresses without text, and Undo removes the save', async () => {
    const db = await openDb();
    const count = async () => (await loadSessionView(db, INBOX_SESSION_ID)).sources.length;
    const before = await count();
    fake.tabs = [
      { index: 1, highlighted: false, url: 'https://example.com/tab-b', title: 'Tab B' },
      { index: 0, highlighted: true, url: 'chrome://newtab/', title: 'New Tab' },
    ];
    const saveAll = () => {
      $('tabs-button').click();
      $('save-all').click();
    };
    saveAll();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe("Tabs not saved: ClipGrail needs Chrome's permission to read tab addresses."));
    expect(await count()).toBe(before);

    fake.tabsPermission = true;
    saveAll();
    await vi.waitFor(() =>
      expect($('toast-text').textContent).toBe('Saved 1 tab: 1 new source (S2). Skipped 1 tab without an http or https address.'),
    );
    const saved = (await loadSessionView(db, INBOX_SESSION_ID)).sources.at(-1)!;
    expect(saved.captures.map((c) => [c.capture.kind, c.capture.tab_title, c.snapshot?.status])).toEqual([['tab', 'Tab B', 'pending']]);
    $('toast-undo').click();
    await vi.waitFor(async () => expect(await count()).toBe(before));
  });
});
