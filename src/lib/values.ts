/**
 * Values in a text that can tie sources together: email addresses, Bitcoin
 * and Ethereum addresses, IBANs and Telegram links. Each is taken only in a
 * form that can be checked, with its checksum where it has one, so a string
 * that only looks like one is left out.
 */

export type TextValueKind = 'email' | 'bitcoin' | 'ethereum' | 'iban' | 'telegram';

export interface FoundValue {
  kind: TextValueKind;
  /** One form for the same value however it is written: lower case where case does not matter, an IBAN in groups of four. */
  value: string;
  /** Where the value starts in the text, and the text as written there. */
  index: number;
  raw: string;
}

/**
 * Letters and digits that join a value to a word: a value must not start or end next to one. Scripts written without spaces
 * between words, and Korean, whose endings attach to the word before, are left out, so a value written next to them is found.
 */
const WORD = String.raw`[\p{L}\p{N}]--[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]`;
const pattern = (source: string, flags = 'gv') => new RegExp(source, flags);

const EMAIL = pattern(
  String.raw`(?<![[${WORD}]._%+\-])[A-Za-z0-9](?:[A-Za-z0-9._%+\-]{0,62}[A-Za-z0-9_%+\-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![[${WORD}]_\-]|\.[${WORD}])`,
);
/** Image and file names such as icon@2x.png look like addresses. */
const FILE_ENDINGS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'css', 'js']);
const SEGWIT = pattern(String.raw`(?<![${WORD}])(?:bc1[ac-hj-np-z02-9]{11,71}|BC1[AC-HJ-NP-Z02-9]{11,71})(?![${WORD}])`);
const BASE58_ADDRESS = pattern(String.raw`(?<![${WORD}])[13][1-9A-HJ-NP-Za-km-z]{25,34}(?![${WORD}])`);
const ETHEREUM = pattern(String.raw`(?<![${WORD}])0x[0-9a-fA-F]{40}(?![${WORD}])`);
/** Country, check digits and the account in groups of four, with or without spaces between them. */
const IBAN = pattern(String.raw`(?<![${WORD}])[A-Z]{2}\d{2}(?:[ \t\u00a0\u202f]?[A-Z0-9]{4}){2,7}(?:[ \t\u00a0\u202f]?[A-Z0-9]{1,3})?(?![${WORD}])`);
/** The length of the IBANs of each country in the SWIFT IBAN registry. */
const IBAN_LENGTHS = new Map(
  ('AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 ' +
    'GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 ' +
    'MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 ' +
    'UA29 VA22 VG24 XK20 YE30')
    .split(' ')
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
);
/** A public username (also from a post or preview link) or an invite link. */
const TELEGRAM = pattern(
  String.raw`(?<![[${WORD}]_.\/@\-])(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?(\+[\w\-]{10,64}|joinchat\/[\w\-]{10,64}|[A-Za-z]\w{3,31})(?![\w\-])`,
  'giv',
);
/** Paths of t.me that are not usernames. */
const TELEGRAM_PATHS = new Set(['addemoji', 'addlist', 'addstickers', 'addtheme', 'boost', 'confirmphone', 'contact', 'giftcode', 'invoice', 'joinchat', 'login', 'proxy', 'setlanguage', 'share', 'socks']);

