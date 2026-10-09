/**
 * What a page's code says about it: values the page declares about itself
 * and the IDs of trackers in it, and the contacts, accounts and payment
 * addresses in its links, visible text and schema.org data. Read in the page when it is
 * clipped; the page is never modified. Everything read is untrusted page
 * content, cleaned and cut to size before it is stored.
 */
import type { DeclaredField, DeclaredValue, PageCode, PagePlace, PageValue, PageValueKind, Tracker, TrackerKind, TrackerPlace } from './model';
import { countCharacters, truncateToCharacters } from './text';
import { isCapturableUrl } from './url';
import { findValues } from './values';

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
export const TRACKER_KINDS: readonly TrackerKind[] = ['ga4', 'google_tag', 'ua', 'gtm', 'meta_pixel', 'adsense'];
export const TRACKER_PLACES: readonly TrackerPlace[] = ['script_address', 'inline_script', 'noscript', 'ad_tag', 'image', 'amp_tag'];
/** The kinds of values in a page, in the order its details list them. */
export const PAGE_VALUE_KINDS: readonly PageValueKind[] = [
  'email',
  'phone',
  'x',
  'telegram',
  'facebook',
  'instagram',
  'linkedin',
  'youtube',
  'tiktok',
  'github',
  'discord',
  'reddit',
  'bitcoin',
  'ethereum',
  'iban',
];
export const PAGE_PLACES: readonly PagePlace[] = ['link', 'page_text', 'schema_org'];

/** Limits, in code points and entries: a page cannot make a capture large. */
const MAX_VALUE = 300;
const MAX_CANONICAL = 2_048;
const MAX_ENTRIES = 40;
/** Scripts, noscript content, addresses and structured data are read up to these sizes, to keep a capture quick on heavy pages. */
const MAX_SCRIPT_TEXT = 2_000_000;
const MAX_NOSCRIPT_TEXT = 500_000;
const MAX_ADDRESS = 10_000;
const MAX_STRUCTURED_DATA = 500_000;
const MAX_STRUCTURED_NODES = 200;
/** Values kept from one page, links read and visible text searched for values. */
export const MAX_PAGE_VALUES = 100;
const MAX_LINKS = 20_000;
const MAX_PAGE_TEXT = 2_000_000;

/** IDs as the trackers issue them. A GA4 ID mixes letters and digits, so words such as "G-SECTIONS" are not taken for one. */
const TRACKER_IDS: Record<TrackerKind, RegExp> = {
  ga4: /^G-(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,12}$/,
  google_tag: /^GT-(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}$/,
  ua: /^UA-\d{4,10}-\d{1,4}$/,
  gtm: /^GTM-[A-Z0-9]{4,9}$/,
  meta_pixel: /^\d{15,16}$/,
  adsense: /^ca-pub-\d{16}$/,
};
const TRACKERS_IN_CODE: Array<[TrackerKind, RegExp]> = [
  ['ga4', /(?<![\w-])G-[A-Z0-9]{8,12}(?![\w-])/g],
  ['google_tag', /(?<![\w-])GT-[A-Z0-9]{6,10}(?![\w-])/g],
  ['ua', /(?<![\w-])UA-\d{4,10}-\d{1,4}(?![\w-])/g],
  ['gtm', /(?<![\w-])GTM-[A-Z0-9]{4,9}(?![\w-])/g],
  ['adsense', /(?<![\w-])ca-pub-\d{16}(?!\d)/g],
];
/**
 * A Meta Pixel ID is a bare number, so it is taken only from fbq('init', …), the pixel's image address and the
 * configuration script the pixel loads for itself. Every repeat is bounded, so a page cannot make the search slow.
 */
