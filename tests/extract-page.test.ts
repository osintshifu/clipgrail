// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { extractPage, readHttpStatus } from '../src/lib/extract-page';
import { MAX_SNAPSHOT_CHARACTERS } from '../src/lib/text';

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the article explains the recount in detail, with figures, dates and named officials, so that a reader can follow every step of the process.</p>`;

function html(body: string, head = '<title>Recount report - Example News</title>'): Document {
  return new DOMParser().parseFromString(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, 'text/html');
}

describe('extractPage', () => {
  it('extracts the article with Readability and leaves navigation out', () => {
    const doc = html(
      `<nav><a href="/">Home</a> <a href="/sport">Sport</a></nav>
       <article><h1>Recount report</h1>${Array.from({ length: 8 }, (_, i) => paragraph(i + 1)).join('')}</article>
       <footer>Copyright Example News</footer>`,
      '<title>Recount report - Example News</title><link rel="canonical" href="https://example.com/recount">',
    );
    const result = extractPage(doc, 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction_method).toBe('readability');
    expect(result.fallback_reason).toBeNull();
    expect(result.text).toContain('Paragraph 1 of the article');
    expect(result.text).toContain('\n\nParagraph 2 of the article');
    expect(result.text).not.toContain('Sport');
    expect(result.canonical_url).toBe('https://example.com/recount');
    expect(result.http_status).toBe(200);
  });

  it('reports HTTP errors only from a status the browser reported, never from page wording', () => {
    const notFoundPage = html('<h1>404 Not Found</h1><p>The page you requested does not exist on this server.</p>');
    const withStatus = extractPage(notFoundPage, 404);
    expect(withStatus).toMatchObject({ ok: false, error_code: 'http_error', http_status: 404 });
    // Without a reported status the same page is plain text content, not a guessed 404.
    const withoutStatus = extractPage(notFoundPage, null);
    expect(withoutStatus.ok).toBe(true);
  });

  it('applies the reported status only to the address the document was loaded from', () => {
    const entry = { name: `${location.origin}/missing`, responseStatus: 404 };
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([entry as unknown as PerformanceEntry]);
    history.replaceState(null, '', '/missing#comments');
    expect(readHttpStatus()).toBe(404);
    // A single-page app moved on to another address: Chrome never reported its status.
    history.pushState(null, '', '/article');
    expect(readHttpStatus()).toBeNull();
    vi.restoreAllMocks();
  });

  it('limits page metadata, which the snapshot text limit does not cover', () => {
    const longTitle = 't'.repeat(3_000_000);
    const result = extractPage(html(paragraph(1), `<title>${longTitle}</title><link rel="canonical" href="https://example.com/${'p'.repeat(9_000)}">`), 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe(`${'t'.repeat(1_000)}…`);
    expect(result.canonical_url).toBeNull();
  });

  it('fails visibly on a page without text instead of saving an empty snapshot', () => {
    expect(extractPage(html('<div>   </div><img src="x.png">'), 200)).toMatchObject({ ok: false, error_code: 'empty_text' });
  });

  it('uses labelled page text for non-HTML documents and marks over-long text as truncated', () => {
    const long = 'x'.repeat(MAX_SNAPSHOT_CHARACTERS + 10);
    const doc = new DOMParser().parseFromString(`<data>${long}</data>`, 'text/xml');
    const result = extractPage(doc, null);
    expect(result).toMatchObject({ ok: true, extraction_method: 'page-text', fallback_reason: 'not_html', truncated: true });
    if (!result.ok) return;
    expect([...result.text].length).toBe(MAX_SNAPSHOT_CHARACTERS);
    expect(result.original_character_count).toBe(MAX_SNAPSHOT_CHARACTERS + 10);
  });
});
