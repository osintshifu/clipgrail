/**
 * Persisted records. Field names are snake_case so stored data, backups,
 * exports and the project vocabulary (captured_at, character_count, ...)
 * use the same names.
 */

export const INBOX_SESSION_ID = 'inbox';

export interface Session {
  id: string;
  name: string;
  created_at: string;
  /** Next source number to assign. Only ever increases, so an S-ID is never reused. */
  next_source_number: number;
  /** Session prompt used as the TASK of Research Jobs. */
  prompt: string;
  /** Private notes. */
  notes: string;
  /** When the session was archived; null while it is in the main session list. */
  archived_at: string | null;
}

export interface Source {
  /** Durable internal identifier. */
  id: string;
  session_id: string;
  /** Label number within the session, shown and cited as S{number}. */
  number: number;
  /** URL used for deduplication (see normalizeUrl). */
  dedup_url: string;
  created_at: string;
  /** Private note about the source. */
  note: string;
  /**
   * IDs of the sources that joined this one when they were moved into its
   * session, with the IDs those had taken over. Research Jobs keep the IDs
   * they were generated with, so deleting this source finds them by these too.
   */
  merged_ids: string[];
  /** Marked important by the user. Kept by Undo and by the review after a recording. */
  important: boolean;
}

/**
 * tab: the address and title of an open tab, saved without reading the page.
 * visit: a recorded return to a page the session already had; it has no
 * snapshot and is shown in the timeline, not among the source's captures.
 */
export type CaptureKind = 'page' | 'selection' | 'link' | 'tab' | 'visit';

/**
 * How Chrome says a recorded page was reached, exactly as reported
 * (webNavigation transitionType and transitionQualifiers). `in_page` is true
 * when the page changed its address without loading a new document.
 */
export interface CaptureNavigation {
  transition: string;
  qualifiers: string[];
  in_page: boolean;
}

/** What a page declares about itself in its code: OpenGraph, X cards, schema.org data, meta tags and its canonical link. */
export type DeclaredField = 'site_name' | 'author' | 'publisher' | 'published' | 'type' | 'x_account' | 'canonical' | 'generator';

export interface DeclaredValue {
  field: DeclaredField;
  value: string;
  /** The tags it was read from, such as "og:site_name" or "schema.org author" (see DECLARED_TAGS). */
  from: string[];
}

export type TrackerKind = 'ga4' | 'google_tag' | 'ua' | 'gtm' | 'meta_pixel' | 'adsense';

/** Where in the page code a tracker ID was found. */
export type TrackerPlace = 'script_address' | 'inline_script' | 'noscript' | 'ad_tag' | 'image' | 'amp_tag';

export interface Tracker {
  kind: TrackerKind;
  id: string;
  where: TrackerPlace[];
}

/** Read from the page code when a page or a selection was clipped. Not part of the saved text or its SHA-256. */
export interface PageCode {
  declared: DeclaredValue[];
  trackers: Tracker[];
}

/** Text the user selected on a page. */
export interface Fragment {
  text: string;
  character_count: number;
  /** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
  sha256: string;
  truncated: boolean;
  original_character_count: number;
  /** dom-selection keeps line breaks; menu-selection-text is Chrome's flattened copy, used when the page could not be read. */
  method: 'dom-selection' | 'menu-selection-text';
}

/**
 * A selection made in an embedded frame. `url` is the frame's address as read
 * (any scheme, such as about:srcdoc or blob:), or null when it could not be
 * read. A frame with an http or https address is the capture's source; any
 * other frame's source URL is not established and the page is kept as context.
 */
export interface CaptureFrame {
  url: string | null;
}

export interface Capture {
  id: string;
  session_id: string;
  source_id: string;
  kind: CaptureKind;
  /** When the user started the capture. Browsing provenance. */
  captured_at: string;
  /** URL as Chrome reported it (tab URL, or link target), without a user name and password. Browsing provenance; exports use dedup_url. */
  original_url: string;
  /** Tab title at capture time (page, selection and tab captures); empty for links saved without opening. */
  tab_title: string;
  /** Link captures, and pages saved by a recording: page the link was found on. Private provenance. */
  found_on: string | null;
  /** Link captures: link text, recorded only when it was unambiguous. */
  anchor_text: string | null;
  /** Selection captures only. */
  fragment: Fragment | null;
  /** Selections made in an embedded frame; null otherwise, and on every capture made before frames were recorded. */
  frame: CaptureFrame | null;
  /** Pages saved by a recording, and visits: how the page was reached. Null otherwise, and on every capture made before it was recorded. */
  navigation: CaptureNavigation | null;
  /** Page and selection captures: what the page code declared and the trackers in it. Null when it was not read, and on every capture made before it was. */
  page_code: PageCode | null;
  /** Page, link and tab captures have a snapshot; selection captures do not. */
  snapshot_id: string | null;
  /** Private note. */
  note: string;
}

