import type { CaptureDraft, CommitResult } from './db';
import { sourceLabel } from './model';
import { plural } from './text';
import { normalizeUrl } from './url';

/** The tab fields used here; Chrome reports url and title only with the tabs permission. */
export interface TabAddress {
  url?: string;
  title?: string;
}

export interface TabDrafts {
  drafts: CaptureDraft[];
  /** Tabs without an http or https address, which are not saved. */
  skipped: number;
}

/**
 * Turns open tabs into address-only captures: the address and title of each
 * tab, with a PENDING snapshot, so the pages are not read. Tabs with the same
 * address are saved once, in tab order.
 */
export function tabDrafts(tabs: TabAddress[], sessionId: string, capturedAt: string): TabDrafts {
  const seen = new Set<string>();
  const drafts: CaptureDraft[] = [];
  let skipped = 0;
  for (const tab of tabs) {
    const dedupUrl = tab.url ? normalizeUrl(tab.url) : null;
    if (!tab.url || !dedupUrl) {
      skipped++;
      continue;
    }
    if (seen.has(dedupUrl)) continue;
    seen.add(dedupUrl);
    drafts.push({
      session_id: sessionId,
      kind: 'tab',
      dedup_url: dedupUrl,
      captured_at: capturedAt,
      original_url: tab.url,
      tab_title: tab.title ?? '',
      found_on: null,
      anchor_text: null,
      fragment: null,
      snapshot: { status: 'pending' },
    });
  }
  return { drafts, skipped };
}

/** For example "Saved 2 tabs: 1 new source (S6), 1 already in this session (S2)." */
export function savedTabsMessage(results: CommitResult[], skipped: number): string {
  const created = results.filter((r) => r.isNewSource).map((r) => sourceLabel(r.source));
  const existing = results.filter((r) => !r.isNewSource).map((r) => sourceLabel(r.source));
  const parts: string[] = [];
  if (created.length) {
    const labels = created.length <= 3 ? created.join(', ') : `${created[0]} to ${created[created.length - 1]}`;
    parts.push(`${plural(created.length, 'new source')} (${labels})`);
  }
  if (existing.length) {
    parts.push(`${existing.length} already in this session${existing.length <= 3 ? ` (${existing.join(', ')})` : ''}`);
  }
  const skippedText = skipped ? ` Skipped ${plural(skipped, 'tab')} without an http or https address.` : '';
  return `Saved ${plural(results.length, 'tab')}: ${parts.join(', ')}.${skippedText}`;
}