/** The checked values in a text, in the order they appear. */
export function findValues(text: string): FoundValue[] {
  const found: FoundValue[] = [];
  const add = (kind: TextValueKind, value: string, index: number, raw: string) => found.push({ kind, value, index, raw });
  for (const m of text.matchAll(EMAIL)) {
    const raw = emailAt(text, m.index, m[0]);
    if (raw) add('email', raw.toLowerCase(), m.index, raw);
  }
  // A list of holders or payments repeats addresses, so each checksum is worked out once.
  const checked = new Map<string, boolean>();
  const passes = (address: string, check: (address: string) => boolean) => {
    if (!checked.has(address)) checked.set(address, check(address));
    return checked.get(address)!;
  };
  for (const m of text.matchAll(SEGWIT)) if (passes(m[0].toLowerCase(), isSegwitAddress)) add('bitcoin', m[0].toLowerCase(), m.index, m[0]);
  for (const m of text.matchAll(BASE58_ADDRESS)) if (passes(m[0], isBase58Address)) add('bitcoin', m[0], m.index, m[0]);
  for (const m of text.matchAll(ETHEREUM)) if (passes(m[0].slice(2), isEthereumAddress)) add('ethereum', m[0].toLowerCase(), m.index, m[0]);
  const ibans = new RegExp(IBAN);
  for (let m = ibans.exec(text); m; m = ibans.exec(text)) {
    const raw = ibanAt(m[0]);
    if (raw) add('iban', raw.replace(/\s/g, '').replace(/(.{4})(?!$)/g, '$1 '), m.index, raw);
    // A match can run on into what follows the IBAN, such as a second IBAN, which is looked for right after.
    ibans.lastIndex = m.index + (raw?.length ?? 1);
  }
  for (const m of text.matchAll(TELEGRAM)) {
    const path = m[1]!;
    // Case-insensitive matching would also take signs that look like Latin letters, such as the Kelvin sign for K.
    if (/[^\x20-\x7e]/.test(m[0])) continue;
    if (path.startsWith('+') || /^joinchat\//i.test(path)) {
      // Invite codes are case-sensitive.
      add('telegram', `t.me/+${path.replace(/^\+|^joinchat\//i, '')}`, m.index, m[0]);
    } else if (!path.endsWith('_') && !TELEGRAM_PATHS.has(path.toLowerCase())) {
      add('telegram', `t.me/${path.toLowerCase()}`, m.index, m[0]);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * An email address as written, or null for what only looks like one: a file name such as icon@2x.png, a user in an
 * address (https://user:token@host, ssh's git@github.com:repo). A word written right after the final dot without a
 * space ("example.com.Thanks") is left out of the address.
 */
function emailAt(text: string, index: number, match: string): string | null {
  let raw = match;
  const labels = raw.slice(raw.indexOf('@') + 1).split('.');
  if (labels.length > 2 && /^[A-Z][a-z]+$/.test(labels.at(-1)!) && labels.slice(0, -1).every((l) => l === l.toLowerCase())) {
    raw = raw.slice(0, raw.lastIndexOf('.'));
  }
  const end = index + raw.length;
  if (raw.split('@')[0]!.includes('..') || FILE_ENDINGS.has(raw.slice(raw.lastIndexOf('.') + 1).toLowerCase())) return null;
  if (text[end] === ':' && /\S/.test(text[end + 1] ?? ' ')) return null;
  if (/:\/\/[^\s/]*$/.test(text.slice(Math.max(0, index - 200), index))) return null;
  return raw;
}

/** The IBAN at the start of a match: as long as its country's IBANs, ending where the match or a group ends, with right check digits. */
function ibanAt(match: string): string | null {
  const length = IBAN_LENGTHS.get(match.slice(0, 2));
  if (!length) return null;
  let end = 0;
  let characters = 0;
  while (end < match.length && characters < length) if (!/\s/.test(match[end++]!)) characters++;
  if (characters < length || /\S/.test(match[end] ?? ' ')) return null;
  const raw = match.slice(0, end);
  return ibanChecks(raw.replace(/\s/g, '')) ? raw : null;
}

// ---------- Bitcoin ----------

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** A bc1 address (lower case) whose bech32 or bech32m checksum and witness program are valid (BIP 173, BIP 350). */
function isSegwitAddress(address: string): boolean {
  const data = Array.from(address.slice(3), (c) => BECH32.indexOf(c));
  // The prefix "bc" expanded as BIP 173 sets out: high bits, a zero, low bits.
  let check = 1;
  for (const value of [3, 3, 0, 2, 3, ...data]) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= BECH32_GENERATOR[i]!;
  }
  const version = data[0]!;
  if (version > 16 || check !== (version === 0 ? 1 : 0x2bc830a3)) return false;
  const groups = data.slice(1, -6);
  const bits = groups.length * 5;
  const padding = bits % 8;
  if (padding >= 5 || (groups.at(-1)! & ((1 << padding) - 1)) !== 0) return false;
  const bytes = Math.floor(bits / 8);
  return bytes >= 2 && bytes <= 40 && (version !== 0 || bytes === 20 || bytes === 32);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A 1… or 3… address: 25 bytes whose last four are the start of the double SHA-256 of the rest. */
function isBase58Address(address: string): boolean {
  const bytes: number[] = [];
  for (const c of address) {
    let carry = BASE58.indexOf(c);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    for (; carry; carry >>= 8) bytes.push(carry & 0xff);
  }
  for (let i = 0; address[i] === '1'; i++) bytes.push(0);
  const decoded = Uint8Array.from(bytes.reverse());
  if (decoded.length !== 25 || decoded[0] !== (address[0] === '1' ? 0 : 5)) return false;
  const sum = sha256(sha256(decoded.subarray(0, 21)));
  return sum.subarray(0, 4).every((b, i) => b === decoded[21 + i]);
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a short input, kept synchronous so a text is checked in one pass; Web Crypto hashes the saved texts. */
function sha256(data: Uint8Array): Uint8Array {
  const block = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(block.length - 4, data.length * 8);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < block.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (hash[i] = (hash[i]! + v) | 0));
  }
  const out = new Uint8Array(32);
  hash.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v >>> 0));
  return out;
}

// ---------- Ethereum ----------

/**
 * Forty hex digits after 0x, not all zeros. An address in mixed case carries
 * the EIP-55 checksum, which must match; one in a single case has none.
 */
function isEthereumAddress(hex: string): boolean {
  if (/^0+$/.test(hex)) return false;
  const lower = hex.toLowerCase();
  if (hex === lower || hex === hex.toUpperCase()) return true;
  const hash = keccak256(new TextEncoder().encode(lower));
  return Array.from(hex).every((c, i) => {
    if (!/[a-f]/i.test(c)) return true;
    const nibble = (hash[i >> 1]! >> (i % 2 ? 0 : 4)) & 0xf;
    return (c === c.toUpperCase()) === nibble >= 8;
  });
}

/** Rotation of each lane, by x + 5y. */
const KECCAK_ROTATION = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
/** Round constants as low and high 32 bits, from the linear feedback shift register of the Keccak reference. */
const KECCAK_ROUNDS = new Uint32Array(48);
for (let round = 0, state = 1; round < 24; round++) {
  for (let j = 0; j < 7; j++) {
    const bit = (1 << j) - 1;
    const at = 2 * round + (bit >> 5);
    if (state & 1) KECCAK_ROUNDS[at] = KECCAK_ROUNDS[at]! | (1 << (bit & 31));
    state = ((state << 1) ^ (state & 0x80 ? 0x71 : 0)) & 0xff;
  }
}

/** Rotates the 64-bit lane (lo, hi) left by n and writes it at out[at], out[at + 1]. */
function rotate(lo: number, hi: number, n: number, out: Uint32Array, at: number): void {
  if (n >= 32) [lo, hi, n] = [hi, lo, n - 32];
  out[at] = n ? (lo << n) | (hi >>> (32 - n)) : lo;
  out[at + 1] = n ? (hi << n) | (lo >>> (32 - n)) : hi;
}

/** Keccak-256 as Ethereum uses it (not the later SHA3-256), with each 64-bit lane as two 32-bit halves. */
function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const block = new Uint8Array((Math.floor(data.length / rate) + 1) * rate);
  block.set(data);
  block[data.length] = 0x01;
  block[block.length - 1] = block[block.length - 1]! | 0x80;
  const view = new DataView(block.buffer);
  const s = new Uint32Array(50);
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  const d = new Uint32Array(2);
  for (let offset = 0; offset < block.length; offset += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] = s[i]! ^ view.getUint32(offset + i * 4, true);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 10; x++) c[x] = s[x]! ^ s[x + 10]! ^ s[x + 20]! ^ s[x + 30]! ^ s[x + 40]!;
      for (let x = 0; x < 5; x++) {
        const next = 2 * ((x + 1) % 5);
        const before = 2 * ((x + 4) % 5);
        rotate(c[next]!, c[next + 1]!, 1, d, 0);
        for (let y = 0; y < 50; y += 10) {
          s[2 * x + y] = s[2 * x + y]! ^ c[before]! ^ d[0]!;
          s[2 * x + y + 1] = s[2 * x + y + 1]! ^ c[before + 1]! ^ d[1]!;
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const i = x + 5 * y;
          rotate(s[2 * i]!, s[2 * i + 1]!, KECCAK_ROTATION[i]!, b, 2 * (y + 5 * ((2 * x + 3 * y) % 5)));
        }
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          const i = 2 * (x + y);
          const j = 2 * (((x + 1) % 5) + y);
          const k = 2 * (((x + 2) % 5) + y);
          s[i] = b[i]! ^ (~b[j]! & b[k]!);
          s[i + 1] = b[i + 1]! ^ (~b[j + 1]! & b[k + 1]!);
        }
      }
      s[0] = s[0]! ^ KECCAK_ROUNDS[2 * round]!;
      s[1] = s[1]! ^ KECCAK_ROUNDS[2 * round + 1]!;
    }
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, s[i]!, true);
  return out;
}

// ---------- IBAN ----------

/** An IBAN whose check digits are right (ISO 13616: the number with the country moved to the end leaves 1 when divided by 97). */
function ibanChecks(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const digits = Number(iban.slice(2, 4));
  if (digits < 2 || digits > 98) return false;
  let rest = 0;
  for (const c of iban.slice(4) + iban.slice(0, 4)) {
    const n = parseInt(c, 36);
    rest = (rest * (n > 9 ? 100 : 10) + n) % 97;
  }
  return rest === 1;
}