export type ExtractionMethod = 'readability' | 'page-text';

/** Why page-text was used instead of Readability. */
export type FallbackReason = 'not_html' | 'no_article' | 'page_too_large' | 'reader_error';

export type SnapshotErrorCode =
  | 'page_unavailable'
  | 'http_error'
  | 'empty_text'
  | 'extraction_error'
  | 'timeout'
  // The saved text of a successful snapshot is not in the database (damaged data); set when reading, never by a capture.
  | 'text_missing';

interface SnapshotBase {
  id: string;
  capture_id: string;
  source_id: string;
  session_id: string;
}

/** A successful snapshot without its text. The database keeps the text in a separate store, so lists can be read without it. */
export interface OkSnapshotMeta extends SnapshotBase {
  status: 'ok';
  /** When the text was read from the page. */
  captured_at: string;
  /** Unicode code points in `text`. */
  character_count: number;
  /** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
  sha256: string;
  extraction_method: ExtractionMethod;
  fallback_reason: FallbackReason | null;
  /** True when `text` was cut at MAX_SNAPSHOT_CHARACTERS: a partial snapshot. */
  truncated: boolean;
  /** Code points in the extracted text before truncation. */
  original_character_count: number;
  title: string;
  byline: string | null;
  site_name: string | null;
  lang: string | null;
  published_time: string | null;
  /** Page-declared canonical URL. Recorded only, never used to merge sources. */
  canonical_url: string | null;
  /** document.URL at extraction time. */
  page_url: string;
  /** Status of the main document as reported by the browser (Navigation Timing), or null if unknown. */
  http_status: number | null;
}

export interface OkSnapshot extends OkSnapshotMeta {
  /** Readable text exactly as stored. */
  text: string;
}

export interface FailedSnapshot extends SnapshotBase {
  status: 'failed';
  /** When the capture was attempted. */
  captured_at: string;
  error_code: SnapshotErrorCode;
  error_message: string;
  http_status: number | null;
}

/** Text not captured yet: a link or a tab address saved without reading the page. */
export interface PendingSnapshot extends SnapshotBase {
  status: 'pending';
}

export type Snapshot = OkSnapshot | FailedSnapshot | PendingSnapshot;
/** A snapshot as stored in the snapshots store: everything except the text of a successful snapshot. */
export type SnapshotMeta = OkSnapshotMeta | FailedSnapshot | PendingSnapshot;

export function sourceLabel(source: Pick<Source, 'number'>): string {
  return `S${source.number}`;
}

/** Result returned by the extractor script running in the page. */
export type PageExtraction = (
  | {
      ok: true;
      text: string;
      original_character_count: number;
      truncated: boolean;
      extraction_method: ExtractionMethod;
      fallback_reason: FallbackReason | null;
      title: string;
      byline: string | null;
      site_name: string | null;
      lang: string | null;
      published_time: string | null;
      canonical_url: string | null;
      page_url: string;
      http_status: number | null;
    }
  | {
      ok: false;
      error_code: 'http_error' | 'empty_text' | 'extraction_error';
      error_message: string;
      page_url: string;
      http_status: number | null;
    }
) & {
  /** Read from the page code beside the text; null when that failed. */
  page_code?: PageCode | null;
};

/**
 * How labels stopped being used: a source deleted on its own or with others,
 * with its session or when the Inbox was emptied, removed with Undo or in the
 * review after a recording, moved to another session, or replaced when a
 * backup without it was restored.
 */
export type RemovalAction = 'delete' | 'delete_session' | 'empty_inbox' | 'undo' | 'review' | 'move' | 'restore';

/** A source whose label a removal retired, as it was then. */
export interface RemovedSource {
  session_id: string;
  /** The session's name then; the session may be renamed or deleted since. */
  session_name: string;
  number: number;
  /** Title and address of a deleted source, or one a restore replaced. Undo, the review after a recording and a move keep none. */
  title: string | null;
  url: string | null;
  /** Captures the source had, visits not counted. */
  captures: number;
}

/**
 * An entry of the deletion log: labels are never given to another source, so
 * each retired one is noted with what it was, to explain gaps in a session's
 * labels.
 */
export interface Removal {
  id: string;
  removed_at: string;
  action: RemovalAction;
  sources: RemovedSource[];
  /** Research Jobs deleted with the sources. */
  jobs: number;
  /** For a move: the session the source went to and its label there, which it got or found when it joined a source with the same address. */
  moved_to: { session_id: string; session_name: string; number: number; joined: boolean } | null;
}
