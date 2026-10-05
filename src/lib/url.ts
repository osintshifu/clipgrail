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

/** Returns true for URLs ClipGrail can capture (http and https). */
export function isCapturableUrl(url: string): boolean {
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
 * - removes the fragment, except hash routes (`#/...`, `#!...`) that select content;
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

  const fragment = url.hash.slice(1).split(':~:', 1)[0] ?? '';
  url.hash = fragment.startsWith('/') || fragment.startsWith('!') ? fragment : '';

  return url.href;
}
