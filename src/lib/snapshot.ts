import type { FailedSnapshot, Fragment, OkSnapshot, PageExtraction, SnapshotErrorCode } from './model';
import { MAX_SNAPSHOT_CHARACTERS, countCharacters, normalizeText, truncateToCharacters } from './text';

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type SnapshotIds = Pick<OkSnapshot, 'id' | 'capture_id' | 'source_id' | 'session_id'>;
export type OkSnapshotDraft = Omit<OkSnapshot, keyof SnapshotIds>;
export type FailedSnapshotDraft = Omit<FailedSnapshot, keyof SnapshotIds>;
export type SnapshotDraft = OkSnapshotDraft | FailedSnapshotDraft | PendingSnapshotDraft;

/**
 * Builds the stored snapshot from an extraction result. The limit is applied
 * again here so the stored text never exceeds it, then the character count
 * and hash are computed over exactly the text that will be stored.
 */
export async function buildSnapshotDraft(extraction: PageExtraction, capturedAt: string): Promise<SnapshotDraft> {
  if (!extraction.ok) {
    return failedSnapshotDraft(extraction.error_code, extraction.error_message, capturedAt, extraction.http_status);
  }
  const cut = truncateToCharacters(extraction.text.toWellFormed(), MAX_SNAPSHOT_CHARACTERS);
  const text = cut.text;
  return {
    status: 'ok',
    captured_at: capturedAt,
    text,
    character_count: countCharacters(text),
    sha256: await sha256Hex(text),
    extraction_method: extraction.extraction_method,
    fallback_reason: extraction.fallback_reason,
    truncated: extraction.truncated || cut.truncated,
    original_character_count: Math.max(extraction.original_character_count, cut.originalCharacterCount),
    title: extraction.title,
    byline: extraction.byline,
    site_name: extraction.site_name,
    lang: extraction.lang,
    published_time: extraction.published_time,
    canonical_url: extraction.canonical_url,
    page_url: extraction.page_url,
    http_status: extraction.http_status,
  };
}

export function failedSnapshotDraft(
  code: SnapshotErrorCode,
  message: string,
  capturedAt: string,
  httpStatus: number | null = null,
): FailedSnapshotDraft {
  return { status: 'failed', captured_at: capturedAt, error_code: code, error_message: message, http_status: httpStatus };
}

/** Builds a stored selection fragment: canonical text form, limit, count and hash of exactly the stored text. */
export async function buildFragment(rawText: string, method: Fragment['method']): Promise<Fragment | null> {
  const cut = truncateToCharacters(normalizeText(rawText), MAX_SNAPSHOT_CHARACTERS);
  if (!cut.text) return null;
  return {
    text: cut.text,
    character_count: countCharacters(cut.text),
    sha256: await sha256Hex(cut.text),
    truncated: cut.truncated,
    original_character_count: cut.originalCharacterCount,
    method,
  };
}

export type PendingSnapshotDraft = { status: 'pending' };
