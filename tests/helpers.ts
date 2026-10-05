import type { CaptureDraft } from '../src/lib/db';
import { openDb } from '../src/lib/db';
import { INBOX_SESSION_ID } from '../src/lib/model';
import type { PageExtraction } from '../src/lib/model';
import { buildFragment, buildSnapshotDraft, failedSnapshotDraft } from '../src/lib/snapshot';

let counter = 0;
/** A fresh, isolated database for one test. */
export function freshDb(): Promise<IDBDatabase> {
  counter += 1;
  return openDb(`clipgrail-test-${counter}-${crypto.randomUUID()}`);
}

export function extraction(text: string, overrides: Partial<Extract<PageExtraction, { ok: true }>> = {}): PageExtraction {
  return {
    ok: true,
    text,
    original_character_count: [...text].length,
    truncated: false,
    extraction_method: 'readability',
    fallback_reason: null,
    title: 'Example article',
    byline: null,
    site_name: null,
    lang: 'en',
    published_time: null,
    canonical_url: null,
    page_url: 'https://example.com/article',
    http_status: 200,
    ...overrides,
  };
}

export async function pageDraft(
  url: string,
  text: string,
  capturedAt: string,
  sessionId = INBOX_SESSION_ID,
): Promise<CaptureDraft> {
  return {
    session_id: sessionId,
    kind: 'page',
    dedup_url: url,
    captured_at: capturedAt,
    original_url: `${url}?utm_source=newsletter`,
    tab_title: 'Example article',
    found_on: null,
    anchor_text: null,
    fragment: null,
    snapshot: await buildSnapshotDraft(extraction(text), capturedAt),
  };
}

export function failedDraft(url: string, capturedAt: string, sessionId = INBOX_SESSION_ID): CaptureDraft {
  return {
    session_id: sessionId,
    kind: 'page',
    dedup_url: url,
    captured_at: capturedAt,
    original_url: url,
    tab_title: 'Missing page',
    found_on: null,
    anchor_text: null,
    fragment: null,
    snapshot: failedSnapshotDraft('http_error', 'The page returned HTTP 404.', capturedAt, 404),
  };
}

export async function selectionDraft(url: string, text: string, capturedAt: string, sessionId = INBOX_SESSION_ID): Promise<CaptureDraft> {
  return {
    session_id: sessionId,
    kind: 'selection',
    dedup_url: url,
    captured_at: capturedAt,
    original_url: url,
    tab_title: 'Example article',
    found_on: null,
    anchor_text: null,
    fragment: await buildFragment(text, 'dom-selection'),
    snapshot: null,
  };
}

export function linkDraft(url: string, capturedAt: string, foundOn: string, sessionId = INBOX_SESSION_ID): CaptureDraft {
  return {
    session_id: sessionId,
    kind: 'link',
    dedup_url: url,
    captured_at: capturedAt,
    original_url: `${url}?fbclid=abc`,
    tab_title: '',
    found_on: foundOn,
    anchor_text: 'Turnout data',
    fragment: null,
    snapshot: { status: 'pending' },
  };
}
