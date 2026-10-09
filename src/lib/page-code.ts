/**
 * What a page's code says about it: values the page declares about itself
 * and the IDs of trackers in it. Read in the page when it is clipped; the page
 * is never modified. Everything read is untrusted page content, cleaned and
 * cut to size before it is stored.
 */
import type { DeclaredField, DeclaredValue, PageCode, Tracker, TrackerKind, TrackerPlace } from './model';
import { countCharacters, truncateToCharacters } from './text';
import { isCapturableUrl } from './url';

export const DECLARED_FIELDS: readonly DeclaredField[] = ['site_name', 'author', 'publisher', 'published', 'type', 'x_account', 'canonical', 'generator'];
/** The tags a declared value can come from. */
export const DECLARED_TAGS = [
  'og:site_name',
  'og:type',
  'article:published_time',
  'article:author',
  'meta author',
  'twitter:site',
  'twitter:creator',
  'meta generator',
  'link rel=canonical',
  'schema.org',
  'schema.org author',
  'schema.org publisher',
  'schema.org datePublished',
] as const;
export const TRACKER_KINDS: readonly TrackerKind[] = ['ga4', 'ua', 'gtm', 'meta_pixel', 'adsense'];
export const TRACKER_PLACES: readonly TrackerPlace[] = ['script_address', 'inline_script', 'noscript', 'ad_tag', 'image'];

/** Limits, in code points and entries: a page cannot make a capture large. */
const MAX_VALUE = 300;
const MAX_CANONICAL = 2_048;
const MAX_ENTRIES = 40;
/** Inline scripts and structured data are read up to these sizes, to keep a capture quick on heavy pages. */
const MAX_SCRIPT_TEXT = 2_000_000;
const MAX_STRUCTURED_DATA = 500_000;
const MAX_STRUCTURED_NODES = 200;

/** IDs as the trackers issue them. A GA4 ID mixes letters and digits, so words such as "G-SECTIONS" are not taken for one. */
const TRACKER_IDS: Record<TrackerKind, RegExp> = {
  ga4: /^G-(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,12}$/,
  ua: /^UA-\d{4,10}-\d{1,4}$/,
  gtm: /^GTM-[A-Z0-9]{4,9}$/,
  meta_pixel: /^\d{15,16}$/,
  adsense: /^ca-pub-\d{16}$/,
};
const TRACKERS_IN_CODE: Array<[TrackerKind, RegExp]> = [
  ['ga4', /(?<![\w-])G-[A-Z0-9]{8,12}(?![\w-])/g],
  ['ua', /(?<![\w-])UA-\d{4,10}-\d{1,4}(?![\w-])/g],
  ['gtm', /(?<![\w-])GTM-[A-Z0-9]{4,9}(?![\w-])/g],
  ['adsense', /(?<![\w-])ca-pub-\d{16}(?!\d)/g],
];
/** A Meta Pixel ID is a bare number, so it is taken only from fbq('init', …) and the pixel's image address. */
const META_PIXEL_IN_CODE = [/fbq\(\s*['"]init['"]\s*,\s*['"](\d{15,16})['"]/g, /facebook\.com\/tr\/?\?(?:[^"'\s<>]*&(?:amp;)?)?id=(\d{15,16})(?!\d)/g];

/** One line of text, cut to the limit; null when nothing is left. */
function clean(value: unknown, max = MAX_VALUE): string | null {
  if (typeof value !== 'string') return null;
  const text = value.toWellFormed().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const cut = truncateToCharacters(text, max);
  return cut.truncated ? `${cut.text}…` : text;
}

/** Reads the page code of `doc`. Runs inside the page (isolated world); never throws. */
export function readPageCode(doc: Document): PageCode & { page_url: string } {
  const pageCode: PageCode = { declared: [], trackers: [] };
  try {
    pageCode.trackers = readTrackers(doc);
  } catch {
    // A page that breaks reading trackers still has its declared values read.
  }
  try {
    pageCode.declared = readDeclared(doc);
  } catch {
    // Declared values stay empty.
  }
  return { ...pageCode, page_url: doc.URL };
}

function readTrackers(doc: Document): Tracker[] {
  const found = new Map<string, Tracker>();
  const add = (kind: TrackerKind, id: string, where: TrackerPlace) => {
    if (!TRACKER_IDS[kind].test(id)) return;
    const key = `${kind} ${id}`;
    const tracker = found.get(key) ?? { kind, id, where: [] };
    if (!tracker.where.includes(where)) tracker.where.push(where);
    if (found.size < MAX_ENTRIES || found.has(key)) found.set(key, tracker);
  };
  const scan = (code: string, where: TrackerPlace) => {
    for (const [kind, pattern] of TRACKERS_IN_CODE) for (const m of code.matchAll(pattern)) add(kind, m[0], where);
    for (const pattern of META_PIXEL_IN_CODE) for (const m of code.matchAll(pattern)) add('meta_pixel', m[1]!, where);
  };
  let budget = MAX_SCRIPT_TEXT;
  for (const script of Array.from(doc.scripts)) {
    if (script.src) {
      scan(script.src, 'script_address');
    } else if (budget > 0 && /^$|javascript|ecmascript|module/i.test(script.type)) {
      const code = (script.textContent ?? '').slice(0, budget);
      budget -= code.length;
      scan(code, 'inline_script');
    }
  }
  // A page with scripts keeps noscript content as text, a document read without scripts as elements; innerHTML has both.
  for (const noscript of Array.from(doc.querySelectorAll('noscript'))) scan(noscript.innerHTML.slice(0, 100_000), 'noscript');
  for (const ad of Array.from(doc.querySelectorAll('[data-ad-client]'))) scan(ad.getAttribute('data-ad-client') ?? '', 'ad_tag');
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src*="facebook.com/tr"]'))) scan(img.src, 'image');
  return [...found.values()];
}