const META_PIXEL_IN_CODE = [
  /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{15,16})(?!\d)/g,
  /facebook\.com\/tr\/?\?(?:[^"'\s<>]{0,500}?&(?:amp;)?)?id=(\d{15,16})(?!\d)/g,
  /connect\.facebook\.net\/signals\/config\/(\d{15,16})(?!\d)/g,
];

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
  let data: StructuredData = { roots: [], nodes: [], byId: new Map() };
  try {
    data = structuredData(doc);
  } catch {
    // Values the page shows are read without its structured data.
  }
  try {
    pageCode.declared = readDeclared(doc, data);
  } catch {
    // Declared values stay empty.
  }
  try {
    Object.assign(pageCode, readValues(doc, data));
  } catch {
    // The values are left out, as on a capture made before they were read.
  }
  return { ...pageCode, page_url: doc.URL };
}

/** The values in the page's links, the text it shows and its schema.org data, each once, by kind; at most MAX_PAGE_VALUES. */
function readValues(doc: Document, data: StructuredData): Pick<PageCode, 'values' | 'values_cut'> {
  const found = new Map<string, PageValue>();
  let cut = false;
  const add = (kind: PageValueKind, value: string, where: PagePlace) => {
    const key = `${kind} ${kind === 'x' ? value.toLowerCase() : value}`;
    const known = found.get(key);
    if (known) {
      if (!known.where.includes(where)) known.where.push(where);
    } else if (found.size < MAX_PAGE_VALUES) {
      found.set(key, { kind, value, where: [where] });
    } else {
      cut = true;
    }
  };
  const links = doc.links;
  for (let i = 0; i < Math.min(links.length, MAX_LINKS); i++) {
    const value = linkValue(links[i]!.href.slice(0, MAX_ADDRESS));
    if (value) add(value[0], value[1], 'link');
  }
  // innerText is the text the page shows, without hidden parts, scripts or styles.
  for (const v of findValues((doc.body?.innerText ?? '').slice(0, MAX_PAGE_TEXT))) add(v.kind, v.value, 'page_text');
  // An organization or a person in schema.org gives its email, telephone and its accounts elsewhere (sameAs), also in a contact point.
  let budget = MAX_STRUCTURED_NODES * 10;
  const visit = (value: unknown, depth: number) => {
    if (budget-- <= 0 || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isNode(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const texts = [item].flat().filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, MAX_ADDRESS));
      if (key === 'email') {
        for (const text of texts) {
          const email = findValues(text.replace(/^mailto:/i, '')).find((v) => v.kind === 'email');
          if (email) add('email', email.value, 'schema_org');
        }
      } else if (key === 'telephone') {
        for (const text of texts) {
          const phone = phoneValue(text);
          if (phone) add('phone', phone, 'schema_org');
        }
      } else if (key === 'sameAs') {
        for (const text of texts) {
          const account = /^https?:/i.test(text) ? linkValue(text) : null;
          if (account) add(account[0], account[1], 'schema_org');
        }
      } else {
        visit(item, depth + 1);
      }
    }
  };
  visit(data.roots, 0);
  const values = [...found.values()].sort((a, b) => PAGE_VALUE_KINDS.indexOf(a.kind) - PAGE_VALUE_KINDS.indexOf(b.kind));
  return cut ? { values, values_cut: true } : { values };
}

type LinkValue = [PageValueKind, string];

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** The email address of a mailto: link, the number of a tel: link, or the account a web link leads to. */
function linkValue(href: string): LinkValue | null {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === 'mailto') {
    const email = findValues(decoded(href.slice(7).split('?')[0]!)).find((v) => v.kind === 'email');
    return email ? ['email', email.value] : null;
  }
  if (scheme === 'tel') {
    const phone = phoneValue(decoded(href.slice(4)));
    return phone ? ['phone', phone] : null;
  }
  if (scheme !== 'http' && scheme !== 'https') return null;
  try {
    return accountOf(new URL(href));
  } catch {
    return null;
  }
}

/** A number as + and digits, without what separates them; null for a short code or anything that is not a number. */
function phoneValue(raw: string): string | null {
  const number = raw.split(/[;,?]/)[0]!.replace(/[\s()./\u2010-\u2015-]/g, '');
  return /^\+?\d{6,15}$/.test(number) ? number : null;
}

