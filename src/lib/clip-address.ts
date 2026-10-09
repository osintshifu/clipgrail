/**
 * Clipping a source saved as a URL only: the address its page is opened at,
 * and the sites Chrome is asked to let ClipGrail read for it.
 */
import type { Capture, Source } from './model';
import { isCapturableUrl } from './url';

/** A source to clip: where its page is opened and where its text is saved. */
export interface ClipTarget {
  source_id: string;
  /** S-label, for messages. */
  label: string;
  session_id: string;
  dedup_url: string;
  url: string;
}

/** The address a source is opened at to clip it: as its newest capture saw it, else its own. */
export function clipAddressOf(source: Source, captures: Capture[]): string {
  const newest = [...captures].sort((a, b) => b.captured_at.localeCompare(a.captured_at)).find((c) => isCapturableUrl(c.original_url));
  return newest?.original_url ?? source.dedup_url;
}

/** File types an address can end in that are not web pages: opened in a tab, most would start a download. */
const FILE_TYPES = new Set(
  ('7z apk avi bin bz2 csv deb dmg doc docx epub exe gz iso jar m4a mkv mov mp3 mp4 msi odp ods odt pdf pkg ppt pptx rar rpm rtf tar tgz wav webm xls xlsx xz zip').split(' '),
);

/** The file type an address ends in when it is not a web page, such as "zip"; null otherwise. */
export function fileTypeOf(url: string): string | null {
  try {
    const type = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    return type && FILE_TYPES.has(type) ? type : null;
  } catch {
    return null;
  }
}

/**
 * The sites to ask for: each host with its subdomains, so a page that moves to or from www. is still read.
 * A host that is an IP address or a single name is asked for by itself.
 */
export function sitePatterns(urls: string[]): string[] {
  const patterns = new Set<string>();
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const bare = host.replace(/^www\./, '');
    const own = /^\d+(?:\.\d+){3}$/.test(host) || host.startsWith('[') || !bare.includes('.');
    patterns.add(own ? `*://${host}/*` : `*://*.${bare}/*`);
  }
  return [...patterns];
}