function readDeclared(doc: Document): DeclaredValue[] {
  const declared: DeclaredValue[] = [];
  const put = (field: DeclaredField, raw: unknown, from: (typeof DECLARED_TAGS)[number]) => {
    const value = field === 'canonical' ? canonicalValue(raw) : clean(raw);
    if (!value) return;
    const same = declared.find((d) => d.field === field && d.value === value);
    if (same) {
      if (!same.from.includes(from)) same.from.push(from);
    } else if (declared.length < MAX_ENTRIES) {
      declared.push({ field, value, from: [from] });
    }
  };
  // OpenGraph uses property=, other tags name=; pages mix them up, so both are read.
  const meta = (key: string) =>
    Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[property][content], meta[name][content]'))
      .filter((m) => (m.getAttribute('property') ?? m.getAttribute('name') ?? '').toLowerCase() === key)
      .map((m) => m.content);
  for (const v of meta('og:site_name')) put('site_name', v, 'og:site_name');
  for (const v of meta('author')) put('author', v, 'meta author');
  for (const v of meta('article:author')) put('author', v, 'article:author');
  for (const v of meta('article:published_time')) put('published', v, 'article:published_time');
  for (const v of meta('og:type')) put('type', v, 'og:type');
  for (const v of meta('twitter:site')) put('x_account', v, 'twitter:site');
  for (const v of meta('twitter:creator')) put('x_account', v, 'twitter:creator');
  for (const v of meta('generator')) put('generator', v, 'meta generator');
  const canonical = doc.querySelector<HTMLLinkElement>('link[rel~="canonical" i][href]');
  if (canonical) put('canonical', canonical.href, 'link rel=canonical');
  const { nodes, byId } = structuredData(doc);
  for (const node of nodes) {
    // The article itself, not the site, breadcrumbs or images around it.
    if (!('headline' in node || 'author' in node || 'publisher' in node || 'datePublished' in node)) continue;
    for (const type of [node['@type']].flat()) put('type', type, 'schema.org');
    for (const author of [node.author].flat()) put('author', nameOf(author, byId), 'schema.org author');
    for (const publisher of [node.publisher].flat()) put('publisher', nameOf(publisher, byId), 'schema.org publisher');
    put('published', node.datePublished, 'schema.org datePublished');
  }
  return declared;
}

function canonicalValue(raw: unknown): string | null {
  return typeof raw === 'string' && isCapturableUrl(raw) && countCharacters(raw) <= MAX_CANONICAL ? raw : null;
}

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);

/** The schema.org objects in the page's JSON-LD, with @graph lists opened, and the objects by @id for references. */
function structuredData(doc: Document): { nodes: Node[]; byId: Map<string, Node> } {
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  const visit = (value: unknown, depth: number) => {
    if (nodes.length >= MAX_STRUCTURED_NODES || depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (isNode(value)) {
      nodes.push(value);
      if (typeof value['@id'] === 'string') byId.set(value['@id'], value);
      if (value['@graph']) visit(value['@graph'], depth + 1);
    }
  };
  let budget = MAX_STRUCTURED_DATA;
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'))) {
    const text = script.textContent ?? '';
    if (text.length > budget) break;
    budget -= text.length;
    try {
      visit(JSON.parse(text), 0);
    } catch {
      // Broken structured data is skipped.
    }
  }
  return { nodes, byId };
}

/** The name of a schema.org person or organization, also one given by an @id reference or as plain text. */
function nameOf(value: unknown, byId: Map<string, Node>): unknown {
  if (typeof value === 'string') return value;
  if (!isNode(value)) return null;
  const node = typeof value['@id'] === 'string' && !('name' in value) ? (byId.get(value['@id']) ?? value) : value;
  return node.name;
}

/** The page code of a capture or a backup, checked and copied; null when it is not valid. */
export function cleanPageCode(value: unknown): PageCode | null {
  if (!isNode(value) || !Array.isArray(value.declared) || !Array.isArray(value.trackers)) return null;
  if (value.declared.length > MAX_ENTRIES || value.trackers.length > MAX_ENTRIES) return null;
  const declared: DeclaredValue[] = [];
  for (const d of value.declared) {
    if (!isNode(d) || !DECLARED_FIELDS.includes(d.field as DeclaredField) || typeof d.value !== 'string') return null;
    const max = d.field === 'canonical' ? MAX_CANONICAL : MAX_VALUE + 1;
    if (!d.value || countCharacters(d.value) > max || (d.field === 'canonical' && !isCapturableUrl(d.value))) return null;
    if (!tagList(d.from, DECLARED_TAGS)) return null;
    declared.push({ field: d.field as DeclaredField, value: d.value, from: [...(d.from as string[])] });
  }
  const trackers: Tracker[] = [];
  for (const t of value.trackers) {
    if (!isNode(t) || !TRACKER_KINDS.includes(t.kind as TrackerKind) || typeof t.id !== 'string' || !TRACKER_IDS[t.kind as TrackerKind].test(t.id)) return null;
    if (!tagList(t.where, TRACKER_PLACES)) return null;
    trackers.push({ kind: t.kind as TrackerKind, id: t.id, where: [...(t.where as TrackerPlace[])] });
  }
  return { declared, trackers };
}

/** A list of one or more different words from `allowed`. */
function tagList(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((v) => typeof v === 'string' && allowed.includes(v));
}
