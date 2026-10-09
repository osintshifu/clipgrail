import { browser } from 'wxt/browser';
import { hasSession } from './db';
import { INBOX_SESSION_ID } from './model';
import type { JobSettings } from './research-job';
import { DEFAULT_JOB_SETTINGS } from './research-job';
import { siteHost } from './url';

/** Settings and UI state kept in chrome.storage.local (research data lives in IndexedDB). */

export interface Preset {
  id: 'analyze' | 'compare' | 'fact_check' | 'custom';
  name: string;
  text: string;
}

export const DEFAULT_PRESETS: Preset[] = [
  {
    id: 'analyze',
    name: 'Analyze',
    text: 'Analyze the sources. Summarize the main points, the key claims and the evidence offered for them, and point out gaps or contradictions.',
  },
  {
    id: 'compare',
    name: 'Compare',
    text: 'Compare the sources. Show where they agree, where they differ, and what might explain the differences.',
  },
  {
    id: 'fact_check',
    name: 'Fact Check',
    text: 'Fact-check the significant claims in the sources. For each claim, say whether the provided material supports it, contradicts it or does not address it.',
  },
  { id: 'custom', name: 'Custom', text: '' },
];

const ACTIVE_SESSION_KEY = 'activeSessionId';
const PRESETS_KEY = 'presets';
const LIBRARY_LAYOUT_KEY = 'libraryLayout';
/** When the last backup file was handed to Chrome for download; whether it was saved is not known. */
const LAST_BACKUP_KEY = 'lastBackupAt';
/** One key per session, so saving one session's settings never rewrites another's. */
const JOB_SETTINGS_PREFIX = 'jobSettings.';

export async function getActiveSessionId(): Promise<string> {
  const stored = await browser.storage.local.get(ACTIVE_SESSION_KEY);
  const id = stored[ACTIVE_SESSION_KEY];
  return typeof id === 'string' && id ? id : INBOX_SESSION_ID;
}

export async function setActiveSessionId(id: string): Promise<void> {
  await browser.storage.local.set({ [ACTIVE_SESSION_KEY]: id });
}

/**
 * The active session, or the Inbox when the stored session no longer exists
 * (a restore can replace the data and stop before it stores the active
 * session). The Inbox is then stored, so every ClipGrail page agrees.
 */
export async function resolveActiveSessionId(db: IDBDatabase): Promise<string> {
  const id = await getActiveSessionId();
  if (await hasSession(db, id)) return id;
  // Replace only the missing session, not one another page stored meanwhile.
  if ((await getActiveSessionId()) === id) await setActiveSessionId(INBOX_SESSION_ID);
  return INBOX_SESSION_ID;
}

/** Sites whose pages a recording skips (see recordVisit). Kept in this browser, not in backups. */
const EXCLUDED_SITES_KEY = 'recordingExcludedSites';

export async function getExcludedSites(): Promise<string[]> {
  const value: unknown = (await browser.storage.local.get(EXCLUDED_SITES_KEY))[EXCLUDED_SITES_KEY];
  return Array.isArray(value) ? value.filter((site): site is string => typeof site === 'string') : [];
}

export async function saveExcludedSites(sites: string[]): Promise<void> {
  await browser.storage.local.set({ [EXCLUDED_SITES_KEY]: sites });
}

/** The sites written one per line, without duplicates, or the first line that is not a site. */
export function parseSiteList(text: string): { sites: string[] } | { invalid: string } {
  const sites = new Set<string>();
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const site = siteHost(line);
    if (!site) return { invalid: line };
    sites.add(site);
  }
  return { sites: [...sites] };
}

export async function getLastBackupAt(): Promise<string | null> {
  const value = (await browser.storage.local.get(LAST_BACKUP_KEY))[LAST_BACKUP_KEY];
  return typeof value === 'string' ? value : null;
}

export async function setLastBackupAt(at: string): Promise<void> {
  await browser.storage.local.set({ [LAST_BACKUP_KEY]: at });
}

/** Columns the library hides in wide windows. */
export interface LibraryLayout {
  sessions_hidden: boolean;
  reader_expanded: boolean;
  /** Widths of the sessions and sources columns in CSS pixels, set by dragging their borders. */
  nav_width: number;
  list_width: number;
}

export interface WidthRange {
  min: number;
  max: number;
  initial: number;
}
export const NAV_WIDTH: WidthRange = { min: 180, max: 420, initial: 240 };
export const LIST_WIDTH: WidthRange = { min: 300, max: 760, initial: 412 };

export function clampWidth(value: unknown, range: WidthRange): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(range.max, Math.max(range.min, value))) : range.initial;
}

export async function getLibraryLayout(): Promise<LibraryLayout> {
  const stored = (await browser.storage.local.get(LIBRARY_LAYOUT_KEY))[LIBRARY_LAYOUT_KEY] as Partial<LibraryLayout> | undefined;
  return {
    sessions_hidden: stored?.sessions_hidden === true,
    reader_expanded: stored?.reader_expanded === true,
    nav_width: clampWidth(stored?.nav_width, NAV_WIDTH),
    list_width: clampWidth(stored?.list_width, LIST_WIDTH),
  };
}

