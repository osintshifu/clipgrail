/**
 * Pivots: values that can tie sources together. Tracker IDs, what pages
 * declare about themselves and the contacts, accounts and payment addresses in
 * their links, visible text and schema.org data are read when a page is clipped; email,
 * Bitcoin and Ethereum addresses, IBANs and Telegram links are also found in
 * saved texts and selections. A value in several sources is a lead to check,
 * not proof that the sources are connected.
 */
import type { DeclaredField, Fragment, PagePlace, PageValueKind, TrackerKind } from './model';
import type { LibraryEntry } from './library';
import { versionsOf } from './library';
import type { Snippet } from './search';
import { fold, searchWords, searchable } from './search';
import { DECLARED_LABELS, PLACE_WORDS, TRACKER_LABELS, VALUE_LABELS, hostOf } from './describe';
import { findValues } from './values';
import type { TextValueKind } from './values';

export type PivotGroup = 'tracker' | 'declared' | 'contact';
/** Names a page declares that can tie it to others; dates, types, generators and canonical addresses do not. Its X account is a contact. */
type DeclaredPivot = Extract<DeclaredField, 'site_name' | 'publisher' | 'author'>;
export type PivotKind = TrackerKind | DeclaredPivot | PageValueKind;

export interface PivotKindInfo {
  /** A short name shown before the value in the list. */
  badge: string;
  label: string;
  group: PivotGroup;
  mono: boolean;
}

const tracker = (badge: string, kind: TrackerKind): PivotKindInfo => ({ badge, label: TRACKER_LABELS[kind], group: 'tracker', mono: true });
const declared = (badge: string, field: DeclaredPivot): PivotKindInfo => ({ badge, label: DECLARED_LABELS[field], group: 'declared', mono: false });
const contact = (badge: string, kind: PageValueKind, mono = false): PivotKindInfo => ({ badge, label: VALUE_LABELS[kind], group: 'contact', mono });

/** The kinds of values, in the order the list shows values found in as many sources. */
export const PIVOT_KINDS: Record<PivotKind, PivotKindInfo> = {
  ga4: tracker('GA4', 'ga4'),
  google_tag: tracker('GT', 'google_tag'),
  ua: tracker('UA', 'ua'),
  gtm: tracker('GTM', 'gtm'),
  meta_pixel: tracker('Pixel', 'meta_pixel'),
  adsense: tracker('AdSense', 'adsense'),
  site_name: declared('Site', 'site_name'),
  publisher: declared('Publisher', 'publisher'),
  author: declared('Author', 'author'),
  email: contact('Email', 'email'),
  phone: contact('Phone', 'phone', true),
  x: contact('X', 'x'),
  telegram: contact('Telegram', 'telegram'),
  facebook: contact('Facebook', 'facebook'),
  instagram: contact('Instagram', 'instagram'),
  linkedin: contact('LinkedIn', 'linkedin'),
  youtube: contact('YouTube', 'youtube'),
  tiktok: contact('TikTok', 'tiktok'),
  github: contact('GitHub', 'github'),
  discord: contact('Discord', 'discord'),
  reddit: contact('Reddit', 'reddit'),
  bitcoin: contact('BTC', 'bitcoin', true),
  ethereum: contact('ETH', 'ethereum', true),
  iban: contact('IBAN', 'iban', true),
};
const KIND_ORDER = Object.keys(PIVOT_KINDS);

export const PIVOT_GROUPS: Record<PivotGroup, string> = { tracker: 'Trackers', declared: 'Declared by pages', contact: 'Contacts and addresses' };

/** What a value shared by several sources can and cannot show, by group. */
export const PIVOT_NOTES: Record<PivotGroup, string> = {
  tracker: 'The same ID on different sites often means a common operator, but an agency, a template or a copied page can share one too. Check before you conclude.',
  declared: 'Pages declare these about themselves and nothing checks them: the same name on several pages shows they declare it, not who made them.',
  contact:
    "The same value in several sources shows they give or mention it. A page can link to someone else's account, and sites made by one agency or from one template can share one: it does not show who controls it or that the sources are connected.",
};

