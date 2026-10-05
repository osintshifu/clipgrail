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
}

/** tab: the address and title of an open tab, saved without reading the page. */
export type CaptureKind = 'page' | 'selection' | 'link' | 'tab';

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

export interface Capture {
  id: string;
  session_id: string;
  source_id: string;
  kind: CaptureKind;
  /** When the user started the capture. Browsing provenance. */
  captured_at: string;
  /** URL exactly as Chrome reported it (tab URL, or link target). Browsing provenance; exports use dedup_url. */
  original_url: string;
  /** Tab title at capture time (page, selection and tab captures); empty for links saved without opening. */
  tab_title: string;
  /** Link captures: page the link was found on. Private provenance. */
  found_on: string | null;
  /** Link captures: link text, recorded only when it was unambiguous. */
  anchor_text: string | null;
  /** Selection captures only. */
  fragment: Fragment | null;
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
  | 'timeout';

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
export type PageExtraction =
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
    };