export async function saveLibraryLayout(layout: LibraryLayout): Promise<void> {
  await browser.storage.local.set({ [LIBRARY_LAYOUT_KEY]: layout });
}

/** What the toolbar button opens. */
export type OpenMode = 'panel' | 'popup';
export const OPEN_MODE_KEY = 'toolbarOpens';

export async function getOpenMode(): Promise<OpenMode> {
  // The popup unless the user chose the side panel.
  return (await browser.storage.local.get(OPEN_MODE_KEY))[OPEN_MODE_KEY] === 'panel' ? 'panel' : 'popup';
}

export async function setOpenMode(mode: OpenMode): Promise<void> {
  await browser.storage.local.set({ [OPEN_MODE_KEY]: mode });
}

/** Returns the four presets; stored texts replace the defaults, names and order stay fixed. */
export function mergePresets(stored: unknown): Preset[] {
  const byId = new Map<string, string>();
  if (Array.isArray(stored)) {
    for (const p of stored) {
      if (p && typeof p === 'object' && typeof p.id === 'string' && typeof p.text === 'string') byId.set(p.id, p.text);
    }
  }
  return DEFAULT_PRESETS.map((p) => ({ ...p, text: byId.get(p.id) ?? p.text }));
}

export async function getPresets(): Promise<Preset[]> {
  const stored = await browser.storage.local.get(PRESETS_KEY);
  return mergePresets(stored[PRESETS_KEY]);
}

export async function savePresets(presets: Preset[]): Promise<void> {
  await browser.storage.local.set({ [PRESETS_KEY]: mergePresets(presets) });
}

function cleanJobSettings(value: unknown): JobSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<JobSettings>;
  const limit = v.max_chars_per_source;
  return {
    context_mode: v.context_mode === 'links' || v.context_mode === 'selections' ? v.context_mode : 'full',
    excluded_source_ids: Array.isArray(v.excluded_source_ids)
      ? v.excluded_source_ids.filter((id): id is string => typeof id === 'string')
      : [],
    max_chars_per_source: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null,
    include_notes: v.include_notes === true,
    include_link_context: v.include_link_context === true,
    include_capture_times: v.include_capture_times === true,
    include_original_urls: v.include_original_urls === true,
  };
}

export async function getJobSettings(sessionId: string): Promise<JobSettings> {
  const key = JOB_SETTINGS_PREFIX + sessionId;
  const stored = await browser.storage.local.get(key);
  return stored[key] ? cleanJobSettings(stored[key]) : { ...DEFAULT_JOB_SETTINGS };
}

export async function saveJobSettings(sessionId: string, settings: JobSettings): Promise<void> {
  await browser.storage.local.set({ [JOB_SETTINGS_PREFIX + sessionId]: cleanJobSettings(settings) });
}

/** Takes deleted sources out of a session's Research Job selection; `all` after the session was emptied. */
export async function dropExcludedSources(sessionId: string, sourceIds: string[] | 'all'): Promise<void> {
  const settings = await getJobSettings(sessionId);
  const kept = sourceIds === 'all' ? [] : settings.excluded_source_ids.filter((id) => !sourceIds.includes(id));
  if (kept.length !== settings.excluded_source_ids.length) await saveJobSettings(sessionId, { ...settings, excluded_source_ids: kept });
}

/** Removes the Research Job settings of a deleted session. */
export async function removeJobSettings(sessionId: string): Promise<void> {
  await browser.storage.local.remove(JOB_SETTINGS_PREFIX + sessionId);
}

/** Research Job settings of every session, keyed by session ID (for backups). */
export async function getAllJobSettings(): Promise<Record<string, JobSettings>> {
  const stored = await browser.storage.local.get(null);
  const all = Object.create(null) as Record<string, JobSettings>;
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(JOB_SETTINGS_PREFIX)) all[key.slice(JOB_SETTINGS_PREFIX.length)] = cleanJobSettings(value);
  }
  return all;
}

/**
 * Replaces the Research Job settings of all sessions (restore): sessions missing from `all` get defaults.
 * The new settings are written before old keys are removed, so a failure in between leaves no session without its settings.
 */
export async function replaceAllJobSettings(all: Record<string, JobSettings>): Promise<void> {
  const entries = Object.entries(all).map(([id, s]) => [JOB_SETTINGS_PREFIX + id, cleanJobSettings(s)] as const);
  if (entries.length) await browser.storage.local.set(Object.fromEntries(entries));
  const stored = await browser.storage.local.get(null);
  const obsolete = Object.keys(stored).filter((k) => k.startsWith(JOB_SETTINGS_PREFIX) && !Object.hasOwn(all, k.slice(JOB_SETTINGS_PREFIX.length)));
  if (obsolete.length) await browser.storage.local.remove(obsolete);
}