/** Paths of the sites that are pages of the site itself, not accounts. */
const X_PATHS = new Set(['about', 'account', 'compose', 'download', 'explore', 'hashtag', 'home', 'i', 'intent', 'jobs', 'login', 'logout', 'messages', 'notifications', 'privacy', 'rules', 'search', 'settings', 'share', 'signup', 'tos', 'widgets']);
const FACEBOOK_PATHS = new Set(['bookmarks', 'business', 'campaign', 'careers', 'dialog', 'events', 'friends', 'fundraisers', 'gaming', 'groups', 'hashtag', 'latest', 'legal', 'login', 'marketplace', 'media', 'messages', 'notes', 'notifications', 'pages', 'people', 'photo', 'photos', 'plugins', 'policies', 'policy', 'privacy', 'recover', 'reels', 'search', 'settings', 'share', 'sharer', 'signup', 'stories', 'terms', 'video', 'videos', 'watch']);
const INSTAGRAM_PATHS = new Set(['about', 'accounts', 'api', 'challenge', 'developer', 'direct', 'directory', 'emails', 'explore', 'legal', 'locations', 'oauth', 'p', 'press', 'privacy', 'reel', 'reels', 'static', 'stories', 'terms', 'topics', 'tv', 'web']);
const GITHUB_PATHS = new Set(['about', 'accessibility', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories', 'dashboard', 'education', 'enterprise', 'events', 'explore', 'features', 'git-guides', 'home', 'issues', 'join', 'login', 'logout', 'marketplace', 'mcp', 'mobile', 'models', 'new', 'nonprofit', 'notifications', 'orgs', 'organizations', 'partners', 'premium-support', 'pricing', 'pulls', 'readme', 'resources', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sitemap', 'solutions', 'spark', 'sponsors', 'stars', 'team', 'topics', 'trending', 'trust-center', 'watching', 'why-github']);

/**
 * The account a link leads to, as the site's address without https:// and in lower case where case does not
 * matter. Only a link to the account itself counts: a post, a video or a share button is not an account.
 */
