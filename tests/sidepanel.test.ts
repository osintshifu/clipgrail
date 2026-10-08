// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_BACKUP_BYTES } from '../src/lib/backup';
import { fmtMegabytes } from '../src/lib/describe';
import { commitCapture, createSession, listSessions, loadSessionView, moveSource, openDb, updateCaptureNote, updateSessionText } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import { recordVisit } from '../src/lib/recording';
import { pageDraft } from './helpers';

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const fake = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  storageListeners: [] as StorageListener[],
  copied: [] as string[],
  tabsPermission: false,
  /** Messages the panel sent to the background, and what the background answers. */
  messages: [] as unknown[],
  response: undefined as unknown,
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
    runtime: {
      sendMessage: async (message: unknown) => {
        fake.messages.push(message);
        return fake.response;
      },
    },
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
/** A change the background made in session storage. */
function backgroundStores(key: string, value: unknown) {
  for (const listener of fake.storageListeners) listener({ [key]: { newValue: value } }, 'session');
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
    const services = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#bar-result .service'));
    expect(services().every((b) => b.disabled)).toBe(true);

    // Each chat service is one click away: it copies the job and opens the service.
    $('generate').click();
    await vi.waitFor(() => expect(copy.disabled).toBe(false));
    expect(services().map((b) => b.textContent)).toEqual(['ChatGPT', 'Claude', 'Gemini', 'Perplexity']);
    services()[1]!.click();
    await vi.waitFor(() => expect(fake.copied).toHaveLength(1));
    expect(fake.copied[0]).toContain('Edited here');
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

  it('deletes the open source and the active session only after confirmation, and shows what is stored', async () => {
    const db = await openDb();
    const second = (await listSessions(db)).find((s) => s.name === 'Second')!;
    await vi.waitFor(() => expect($('session-name').textContent).toBe('Second'));
    $('tab-collect').click();
    await vi.waitFor(() => expect(document.querySelector('#source-list .src')).not.toBeNull());
    const before = (await loadSessionView(db, second.id)).sources;
    document.querySelector<HTMLButtonElement>('#source-list .src')!.click();
    const label = $('detail-panel').querySelector('.sid')!.textContent!;

    // Cancel has focus and keeps the source.
    $('delete-source').click();
    await vi.waitFor(() => expect($('sheet-title').textContent).toBe(`Delete ${label}?`));
    expect($('sheet-body').textContent).toContain(`${label} is not given to another source.`);
    expect(document.activeElement?.textContent).toBe('Cancel');
    (document.activeElement as HTMLButtonElement).click();
    expect((await loadSessionView(db, second.id)).sources).toHaveLength(before.length);

    $('delete-source').click();
    await vi.waitFor(() => expect(document.getElementById('confirm-delete')).not.toBeNull());
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe(`${label} deleted.`));
    expect((await loadSessionView(db, second.id)).sources).toHaveLength(before.length - 1);

    // A file larger than any backup is not read at all.
    const huge = new File(['{}'], 'clipgrail-backup.json', { type: 'application/json' });
    Object.defineProperty(huge, 'size', { value: MAX_BACKUP_BYTES + 1 });
    huge.text = () => Promise.reject(new Error('read'));
    Object.defineProperty($('restore-file'), 'files', { value: [huge], configurable: true });
    $('restore-file').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect($('sheet-body').textContent).toContain(`This file is larger than a ClipGrail backup can be (${fmtMegabytes(MAX_BACKUP_BYTES)}). It was not read; your data is unchanged.`));
    $('restore-cancel').click();

    // The menu shows what is stored and when the last backup was made.
    fake.local.lastBackupAt = '2026-10-06T10:00:00.000Z';
    $('menu-button').click();
    await vi.waitFor(() => expect($('storage-summary').textContent).toMatch(/^\d+ sessions? · \d+ sources? · \d+ captures?\d[\d,]* characters?Last backup: 2026-10-06 \d\d:00$/));
    $('menu-button').click();

    // Deleting the active session switches the panel to the Inbox.
    $('session-button').click();
    await vi.waitFor(() => expect(Array.from(document.querySelectorAll('#sheet-body button')).some((b) => b.textContent === 'Delete session…')).toBe(true));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#sheet-body button')).find((b) => b.textContent === 'Delete session…')!.click();
    await vi.waitFor(() => expect($('sheet-title').textContent).toBe('Delete session "Second"?'));
    expect($('sheet-body').textContent).toContain('New clips will go to the Inbox.');
    $('confirm-delete').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('Session "Second" deleted. New clips go to the Inbox.'));
    expect($('session-name').textContent).toBe('Inbox');
    expect((await listSessions(db)).some((s) => s.id === second.id)).toBe(false);
    expect(fake.local.activeSessionId).toBe(INBOX_SESSION_ID);
  });

  it('stores what the toolbar button opens and shows a choice made in another ClipGrail page', async () => {
    const checked = () => Array.from(document.querySelectorAll('#menu [role="menuitemradio"]')).map((b) => `${b.textContent}:${b.getAttribute('aria-checked')}`);
    expect(checked()).toEqual(['Side panel:true', 'Popup:false']);
    $('menu-button').click();
    $('open-in-popup').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('The toolbar button now opens a popup.'));
    expect(fake.local.toolbarOpens).toBe('popup');
    expect(checked()).toEqual(['Side panel:false', 'Popup:true']);
    storeElsewhere('toolbarOpens', 'panel');
    expect(checked()).toEqual(['Side panel:true', 'Popup:false']);
  });

  it('records only with Chrome permission, shows what it saved and could not save, and undoes the recorded pages after it stops', async () => {
    fake.tabsPermission = false;
    $('record-button').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toContain('Recording not started'));
    expect(fake.messages).toHaveLength(0);

    fake.tabsPermission = true;
    fake.response = { captures: [], failed: 0, error: 'Session storage is full.' };
    $('record-button').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('Recording not started: Session storage is full.'));
    fake.response = { captures: [], failed: 0 };
    $('record-button').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toContain('Recording. Pages you open'));
    expect(fake.messages).toEqual([1, 2].map(() => ({ type: 'record', action: 'start', windowId: 1 })));
    // The background saves the pages opened in this window and reports them in session storage.
    const db = await openDb();
    const visit = await recordVisit(db, INBOX_SESSION_ID, { url: 'https://port.example.org/closures', title: 'Night closures', found_on: null, at: '2026-10-07T09:00:00.000Z' });
    const saved = [{ capture_id: visit!.capture.id, session_id: visit!.capture.session_id }];
    backgroundStores('recording', { window_id: 1, started_at: '2026-10-07T08:59:00.000Z', captures: saved, failed: 1 });
    // The button turns into Stop and tells what was saved and what could not be; clicking it again stops.
    expect($('record-button').getAttribute('aria-pressed')).toBe('true');
    expect($('record-button').title).toBe('Recording: 1 page saved, 1 could not be saved. Click to stop.');

    fake.response = { captures: saved, failed: 1 };
    $('record-button').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('Recording stopped. 1 page saved; 1 could not be saved.'));
    expect(fake.messages.at(-1)).toEqual({ type: 'record', action: 'stop', windowId: 1 });
    backgroundStores('recording', undefined);
    expect($('record-button').getAttribute('aria-pressed')).toBe('false');
    $('toast-undo').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('Recorded pages removed. Earlier captures are kept.'));
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources.some((s) => s.source.id === visit!.source.id)).toBe(false);
  });

  it('keeps the sites not recorded from pasted addresses and refuses a line that is not a site', async () => {
    const save = () => document.querySelector<HTMLButtonElement>('#sheet-body .sheet-actions .primary')!.click();
    $('excluded-sites-button').click();
    await vi.waitFor(() => expect($('sheet-title').textContent).toBe('Sites not recorded'));
    $<HTMLTextAreaElement>('excluded-sites').value = 'https://Mail.Google.com/mail/u/0\nnot a site';
    save();
    await vi.waitFor(() => expect($('sheet-body').querySelector('.alert-text')?.textContent).toBe('Not a site: not a site. Write a site such as example.org, one per line.'));
    expect(fake.local.recordingExcludedSites).toBeUndefined();

    $<HTMLTextAreaElement>('excluded-sites').value = 'https://Mail.Google.com/mail/u/0\n\nonline.mybank.example\nmail.google.com';
    save();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('2 sites are not recorded.'));
    expect(fake.local.recordingExcludedSites).toEqual(['mail.google.com', 'online.mybank.example']);
    $('excluded-sites-button').click();
    await vi.waitFor(() => expect($<HTMLTextAreaElement>('excluded-sites').value).toBe('mail.google.com\nonline.mybank.example'));
    document.querySelector<HTMLButtonElement>('#sheet-body .sheet-actions button:not(.primary)')!.click();
  });

  it('says when a recording moves between windows, and keeps Undo in the window it left', async () => {
    fake.tabsPermission = true;
    backgroundStores('recording', { window_id: 2, started_at: '2026-10-07T10:00:00.000Z', captures: [], failed: 0 });
    expect($('record-button').title).toBe('Recording in another window; record this window instead');
    fake.response = { captures: [], failed: 0, moved: { saved: 12 } };
    $('record-button').click();
    await vi.waitFor(() =>
      expect($('toast-text').textContent).toMatch(/^Recording moved to this window from another one, where it saved 12 pages\. Pages you open here are saved to .+ as addresses\.$/),
    );

    // This window records a page, then a start in window 2 takes the recording there.
    const db = await openDb();
    const visit = await recordVisit(db, INBOX_SESSION_ID, { url: 'https://port.example.org/tides', title: 'Tides', found_on: null, at: '2026-10-07T10:05:00.000Z' });
    const saved = [{ capture_id: visit!.capture.id, session_id: visit!.capture.session_id }];
    backgroundStores('recording', { window_id: 1, started_at: '2026-10-07T10:01:00.000Z', captures: saved, failed: 0 });
    backgroundStores('recording', { window_id: 2, started_at: '2026-10-07T10:06:00.000Z', captures: [], failed: 0 });
    expect($('toast-text').textContent).toBe('Recording moved to another window. 1 page saved here.');
    $('toast-undo').click();
    await vi.waitFor(() => expect($('toast-text').textContent).toBe('Recorded pages removed. Earlier captures are kept.'));
    expect((await loadSessionView(db, INBOX_SESSION_ID)).sources.some((s) => s.source.id === visit!.source.id)).toBe(false);
  });
});
