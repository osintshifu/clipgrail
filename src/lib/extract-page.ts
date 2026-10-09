import { Readability } from '@mozilla/readability';
import type { ExtractionMethod, FallbackReason, PageExtraction } from './model';
import { MAX_SNAPSHOT_CHARACTERS, countCharacters, elementToText, normalizeText, truncateToCharacters } from './text';
import { isCapturableUrl } from './url';

/** Pages with more elements skip Readability and use page text, to keep capture responsive. */
export const MAX_READABILITY_ELEMENTS = 200_000;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** Page metadata limits, in code points: the snapshot limit covers only the text. */
const MAX_TITLE_CHARACTERS = 1_000;
const MAX_META_CHARACTERS = 300;
const MAX_CANONICAL_CHARACTERS = 8_192;

/** Cuts a longer value and marks the cut with "…". */
function shortened(value: string, max: number): string {
  const cut = truncateToCharacters(value, max);
  return cut.truncated ? `${cut.text}…` : value;
}

/** A value that is meaningless when cut (language, time, address) is dropped instead. */
function withinLimit(value: string | null, max: number): string | null {
  return value !== null && countCharacters(value) <= max ? value : null;
}

/** Readability reads these itself: JSON-LD in a script and meta tags give the byline and the date. */
const LEFT_TO_READABILITY = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'title']);
/** What a hidden part of the page still gives Readability. */
const METADATA = 'script[type="application/ld+json" i], meta';

/** Collects the text written directly in an element, not in its children. */
function ownTextOf(element: Element, into: Node[]): void {
  for (const child of Array.from(element.childNodes)) if (child.nodeType === Node.TEXT_NODE) into.push(child);
}

/** Moves the walker past the children of its current element: to its next sibling or the next sibling of an ancestor. */
function pastChildren(walker: TreeWalker): Node | null {
  let next = walker.nextSibling();
  while (!next && walker.parentNode()) next = walker.nextSibling();
  return next;
}

/**
 * Removes from the copy what the page does not show, so Readability leaves it
 * out as it leaves out elements hidden by an inline style: elements without a
 * box (display: none, the content of a closed <details>), keeping their JSON-LD
 * and meta tags; the text written directly in a closed <details>; and the text
 * of elements with visibility: hidden, whose children can show themselves
 * again. The copy has the structure of the page, and no script of the page
 * runs during the walk.
 */
function dropUnrendered(live: HTMLElement, copy: HTMLElement): void {
  const view = live.ownerDocument.defaultView;
  if (typeof live.checkVisibility !== 'function' || !view) return;
  const pageWalk = live.ownerDocument.createTreeWalker(live, NodeFilter.SHOW_ELEMENT);
  const copyWalk = copy.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
  const unrendered: Element[] = [];
  const invisibleText: Node[] = [];
  let shown = pageWalk.nextNode() as Element | null;
  let copied = copyWalk.nextNode() as Element | null;
  while (shown && copied) {
    if (!LEFT_TO_READABILITY.has(shown.localName) && !shown.checkVisibility({ visibilityProperty: true })) {
      const style = view.getComputedStyle(shown);
      // An element with display: contents has no box of its own, but it and its children are shown.
      if (!shown.checkVisibility() && style.display !== 'contents') {
        unrendered.push(copied);
        shown = pastChildren(pageWalk) as Element | null;
        copied = pastChildren(copyWalk) as Element | null;
        continue;
      }
      if (style.visibility !== 'visible') ownTextOf(copied, invisibleText);
    } else if (shown.localName === 'details' && !(shown as HTMLDetailsElement).open) {
      // A closed <details> shows only its summary: its other elements have no box and are dropped above.
      ownTextOf(copied, invisibleText);
    }
    shown = pageWalk.nextNode() as Element | null;
    copied = copyWalk.nextNode() as Element | null;
  }
  for (const element of unrendered) element.replaceWith(...Array.from(element.querySelectorAll(METADATA)));
  for (const text of invisibleText) text.parentNode?.removeChild(text);
}

/**
 * Runs inside the captured page (isolated world). Reads the page; never modifies it.
 * Readability works on a clone of the document, without the text the page hides.
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
        // Over the limit Readability stops, and the page text that follows already leaves hidden text out.
        if (doc.body && clone.body && doc.getElementsByTagName('*').length <= MAX_READABILITY_ELEMENTS) dropUnrendered(doc.body, clone.body);
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
    const canonicalUrl = canonical?.href && isCapturableUrl(canonical.href) ? canonical.href : null;
    return {
      ok: true,
      text: cut.text,
      original_character_count: cut.originalCharacterCount,
      truncated: cut.truncated,
      extraction_method: method,
      fallback_reason: fallbackReason,
      title: shortened(normalizeText(title).replace(/\s+/g, ' '), MAX_TITLE_CHARACTERS),
      byline: byline === null ? null : shortened(byline, MAX_META_CHARACTERS),
      site_name: siteName === null ? null : shortened(siteName, MAX_META_CHARACTERS),
      lang: withinLimit(lang, MAX_META_CHARACTERS),
      published_time: withinLimit(publishedTime, MAX_META_CHARACTERS),
      canonical_url: withinLimit(canonicalUrl, MAX_CANONICAL_CHARACTERS),
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

const withoutFragment = (url: string) => url.split('#', 1)[0];

/**
 * HTTP status of the page's main document, when Chrome exposes it (0 or missing means unknown).
 * The status belongs to the address the document was loaded from: after history.pushState the
 * page shows another address, whose status the browser never reported.
 */
export function readHttpStatus(): number | null {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!entry || typeof entry.responseStatus !== 'number' || entry.responseStatus <= 0) return null;
  return withoutFragment(entry.name) === withoutFragment(document.URL) ? entry.responseStatus : null;
}