function accountOf(url: URL): LinkValue | null {
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const [first = '', second = ''] = parts;
  const lower = first.toLowerCase();
  if (host === 'x.com' || host === 'twitter.com') {
    // Follow buttons name the account in the address.
    const name = parts.length === 2 && lower === 'intent' && /^(?:follow|user)$/i.test(second) ? (url.searchParams.get('screen_name') ?? '') : parts.length === 1 ? first : '';
    return /^\w{1,15}$/.test(name) && !X_PATHS.has(name.toLowerCase()) ? ['x', `@${name}`] : null;
  }
  if (host === 't.me' || host === 'telegram.me') {
    const found = findValues(`t.me${url.pathname}`)[0];
    return found?.kind === 'telegram' && found.index === 0 ? ['telegram', found.value] : null;
  }
  if (host === 'facebook.com' || host === 'fb.com') {
    const id = lower === 'profile.php' ? url.searchParams.get('id') : (lower === 'people' || lower === 'pages') && parts.length === 3 ? parts[2]! : null;
    if (id !== null) return /^\d{5,20}$/.test(id) ? ['facebook', `facebook.com/profile.php?id=${id}`] : null;
    if (lower === 'groups' && parts.length === 2 && /^[\w.-]{2,100}$/.test(second)) return ['facebook', `facebook.com/groups/${second.toLowerCase()}`];
    return parts.length === 1 && /^[a-z\d.]{5,50}$/i.test(first) && !FACEBOOK_PATHS.has(lower) && !lower.endsWith('.php') ? ['facebook', `facebook.com/${lower}`] : null;
  }
  if (host === 'instagram.com') {
    return parts.length === 1 && /^(?!\.)[\w.]{1,30}(?<!\.)$/.test(first) && !INSTAGRAM_PATHS.has(lower) ? ['instagram', `instagram.com/${lower}`] : null;
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const slug = decoded(second).toLowerCase();
    return parts.length === 2 && ['in', 'company', 'school', 'showcase'].includes(lower) && /^[^\s/?#]{2,100}$/u.test(slug) ? ['linkedin', `linkedin.com/${lower}/${slug}`] : null;
  }
  if (host === 'youtube.com') {
    // The tabs of a channel, such as /@name/videos, are the channel too.
    if (/^@[\w.-]{3,30}$/.test(first)) return ['youtube', `youtube.com/${lower}`];
    if (lower === 'channel' && /^UC[\w-]{22}$/.test(second)) return ['youtube', `youtube.com/channel/${second}`];
    return (lower === 'c' || lower === 'user') && /^[\w.-]{1,100}$/.test(second) ? ['youtube', `youtube.com/${lower}/${second.toLowerCase()}`] : null;
  }
  if (host === 'tiktok.com') return parts.length === 1 && /^@[\w.]{2,24}$/.test(first) ? ['tiktok', `tiktok.com/${lower}`] : null;
  if (host === 'github.com') {
    return parts.length === 1 && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(first) && !GITHUB_PATHS.has(lower) ? ['github', `github.com/${lower}`] : null;
  }
  if (host === 'discord.gg' || ((host === 'discord.com' || host === 'discordapp.com') && lower === 'invite')) {
    // Invite codes are case-sensitive.
    const code = host === 'discord.gg' ? (parts.length === 1 ? first : '') : parts.length === 2 ? second : '';
    return /^[\w-]{2,32}$/.test(code) ? ['discord', `discord.gg/${code}`] : null;
  }
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
    if (parts.length !== 2 || !/^[\w-]{2,21}$/.test(second)) return null;
    if (lower === 'r') return ['reddit', `reddit.com/r/${second.toLowerCase()}`];
    return lower === 'user' || lower === 'u' ? ['reddit', `reddit.com/user/${second.toLowerCase()}`] : null;
  }
  return null;
}

/** A stored value that reads back as itself: a value of a text found in it, a number, or an account its link leads to. */
function valueChecks(kind: PageValueKind, value: string): boolean {
  if (kind === 'phone') return phoneValue(value) === value;
  if (kind === 'x') return /^@\w{1,15}$/.test(value) && !X_PATHS.has(value.slice(1).toLowerCase());
  if (kind === 'email' || kind === 'bitcoin' || kind === 'ethereum' || kind === 'iban') {
    const found = findValues(value);
    return found.length === 1 && found[0]!.kind === kind && found[0]!.value === value;
  }
  try {
    const account = accountOf(new URL(`https://${value}`));
    return account?.[0] === kind && account[1] === value;
  } catch {
    return false;
  }
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
  // Each kind of place has its own budget, so a large script cannot hide a pixel image or an ad tag.
  const budgeted = (max: number, where: TrackerPlace) => {
    let budget = max;
    return (code: string) => {
      if (budget <= 0) return;
      const part = code.slice(0, budget);
      budget -= part.length;
      scan(part, where);
    };
  };
  const inline = budgeted(MAX_SCRIPT_TEXT, 'inline_script');
  const addresses = budgeted(MAX_SCRIPT_TEXT, 'script_address');
  for (const script of Array.from(doc.scripts)) {
    if (script.src) addresses(script.src.slice(0, MAX_ADDRESS));
    else if (/^$|javascript|ecmascript|module/i.test(script.type)) inline(script.textContent ?? '');
  }
  // A page with scripts keeps noscript content as text, a document read without scripts as elements; innerHTML has both.
  const noscripts = budgeted(MAX_NOSCRIPT_TEXT, 'noscript');
  for (const noscript of Array.from(doc.querySelectorAll('noscript'))) noscripts(noscript.innerHTML);
  const tags = budgeted(MAX_NOSCRIPT_TEXT, 'ad_tag');
  for (const ad of Array.from(doc.querySelectorAll('[data-ad-client]'))) tags((ad.getAttribute('data-ad-client') ?? '').slice(0, MAX_ADDRESS));
  const images = budgeted(MAX_NOSCRIPT_TEXT, 'image');
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src*="facebook.com/tr"]'))) images(img.src.slice(0, MAX_ADDRESS));
  // AMP pages configure their analytics in amp-analytics (an address or JSON) and send pixels with amp-pixel.
  const amp = budgeted(MAX_NOSCRIPT_TEXT, 'amp_tag');
  for (const tag of Array.from(doc.querySelectorAll('amp-analytics'))) {
    amp((tag.getAttribute('config') ?? '').slice(0, MAX_ADDRESS));
    for (const config of Array.from(tag.querySelectorAll('script'))) amp(config.textContent ?? '');
  }
  for (const pixel of Array.from(doc.querySelectorAll('amp-pixel[src]'))) amp((pixel.getAttribute('src') ?? '').slice(0, MAX_ADDRESS));
  return [...found.values()];
}