/** A value found in a saved text or a selection: where it first appears, with the passage around it. */
export interface TextFind {
  kind: TextValueKind;
  value: string;
  /** The value as written in the text. */
  raw: string;
  snippet: Snippet;
}

const PASSAGE_BEFORE = 60;
const PASSAGE_AFTER = 160;

/** The values of a text, each once. */
export function textFinds(text: string): TextFind[] {
  const seen = new Set<string>();
  return findValues(text).flatMap((found) => {
    const key = `${found.kind} ${found.value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: found.kind, value: found.value, raw: found.raw, snippet: passage(text, found.index, found.index + found.raw.length) }];
  });
}

/** The passage around a value, starting after a space and never splitting a character written as two code units, with the value marked. */
function passage(text: string, start: number, end: number): Snippet {
  let from = Math.max(0, start - PASSAGE_BEFORE);
  const space = text.slice(from, start).search(/\s/);
  if (from > 0 && space >= 0) from += space + 1;
  let to = Math.min(text.length, end + PASSAGE_AFTER);
  if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from++;
  if (/[\uD800-\uDBFF]/.test(text[to - 1] ?? '')) to--;
  return { text: text.slice(from, to).replace(/\s/g, ' '), marks: [[start - from, end - from]], cut_before: from > 0, cut_after: to < text.length };
}

/** A selection never changes, so each is read for values once while the library is open, by its capture. */
const selectionFinds = new Map<string, TextFind[]>();
function findsInSelection(captureId: string, fragment: Fragment): TextFind[] {
  let finds = selectionFinds.get(captureId);
  if (!finds) selectionFinds.set(captureId, (finds = textFinds(fragment.text)));
  return finds;
}

/** A source a value is in. */
export interface PivotUse {
  entry: LibraryEntry;
  /** The newest capture of the source with the value: the one that opens. */
  capture_id: string;
  /** Where the value is: the tags or places of the page code, the page's links or text, or the saved text or selection. */
  where: string;
  /** The value as written there, to mark it in the reader. */
  raw: string;
  /** For a value in a saved text or a selection, the passage around it; null for one read from the page, shown in its details. */
  snippet: Snippet | null;
}

export interface Pivot {
  /** The kind and the value in one form: unique among pivots. */
  key: string;
  kind: PivotKind;
  /** The value as the source that had it first wrote it. */
  value: string;
  /** One per source, in the order the sources first had the value. */
  uses: PivotUse[];
  /** Hosts of the sources, without www. */
  sites: string[];
  sessions: number;
  /** The value, every way it is written, and its kind, folded for the search in the list. */
  haystack: string;
}

/** Where in the page a value was read, after "Page". */
const PAGE_PLACES: Record<PagePlace, string> = { link: 'link', page_text: 'text', schema_org: 'schema.org data' };

const isDeclaredPivot = (field: DeclaredField): field is DeclaredPivot => field === 'site_name' || field === 'publisher' || field === 'author';

/** Names compared without case, accents or extra spaces. */
const nameKey = (value: string) => fold(searchable(value)).replace(/ +/g, ' ').trim();
/** An X account without case, its @ or the address of its profile. */
const xKey = (value: string) => nameKey(value).replace(/^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:twitter|x)\.com\/([^/?#]+).*$/, '$1').replace(/^@/, '');

/**
 * The values in the given sources, each with the sources it is in, found on
 * more sites first. Saved texts come from `findsOf`, by snapshot ID; a text
 * not read yet adds nothing.
 */
export function collectPivots(entries: LibraryEntry[], findsOf: (snapshotId: string) => TextFind[] | undefined): Pivot[] {
  const found = new Map<string, { kind: PivotKind; uses: Map<string, { use: PivotUse; value: string; at: string }>; written: Set<string> }>();
  const add = (kind: PivotKind, key: string, value: string, use: PivotUse, at: string) => {
    // A name left empty in a page's template, such as an X account of only "@", ties nothing together.
    if (!key) return;
    const id = `${kind} ${key}`;
    let pivot = found.get(id);
    if (!pivot) found.set(id, (pivot = { kind, uses: new Map(), written: new Set() }));
    pivot.written.add(use.raw);
    const seen = pivot.uses.get(use.entry.source.id);
    // Captures come newest first: the use keeps the newest capture to open, and the time and spelling of the first.
    if (seen) Object.assign(seen, { value, at });
    else pivot.uses.set(use.entry.source.id, { use, value, at });
  };
  for (const entry of entries) {
    for (const version of versionsOf(entry)) {
      const { capture, snapshot } = version.capture;
      const use = (where: string, raw: string, snippet: Snippet | null = null): PivotUse => ({ entry, capture_id: capture.id, where, raw, snippet });
      const at = capture.captured_at;
      for (const t of capture.page_code?.trackers ?? []) add(t.kind, t.id, t.id, use(t.where.map((w) => PLACE_WORDS[w]).join(', '), t.id), at);
      for (const d of capture.page_code?.declared ?? []) {
        if (isDeclaredPivot(d.field)) add(d.field, nameKey(d.value), d.value, use(d.from.join(', '), d.value), at);
        else if (d.field === 'x_account') add('x', xKey(d.value), d.value, use(d.from.join(', '), d.value), at);
      }
      const text = version.current ? 'Saved text' : `Earlier text · capture ${version.number}`;
      if (snapshot?.status === 'ok') for (const f of findsOf(snapshot.id) ?? []) add(f.kind, f.value, f.value, use(text, f.raw, f.snippet), at);
      if (capture.fragment) for (const f of findsInSelection(capture.id, capture.fragment)) add(f.kind, f.value, f.value, use('Selection', f.raw, f.snippet), at);
      // After the saved text, so a value also in it opens there, with the passage around it.
      for (const v of capture.page_code?.values ?? []) {
        add(v.kind, v.kind === 'x' ? xKey(v.value) : v.value, v.value, use(`Page ${v.where.map((w) => PAGE_PLACES[w]).join(' and ')}`, v.value), at);
      }
    }
  }
  return [...found]
    .map(([key, { kind, uses, written }]): Pivot => {
      const sorted = [...uses.values()].sort((a, b) => a.at.localeCompare(b.at) || a.use.entry.source.number - b.use.entry.source.number);
      const value = sorted[0]!.value;
      const list = sorted.map((u) => u.use);
      return {
        key,
        kind,
        value,
        uses: list,
        sites: [...new Set(list.map((u) => hostOf(u.entry.source.dedup_url)))],
        sessions: new Set(list.map((u) => u.entry.source.session_id)).size,
        // An IBAN is found also when typed without spaces, a value also as any source wrote it.
        haystack: fold(searchable([value, value.replace(/ /g, ''), ...written, PIVOT_KINDS[kind].label, PIVOT_KINDS[kind].badge].join('\n'))),
      };
    })
    .sort(
      (a, b) =>
        b.sites.length - a.sites.length ||
        b.uses.length - a.uses.length ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.value.localeCompare(b.value),
    );
}

/** Values as a table to paste into a spreadsheet: a header, then kind, value, sources and sites, separated by tabs. */
export function pivotsTable(pivots: Pivot[]): string {
  const cell = (text: string) => text.replace(/\s+/g, ' ').trim();
  const lines = pivots.map((p) => [PIVOT_KINDS[p.kind].label, cell(p.value), String(p.uses.length), p.sites.join(', ')].join('\t'));
  return [['Kind', 'Value', 'Sources', 'Sites'].join('\t'), ...lines].join('\n') + '\n';
}

export interface PivotFilter {
  /** Words and "phrases" that must all be in the value or its kind. */
  query: string;
  group: PivotGroup | 'all';
  /** Only values in two or more sources. */
  shared: boolean;
}

export function filterPivots(pivots: Pivot[], filter: PivotFilter): Pivot[] {
  const terms = searchWords(filter.query);
  return pivots.filter(
    (p) => (!filter.shared || p.uses.length > 1) && (filter.group === 'all' || PIVOT_KINDS[p.kind].group === filter.group) && terms.every((t) => p.haystack.includes(t)),
  );
}
