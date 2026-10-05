// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { commitCapture, createSession, listSessions, loadSessionView, moveSource, openDb, updateCaptureNote, updateSessionText } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { pageDraft } from './helpers';

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const fake = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  storageListeners: [] as StorageListener[],
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
      onChanged: { addListener: (listener: StorageListener) => void fake.storageListeners.push(listener) },
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
/** A setting stored by another ClipGrail page; Chrome reports it to this page as a storage change. */
function storeElsewhere(key: string, value: unknown) {
  fake.local[key] = structuredClone(value);
  for (const listener of fake.storageListeners) listener({ [key]: { newValue: value } }, 'local');
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
    $('tab-job').click();
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

    // A note edited in Clips shows the job as outdated when the Research Job view opens again.
    $('generate').click();
    await vi.waitFor(() => expect(copy.disabled).toBe(false));
    $('tab-collect').click();
    document.querySelector<HTMLButtonElement>('#source-list .src')!.click();
    $('detail-tab-captures').click();
    type(`note-${a.capture.id}`, 'Edited here');
    $('tab-job').click();
    expect(copy.disabled).toBe(true);
    expect($('job-stale').hidden).toBe(false);
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

  it('shows changes made in another ClipGrail page without losing the note being typed', async () => {
    const db = await openDb();
    const elsewhere = new BroadcastChannel('clipgrail-data');
    const changedElsewhere = () => elsewhere.postMessage({ type: 'data-changed' });
    $('tab-collect').click();
    const before = document.querySelectorAll('#source-list .src').length;
    document.querySelector<HTMLButtonElement>('#source-list .src')!.click();
    $('source-note').focus();
    type('source-note', 'Typed while another window saves');

    await commitCapture(db, await pageDraft('https://example.com/from-another-window', 'new text', '2026-10-05T12:00:00.000Z'));
    changedElsewhere();
    await vi.waitFor(() => expect(document.querySelectorAll('#source-list .src')).toHaveLength(before + 1));
    expect(document.activeElement?.id).toBe('source-note');
    expect($<HTMLTextAreaElement>('source-note').value).toBe('Typed while another window saves');

    // The open source is moved away in another window: the panel says so instead of silently closing it.
    const open = (await loadSessionView(db, INBOX_SESSION_ID)).sources[0]!;
    const second = (await listSessions(db)).find((s) => s.name === 'Second')!;
    await moveSource(db, open.source.id, second.id);
    changedElsewhere();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('S1 is no longer in this session. It was moved, or its capture was undone, in another ClipGrail window.'));
    expect($('detail-panel').hidden).toBe(true);
    elsewhere.close();
  });

  it('uses the prompt, notes and settings changed in another window when copying and generating', async () => {
    const db = await openDb();
    const settingsKey = `jobSettings.${INBOX_SESSION_ID}`;
    $('tab-job').click();
    type('prompt', 'Prompt typed here');
    type('session-notes', 'SECRET line');
    $<HTMLInputElement>('inc-notes').checked = true;
    $('inc-notes').dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await loadSessionView(db, INBOX_SESSION_ID)).session.notes).toBe('SECRET line'));
    $('generate').click();
    await vi.waitFor(() => expect($('job-preview').textContent).toContain('SECRET line'));
    const copied = fake.copied.length;

    // Another window removes the note, rewrites the prompt and turns Notes off; its announcement has not arrived yet.
    await updateSessionText(db, INBOX_SESSION_ID, { prompt: 'Prompt from another window', notes: '' });
    fake.local[settingsKey] = { ...(fake.local[settingsKey] as object), include_notes: false };
    $('copy-job').click();
    await vi.waitFor(() => expect($('delivery-status').hidden).toBe(false));
    expect($('delivery-status').textContent).toBe('Settings changed. Generate a new Research Job.');
    expect(fake.copied).toHaveLength(copied);
    expect($<HTMLTextAreaElement>('prompt').value).toBe('Prompt from another window');
    expect($<HTMLInputElement>('inc-notes').checked).toBe(false);

    $('generate-again').click();
    await vi.waitFor(() => expect($('job-preview').textContent).toContain('Prompt from another window'));
    expect($('job-preview').textContent).not.toContain('SECRET');
    expect((await loadSessionView(db, INBOX_SESSION_ID)).session.prompt).toBe('Prompt from another window');
  });

  it('saves typing for the session shown while another page switches the active session', async () => {
    const db = await openDb();
    const second = (await listSessions(db)).find((s) => s.name === 'Second')!;
    const secondPrompt = (await loadSessionView(db, second.id)).session.prompt;
    storeElsewhere('activeSessionId', second.id);
    type('prompt', 'Inbox prompt, typed during the switch');
    await vi.waitFor(() => expect($('session-name').textContent).toBe('Second'));
    expect($<HTMLTextAreaElement>('prompt').value).toBe(secondPrompt);
    await vi.waitFor(async () => expect((await loadSessionView(db, INBOX_SESSION_ID)).session.prompt).toBe('Inbox prompt, typed during the switch'));
    expect((await loadSessionView(db, second.id)).session.prompt).toBe(secondPrompt);
  });
});