function readDeclared(doc: Document, data: StructuredData): DeclaredValue[] {
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
  // An empty href would resolve to the page's own address, which the page did not declare.
  const canonical = doc.querySelector<HTMLLinkElement>('link[rel~="canonical" i][href]');
  if (canonical?.getAttribute('href')?.trim()) put('canonical', canonical.href, 'link rel=canonical');
  const { nodes, byId } = data;
  for (const node of nodes) {
    // What the page is about, not breadcrumbs or images around it; the type of the website or the page as a container is not news.
    if (!('headline' in node || 'author' in node || 'publisher' in node || 'datePublished' in node)) continue;
    for (const type of [node['@type']].flat()) if (!isContainer(type)) put('type', type, 'schema.org');
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
/** WebSite and the WebPage types (CollectionPage, ProfilePage…) hold what a page is about, in mainEntity. */
const isContainer = (type: unknown) => type === 'WebSite' || (typeof type === 'string' && /Page$/.test(type));
const isNode = (value: unknown): value is Node => !!value && typeof value === 'object' && !Array.isArray(value);

interface StructuredData {
  /** Each JSON-LD script as parsed. */
  roots: unknown[];
  nodes: Node[];
  byId: Map<string, Node>;
}

/** The schema.org objects in the page's JSON-LD, with @graph lists and main entities opened, and the objects by @id for references. */
function structuredData(doc: Document): StructuredData {
  const roots: unknown[] = [];
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
      if (value.mainEntity) visit(value.mainEntity, depth + 1);
    }
  };
  let budget = MAX_STRUCTURED_DATA;
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'))) {
    const text = script.textContent ?? '';
    if (text.length > budget) continue;
    budget -= text.length;
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      try {
        // Pages often leave line breaks and tabs inside strings, which JSON does not allow; as spaces they read the same.
        root = JSON.parse(Array.from(text, (c) => (c.charCodeAt(0) < 0x20 ? ' ' : c)).join(''));
      } catch {
        // Broken structured data is skipped.
        continue;
      }
    }
    roots.push(root);
    visit(root, 0);
  }
  return { roots, nodes, byId };
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
  const code: PageCode = { declared, trackers };
  if (value.values !== undefined) {
    if (!Array.isArray(value.values) || value.values.length > MAX_PAGE_VALUES) return null;
    code.values = [];
    for (const v of value.values) {
      if (!isNode(v) || !PAGE_VALUE_KINDS.includes(v.kind as PageValueKind) || typeof v.value !== 'string' || !valueChecks(v.kind as PageValueKind, v.value)) return null;
      if (!tagList(v.where, PAGE_PLACES)) return null;
      code.values.push({ kind: v.kind as PageValueKind, value: v.value, where: [...(v.where as PagePlace[])] });
    }
  }
  if (value.values_cut !== undefined) {
    if (value.values_cut !== true || !code.values) return null;
    code.values_cut = true;
  }
  return code;
}

/** A list of one or more different words from `allowed`. */
function tagList(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((v) => typeof v === 'string' && allowed.includes(v));
}
