import type { CommitResult, SavedCapture } from './db';
import { commitRecordedPage } from './db';
import type { CaptureNavigation } from './model';
import { carriesCredential, isOnSite, isProvenanceUrl, normalizeUrl } from './url';

/**
 * A recording saves the address of every page opened in one window, without
 * reading the pages. Kept in chrome.storage.session, so it ends with the browser.
 */
export interface Recording {
  window_id: number;
  started_at: string;
  /** Pages this recording saved, for the review and Undo when it stops. */
  captures: SavedCapture[];
  /** Returns to pages the session already had, removed by Undo too; absent in a recording started before visits were recorded. */
  visits?: SavedCapture[];
  /** Pages the browser refused to store; the recording is then incomplete and says so. */
  failed: number;
}

export const RECORDING_KEY = 'recording';

export function isRecording(value: unknown): value is Recording {
  const v = value as Partial<Recording> | null;
  return (
    !!v &&
    typeof v.window_id === 'number' &&
    typeof v.started_at === 'string' &&
    Array.isArray(v.captures) &&
    (v.visits === undefined || Array.isArray(v.visits)) &&
    typeof v.failed === 'number'
  );
}

/** How Chrome says a page was reached (webNavigation transition type and qualifiers). */
export interface Navigation {
  transition: string;
  qualifiers: string[];
}

/** What a tab showed last during a recording, where that page was found and how it was reached (absent in a trail started before that was recorded). */
export interface TrailEntry {
  url: string;
  found_on: string | null;
  navigation?: CaptureNavigation | null;
  /** The tab already showed this address before: a reload, also one the page made itself, or Enter on the current address. */
  same_page?: boolean;
}

/**
 * The page a link or form on it led to this one: the tab's previous page, or
 * for a new tab the page that opened it. A typed address, a bookmark, a
 * reload or Back and Forward have none, nor has anything started from the
 * address bar. A redirect by the page itself keeps the origin of the
 * navigation it continues. An address with a sign-in or access credential is
 * never kept as where a page was found, and neither is the page itself.
 */
export function foundOnFor(navigation: Navigation, previous: TrailEntry | undefined, opener: string | null, url?: string): string | null {
  const { transition, qualifiers } = navigation;
  let found: string | null = null;
  if (qualifiers.includes('client_redirect')) found = previous?.found_on ?? null;
  else if ((transition === 'link' || transition === 'form_submit') && !qualifiers.includes('forward_back') && !qualifiers.includes('from_address_bar')) {
    found = previous?.url ?? opener;
  }
  if (found && url !== undefined && normalizeUrl(found) !== null && normalizeUrl(found) === normalizeUrl(url)) return null;
  return found && isProvenanceUrl(found) && !carriesCredential(found) ? found : null;
}

export interface Visit {
  url: string;
  title: string;
  found_on: string | null;
  at: string;
  /** How the page was reached, when the recording knows it. */
  navigation?: CaptureNavigation | null;
  /** The tab already showed this address (see TrailEntry). */
  same_page?: boolean;
}

/** A page is noted as visited again only this long after it was last saved or visited. */
export const REVISIT_GAP_MS = 30 * 60_000;

/**
 * A return to a page: a new document reached from another page, not a
 * reload, Back or Forward, nor an address the page changed itself. Chrome
 * reports a reload the page makes itself as a redirect, so the tab's previous
 * address tells it apart.
 */
function isReturn(visit: Visit): boolean {
  const { navigation } = visit;
  return !!navigation && !visit.same_page && !navigation.in_page && navigation.transition !== 'reload' && !navigation.qualifiers.includes('forward_back');
}

function onExcludedSite(url: string, excludedSites: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return excludedSites.some((site) => isOnSite(host, site));
}

/**
 * Saves a visited page as an address only (a PENDING snapshot, the page is
 * not read), also when the session has it only as a link saved without
 * opening it. A page the session already opened is noted as a visit, without
 * a snapshot, when it is a return (see isReturn) at least REVISIT_GAP_MS
 * after the page was last saved or visited; otherwise nothing is saved.
 * Pages that are not web pages, pages on the sites the user excluded and
 * addresses with a sign-in or access credential are skipped. A page on an
 * excluded site is never kept as where another was found.
 */
export async function recordVisit(
  db: IDBDatabase,
  sessionId: string,
  visit: Visit,
  excludedSites: string[] = [],
): Promise<CommitResult | null> {
  const dedupUrl = normalizeUrl(visit.url);
  if (!dedupUrl || onExcludedSite(visit.url, excludedSites) || carriesCredential(visit.url)) return null;
  const kindFor = (last: string | null | undefined): 'tab' | 'visit' | null => {
    if (!last) return 'tab';
    return isReturn(visit) && Date.parse(visit.at) - Date.parse(last) >= REVISIT_GAP_MS ? 'visit' : null;
  };
  return commitRecordedPage(
    db,
    {
      session_id: sessionId,
      dedup_url: dedupUrl,
      captured_at: visit.at,
      original_url: visit.url,
      tab_title: visit.title,
      found_on: visit.found_on && !onExcludedSite(visit.found_on, excludedSites) ? visit.found_on : null,
      anchor_text: null,
      fragment: null,
      navigation: visit.navigation ?? null,
    },
    kindFor,
  );
}
