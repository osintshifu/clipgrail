/** Longest snapshot text stored, in Unicode code points. Longer text is cut and marked truncated. */
export const MAX_SNAPSHOT_CHARACTERS = 1_000_000;

/** "1 source", "2 sources". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Counts Unicode code points (a surrogate pair counts once). */
export function countCharacters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalCharacterCount: number;
}

/** Cuts text after `max` code points without splitting a surrogate pair. */
export function truncateToCharacters(text: string, max: number): TruncatedText {
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === max) {
      return { text: text.slice(0, end), truncated: true, originalCharacterCount: countCharacters(text) };
    }
    count++;
    end += char.length;
  }
  return { text, truncated: false, originalCharacterCount: count };
}

/**
 * Canonical snapshot text form: well-formed Unicode (lone surrogates become
 * U+FFFD, so UTF-8 encoding is lossless), LF line endings, no trailing
 * whitespace on lines, at most one blank line in a row, no leading or
 * trailing blank space.
 */
export function normalizeText(raw: string): string {
  return raw
    .toWellFormed()
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HGROUP', 'HR', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'UL',
]);

const SKIPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK',
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Converts an element tree to readable plain text: blocks become paragraphs,
 * list items get "- " or "1. " prefixes, table cells are joined with " | ",
 * <pre> keeps its whitespace. Never produces HTML or Markdown markup.
 */
export function elementToText(root: Node): string {
  let out = '';
  let pendingBreak = 0;
  let pendingPrefix = '';

  const requestBreak = (lines: number) => {
    pendingBreak = Math.max(pendingBreak, lines);
  };

  const write = (s: string) => {
    if (!s) return;
    if (out && pendingBreak) out += '\n'.repeat(pendingBreak);
    pendingBreak = 0;
    out += pendingPrefix;
    pendingPrefix = '';
    out += s;
  };

  const walk = (node: Node, pre: boolean, listDepth: number) => {
    if (node.nodeType === TEXT_NODE) {
      let value = node.nodeValue ?? '';
      if (!pre) {
        value = value.replace(/[ \t\n\r\f]+/g, ' ');
        if (pendingBreak || pendingPrefix || out === '' || out.endsWith('\n') || out.endsWith(' ')) {
          value = value.replace(/^ /, '');
        }
      }
      write(value);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      // Document and fragment nodes: walk their children.
      node.childNodes.forEach((child) => walk(child, pre, listDepth));
      return;
    }

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;

    if (tag === 'BR') {
      if (out) {
        if (pendingBreak) out += '\n'.repeat(pendingBreak);
        pendingBreak = 0;
        out += '\n';
      }
      return;
    }

    if (tag === 'LI') {
      const parent = el.parentElement;
      const ordered = parent?.tagName.toUpperCase() === 'OL';
      let marker = '- ';
      if (ordered && parent) {
        const start = Number.parseInt(parent.getAttribute('start') ?? '1', 10) || 1;
        const index = Array.from(parent.children).filter((c) => c.tagName.toUpperCase() === 'LI').indexOf(el);
        marker = `${start + index}. `;
      }
      requestBreak(1);
      pendingPrefix = '  '.repeat(Math.max(0, listDepth - 1)) + marker;
      el.childNodes.forEach((child) => walk(child, pre, listDepth));
      pendingPrefix = '';
      requestBreak(1);
      return;
    }

    if (tag === 'TR') {
      requestBreak(1);
      let first = true;
      for (const cell of Array.from(el.children)) {
        const cellTag = cell.tagName.toUpperCase();
        if (cellTag !== 'TD' && cellTag !== 'TH') continue;
        if (!first) write(' | ');
        first = false;
        cell.childNodes.forEach((child) => walk(child, pre, listDepth));
      }
      requestBreak(1);
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    const isList = tag === 'UL' || tag === 'OL';
    const isPre = tag === 'PRE';
    if (isBlock) requestBreak(isList && listDepth > 0 ? 1 : 2);
    el.childNodes.forEach((child) => walk(child, pre || isPre, isList ? listDepth + 1 : listDepth));
    if (isBlock) requestBreak(isList && listDepth > 0 ? 1 : 2);
  };

  walk(root, false, 0);
  return normalizeText(out);
}
