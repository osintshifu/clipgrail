import type { CommitResult, SavedCapture } from './db';
import { commitCapture, hasSourceAddress } from './db';
import { carriesCredential, isProvenanceUrl, normalizeUrl } from './url';

/**
 * A recording saves the address of every page opened in one window, without
 * reading the pages. Kept in chrome.storage.session, so it ends with the browser.
 */
export interface Recording {
  window_id: number;
  started_at: string;
  /** Captures this recording saved, for Undo when it stops. */
  captures: SavedCapture[];
  /** Pages the browser refused to store; the recording is then incomplete and says so. */
  failed: number;
}

export const RECORDING_KEY = 'recording';

export function isRecording(value: unknown): value is Recording {
  const v = value as Partial<Recording> | null;
  return !!v && typeof v.window_id === 'number' && typeof v.started_at === 'string' && Array.isArray(v.captures) && typeof v.failed === 'number';
}

/** How Chrome says a page was reached (webNavigation transition type and qualifiers). */
export interface Navigation {
  transition: string;
  qualifiers: string[];
}

/** What a tab showed last during a recording, and where that page was found. */
export interface TrailEntry {
  url: string;
  found_on: string | null;
}

/**
 * The page a link or form on it led to this one: the tab's previous page, or
 * for a new tab the page that opened it. A typed address, a bookmark, a
 * reload or Back and Forward have none. A redirect by the page itself keeps
 * the origin of the navigation it continues. An address with a sign-in or
 * access credential is never kept as where a page was found.
 */
export function foundOnFor(navigation: Navigation, previous: TrailEntry | undefined, opener: string | null): string | null {
  const { transition, qualifiers } = navigation;
  let found: string | null = null;
  if (qualifiers.includes('client_redirect')) found = previous?.found_on ?? null;
  else if ((transition === 'link' || transition === 'form_submit') && !qualifiers.includes('forward_back')) found = previous?.url ?? opener;
  return found && isProvenanceUrl(found) && !carriesCredential(found) ? found : null;
}

export interface Visit {
  url: string;
  title: string;
  found_on: string | null;
  at: string;
}

/**
 * Saves a visited page as an address only (a PENDING snapshot, the page is
 * not read). Pages that are not web pages, addresses with a sign-in or access
 * credential and addresses the session already has are skipped.
 */
export async function recordVisit(db: IDBDatabase, sessionId: string, visit: Visit): Promise<CommitResult | null> {
  const dedupUrl = normalizeUrl(visit.url);
  if (!dedupUrl || carriesCredential(visit.url) || (await hasSourceAddress(db, sessionId, dedupUrl))) return null;
  return commitCapture(db, {
    session_id: sessionId,
    kind: 'tab',
    dedup_url: dedupUrl,
    captured_at: visit.at,
    original_url: visit.url,
    tab_title: visit.title,
    found_on: visit.found_on,
    anchor_text: null,
    fragment: null,
    snapshot: { status: 'pending' },
  });
}
