/**
 * Deduplication URL rules. Only parameters with a documented tracking role are
 * removed; everything else, including `ref` and unknown `mc_*`, is kept.
 */

/** Parameters removed on every host. */
const TRACKING_PARAMS = new Set([
  // Google Ads / Campaign Manager click identifiers and the GA4 cross-domain linker.
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  '_gl',
  // Click identifiers of Meta, Microsoft Ads, Yandex, TikTok, X and Instagram shares.
  'fbclid',
  'msclkid',
  'yclid',
  'ttclid',
  'twclid',
  'igshid',
  // Mailchimp campaign and subscriber identifiers (only these two mc_ parameters).
  'mc_cid',
  'mc_eid',
]);

/** Parameters removed only on specific hosts, where their tracking role is documented. */
const HOST_TRACKING_PARAMS: Array<{ hosts: RegExp; params: Set<string> }> = [
  // YouTube share identifier. `v`, `t`, `list` and other parameters stay.
  { hosts: /(^|\.)(youtube\.com|youtu\.be)$/, params: new Set(['si']) },
];

function isTrackingParam(name: string, host: string): boolean {
  const key = name.toLowerCase();
  // utm_* is the reserved Urchin/Google Analytics campaign prefix.
  if (key.startsWith('utm_')) return true;
  if (TRACKING_PARAMS.has(key)) return true;
  return HOST_TRACKING_PARAMS.some((rule) => rule.hosts.test(host) && rule.params.has(key));
}

/**
 * Spaces, control characters and line breaks never appear in an address as
 * the browser writes it; the URL parser would silently drop some of them.
 */
function hasBreakingCharacter(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Returns true for addresses kept as provenance (the page a link was found on): http, https and file. */
export function isProvenanceUrl(url: string): boolean {
  if (hasBreakingCharacter(url)) return false;
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Returns true for URLs ClipGrail can capture (http and https). */
export function isCapturableUrl(url: string): boolean {
  if (hasBreakingCharacter(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Returns the URL used to deduplicate sources, or null for non-http(s) URLs.
 *
 * - removes documented tracking parameters, keeps the order of the rest;
 * - keeps the fragment, which can select content (`#/route`, `#@channel`, `#gid=2`);
 *   removes only a text fragment (`#:~:text=...`) and an empty `#`;
 * - removes user:password credentials;
 * - keeps path, trailing slash, host and every other parameter unchanged.
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.username = '';
  url.password = '';

  if (url.search) {
    const kept = url.search
      .slice(1)
      .split('&')
      .filter((pair) => {
        if (pair === '') return false;
        const rawName = pair.split('=', 1)[0] ?? '';
        let name: string;
        try {
          name = decodeURIComponent(rawName.replace(/\+/g, ' '));
        } catch {
          name = rawName;
        }
        return !isTrackingParam(name, url.hostname);
      });
    url.search = kept.length ? `?${kept.join('&')}` : '';
  }

  url.hash = url.hash.slice(1).split(':~:', 1)[0] ?? '';

  return url.href;
}

/** Longest embedded-frame address kept with a selection; a longer one (such as a data: URL) is recorded as not read. */
export const MAX_FRAME_URL_LENGTH = 8192;

/** An embedded frame's address as it can be stored: any scheme, within the length limit, without breaking characters. */
export function frameAddress(url: unknown): string | null {
  return typeof url === 'string' && url && url.length <= MAX_FRAME_URL_LENGTH && !hasBreakingCharacter(url) ? url : null;
}
