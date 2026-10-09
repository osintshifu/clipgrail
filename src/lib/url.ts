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

/** The address without a user name and password written into it (https://name:password@host/); any other address is returned unchanged. */
export function withoutCredentials(input: string): string {
  try {
    const url = new URL(input);
    if (!url.username && !url.password) return input;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return input;
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

/**
 * Parameters that carry a credential: whoever has the address can sign in,
 * reset a password, join a meeting or download a private file. Names are
 * compared in lower case without "-" and "_", so accessToken and access-token
 * match access_token.
 */
const CREDENTIAL_PARAMS = new Set([
  // OAuth 2.0 tokens (RFC 6749; the implicit grant returns access_token in the fragment) and the OpenID Connect ID token.
  'accesstoken',
  'idtoken',
  'refreshtoken',
  // OAuth 1.0a verifier (RFC 5849).
  'oauthverifier',
  // Signed links to private files: AWS S3 Signature Version 4 and Google Cloud Storage V4 signing.
  'xamzsignature',
  'xgoogsignature',
  // Password-reset and invitation links (Devise, used by GitLab and Mastodon) and generic token parameters.
  'resetpasswordtoken',
  'invitationtoken',
  'token',
  'authtoken',
  'privatetoken',
  // API keys and client secrets.
  'apikey',
  'clientsecret',
  // Passwords, including the Zoom meeting passcode.
  'password',
  'pwd',
  // Session identifiers that PHP and Java servlet sites put in the address.
  'phpsessid',
  'jsessionid',
]);

/** Pairs that carry a credential only together. */
const CREDENTIAL_PAIRS: Array<[string, string]> = [
  // Azure Storage shared access signature: signature and service version.
  ['sig', 'sv'],
  // Signed links: AWS Signature Version 2, CloudFront, Google Cloud Storage V2 and Alibaba Cloud OSS.
  ['signature', 'awsaccesskeyid'],
  ['signature', 'keypairid'],
  ['signature', 'googleaccessid'],
  ['signature', 'ossaccesskeyid'],
  // WordPress password-reset link (wp-login.php?action=rp&key=...&login=...).
  ['key', 'login'],
];

function parameterNames(part: string): string[] {
  return part
    .split(/[?&]/)
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const raw = pair.split('=', 1)[0] ?? '';
      let name: string;
      try {
        name = decodeURIComponent(raw.replace(/\+/g, ' '));
      } catch {
        name = raw;
      }
      return name.toLowerCase().replace(/[-_]/g, '');
    });
}

/**
 * Returns true for an address with a sign-in or access credential in its query
 * or in a fragment written as parameters (`#access_token=...`, `#/reset?token=...`).
 * Only the listed parameter names are recognised: a credential under another
 * name, or written into the path itself, is not.
 */
export function carriesCredential(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const names = new Set([...parameterNames(url.search.slice(1)), ...parameterNames(url.hash.slice(1))]);
  return [...names].some((name) => CREDENTIAL_PARAMS.has(name)) || CREDENTIAL_PAIRS.some(([a, b]) => names.has(a) && names.has(b));
}

/**
 * The host a site is written as, in the form Chrome reports it (lower case,
 * international names in Punycode), or null when the value is not a site.
 * A scheme, port, path and trailing dot are dropped, so a pasted address
 * works, and so is a leading `*.` or `.`, since a site covers its subdomains.
 */
export function siteHost(value: string): string | null {
  const bare = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\*?\./, '');
  if (!bare || /\s/.test(bare)) return null;
  try {
    const host = new URL(`http://${bare}`).hostname.replace(/\.$/, '');
    return host && !/\*|\.\.|^\.|\.$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** True when the host (with or without a trailing dot) is the site itself or one of its subdomains. */
export function isOnSite(host: string, site: string): boolean {
  const name = host.replace(/\.$/, '');
  return name === site || name.endsWith(`.${site}`);
}

/** Longest embedded-frame address kept with a selection; a longer one (such as a data: URL) is recorded as not read. */
export const MAX_FRAME_URL_LENGTH = 8192;

/** An embedded frame's address as it can be stored: any scheme, within the length limit, without breaking characters. */
export function frameAddress(url: unknown): string | null {
  return typeof url === 'string' && url && url.length <= MAX_FRAME_URL_LENGTH && !hasBreakingCharacter(url) ? url : null;
}
