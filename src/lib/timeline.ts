/**
 * The timeline of a session and the pages a source led to, built from the
 * data already read for the library and the side panel.
 */
import type { SourceEntry } from './db';
import { fmtNumber, hostOf, navigationWords } from './describe';
import type { Capture, SnapshotMeta } from './model';
import { sourceLabel } from './model';
import { describeFailure } from './selection';
import { normalizeUrl } from './url';

type Entry = SourceEntry<SnapshotMeta>;

/** The sources of a session by address, so a page that is itself a source can be named by its label. */
export function sourcesByAddress(entries: Entry[]): Map<string, Entry> {
  return new Map(entries.map((entry) => [entry.source.dedup_url, entry]));
}

/** A page as its S-label when it is a source of the session, else its host. */
function pageRef(url: string, byAddress: Map<string, Entry>): string {
  const address = normalizeUrl(url);
  const entry = address ? byAddress.get(address) : undefined;
  return entry ? sourceLabel(entry.source) : hostOf(url);
}

/** How a recorded page was reached, with the page it was found on: "Link from S3". Null when it was not recorded. */
export function arrival(capture: Capture, byAddress: Map<string, Entry>): string | null {
  const words = navigationWords(capture.navigation);
  if (!words) return null;
  return capture.found_on ? `${words} from ${pageRef(capture.found_on, byAddress)}` : words;
}

/**
 * The sources of the same session that this source led to: with a capture or
 * a visit found on its page (a link opened while recording, a link saved from
 * it, a selection in a frame on it), ordered by the first of them.
 */
export function ledTo(entry: Entry, entries: Entry[]): Entry[] {
  const first = new Map<Entry, string>();
  for (const other of entries) {
    if (other === entry || other.source.session_id !== entry.source.session_id) continue;
    for (const capture of [...other.captures.map((c) => c.capture), ...other.visits]) {
      if (!capture.found_on || normalizeUrl(capture.found_on) !== entry.source.dedup_url) continue;
      const at = first.get(other);
      if (at === undefined || capture.captured_at < at) first.set(other, capture.captured_at);
    }
  }
  return [...first].sort((a, b) => a[1].localeCompare(b[1])).map(([other]) => other);
}

export interface TimelineEvent {
  entry: Entry;
  capture: Capture;
  /** What happened: "Opened", "Visited again", "Clipped"... */
  verb: string;
  /** The rest of the line: how the page was reached, or what was saved; empty when there is nothing to add. */
  detail: string;
}

function eventOf(entry: Entry, capture: Capture, snapshot: SnapshotMeta | undefined, byAddress: Map<string, Entry>): TimelineEvent {
  const how = arrival(capture, byAddress) ?? '';
  const event = (verb: string, detail: string) => ({ entry, capture, verb, detail });
  switch (capture.kind) {
    case 'tab':
      return capture.navigation ? event('Opened', how) : event('Tab address saved', '');
    case 'visit':
      return event('Visited again', how);
    case 'selection':
      return event('Selection saved', capture.fragment ? `${fmtNumber(capture.fragment.character_count)} characters` : '');
    case 'link':
      return event('Link saved, not opened', capture.found_on ? `found on ${pageRef(capture.found_on, byAddress)}` : '');
    case 'page':
      if (snapshot?.status === 'ok') {
        return event(
          'Clipped',
          snapshot.truncated
            ? `partial text, ${fmtNumber(snapshot.character_count)} of ${fmtNumber(snapshot.original_character_count)} characters`
            : `${fmtNumber(snapshot.character_count)} characters`,
        );
      }
      return event('Clip failed', snapshot?.status === 'failed' ? describeFailure(snapshot) : '');
  }
}

/** Every capture and visit of the sources, oldest first. */
export function timelineEvents(entries: Entry[], byAddress: Map<string, Entry> = sourcesByAddress(entries)): TimelineEvent[] {
  const events = entries.flatMap((entry) => [
    ...entry.captures.map(({ capture, snapshot }) => eventOf(entry, capture, snapshot, byAddress)),
    ...entry.visits.map((visit) => eventOf(entry, visit, undefined, byAddress)),
  ]);
  return events.sort((a, b) => a.capture.captured_at.localeCompare(b.capture.captured_at) || a.capture.id.localeCompare(b.capture.id));
}
