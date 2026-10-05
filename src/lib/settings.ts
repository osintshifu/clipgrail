import { browser } from 'wxt/browser';
import { INBOX_SESSION_ID } from './model';
import type { JobSettings } from './research-job';
import { DEFAULT_JOB_SETTINGS } from './research-job';

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
const JOB_SETTINGS_KEY = 'jobSettings';

export async function getActiveSessionId(): Promise<string> {
  const stored = await browser.storage.local.get(ACTIVE_SESSION_KEY);
  const id = stored[ACTIVE_SESSION_KEY];
  return typeof id === 'string' && id ? id : INBOX_SESSION_ID;
}

export async function setActiveSessionId(id: string): Promise<void> {
  await browser.storage.local.set({ [ACTIVE_SESSION_KEY]: id });
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
  const stored = await browser.storage.local.get(JOB_SETTINGS_KEY);
  const all = stored[JOB_SETTINGS_KEY] as Record<string, unknown> | undefined;
  return all?.[sessionId] ? cleanJobSettings(all[sessionId]) : { ...DEFAULT_JOB_SETTINGS };
}

export async function saveJobSettings(sessionId: string, settings: JobSettings): Promise<void> {
  const stored = await browser.storage.local.get(JOB_SETTINGS_KEY);
  const all = { ...((stored[JOB_SETTINGS_KEY] as Record<string, unknown> | undefined) ?? {}) };
  all[sessionId] = cleanJobSettings(settings);
  await browser.storage.local.set({ [JOB_SETTINGS_KEY]: all });
}
