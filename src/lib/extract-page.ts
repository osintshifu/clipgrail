import { Readability } from '@mozilla/readability';
import type { ExtractionMethod, FallbackReason, PageExtraction } from './model';
import { MAX_SNAPSHOT_CHARACTERS, elementToText, normalizeText, truncateToCharacters } from './text';

/** Pages with more elements skip Readability and use page text, to keep capture responsive. */
export const MAX_READABILITY_ELEMENTS = 200_000;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Runs inside the captured page (isolated world). Reads the page; never modifies it.
 * Readability works on a clone of the document.
 */
export function extractPage(doc: Document, httpStatus: number | null): PageExtraction {
  const pageUrl = doc.URL;
  try {
    if (httpStatus !== null && httpStatus >= 400) {
      return {
        ok: false,
        error_code: 'http_error',
        error_message: `The page returned HTTP ${httpStatus}.`,
        page_url: pageUrl,
        http_status: httpStatus,
      };
    }

    let method: ExtractionMethod = 'readability';
    let fallbackReason: FallbackReason | null = null;
    let raw = '';
    let title = doc.title;
    let byline: string | null = null;
    let siteName: string | null = null;
    let publishedTime: string | null = null;
    let lang: string | null = doc.documentElement?.getAttribute('lang') || null;

    if (!HTML_TYPES.has(doc.contentType)) {
      method = 'page-text';
      fallbackReason = 'not_html';
    } else {
      try {
        const clone = doc.cloneNode(true) as Document;
        const article = new Readability<Node>(clone, {
          maxElemsToParse: MAX_READABILITY_ELEMENTS,
          serializer: (node) => node,
        }).parse();
        if (article?.content) {
          raw = elementToText(article.content);
          title = article.title || title;
          byline = article.byline || null;
          siteName = article.siteName || null;
          publishedTime = article.publishedTime || null;
          lang = lang ?? (article.lang || null);
        }
        if (!raw) {
          method = 'page-text';
          fallbackReason = 'no_article';
        }
      } catch (error) {
        method = 'page-text';
        fallbackReason = String(error).includes('Aborting parsing document') ? 'page_too_large' : 'reader_error';
      }
    }

    if (method === 'page-text') {
      const body = doc.body;
      // innerText follows rendering (line breaks between blocks); textContent is the fallback for non-rendered documents.
      raw = normalizeText(body ? (body.innerText ?? body.textContent ?? '') : (doc.documentElement?.textContent ?? ''));
    }

    if (!raw) {
      return {
        ok: false,
        error_code: 'empty_text',
        error_message: 'The page has no readable text.',
        page_url: pageUrl,
        http_status: httpStatus,
      };
    }

    const cut = truncateToCharacters(raw, MAX_SNAPSHOT_CHARACTERS);
    const canonical = doc.querySelector<HTMLLinkElement>('link[rel~="canonical" i][href]');
    return {
      ok: true,
      text: cut.text,
      original_character_count: cut.originalCharacterCount,
      truncated: cut.truncated,
      extraction_method: method,
      fallback_reason: fallbackReason,
      title: normalizeText(title).replace(/\s+/g, ' '),
      byline,
      site_name: siteName,
      lang,
      published_time: publishedTime,
      canonical_url: canonical?.href || null,
      page_url: pageUrl,
      http_status: httpStatus,
    };
  } catch (error) {
    return {
      ok: false,
      error_code: 'extraction_error',
      error_message: `Text extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      page_url: pageUrl,
      http_status: httpStatus,
    };
  }
}

/** HTTP status of the page's main document, when Chrome exposes it (0 or missing means unknown). */
export function readHttpStatus(): number | null {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const status = entry?.responseStatus;
  return typeof status === 'number' && status > 0 ? status : null;
}
