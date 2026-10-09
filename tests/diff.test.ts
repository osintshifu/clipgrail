import { describe, expect, it } from 'vitest';
import type { TextDiff } from '../src/lib/diff';
import { MAX_PARAGRAPH_EDITS, compareTexts } from '../src/lib/diff';

/** The comparison as one text: [-removed-]{+added+}, unchanged paragraphs as they are. */
function marked(diff: TextDiff): string {
  return diff.blocks
    .map((block) =>
      block.kind === 'same'
        ? block.text
        : block.parts.map((part) => ('same' in part ? part.same : `${part.removed ? `[-${part.removed}-]` : ''}${part.added ? `{+${part.added}+}` : ''}`)).join(''),
    )
    .join('\n\n');
}

const OLDER = [
  'Notice to mariners No. 41. Updated 9 October 2026, 09:12.',
  'Berths 4 to 7 are closed. Vessels will be moved to the outer roads by the harbour pilots.',
  'Delays of two to three days are expected.',
  'Tug assistance remains mandatory.',
  'Questions: VHF channel 12.',
];
const NEWER = [
  'Notice to mariners No. 41. Updated 9 October 2026, 11:40.',
  'Berths 4 to 8 are closed. Vessels will be moved to the outer roads.',
  'Delays of three to five days are expected.',
  'Tug assistance remains mandatory.',
  'From 12 October pilots board at the outer buoy only.',
  'Questions: VHF channel 12.',
];

describe('text comparison', () => {
  it('keeps unchanged paragraphs and marks each changed place word by word, with times and numbers whole', () => {
    const diff = compareTexts(OLDER.join('\n\n'), NEWER.join('\n\n'))!;
    expect(marked(diff)).toBe(
      [
        'Notice to mariners No. 41. Updated 9 October 2026, [-09:12-]{+11:40+}.',
        'Berths 4 to [-7-]{+8+} are closed. Vessels will be moved to the outer roads[- by the harbour pilots-].',
        'Delays of [-two-]{+three+} to [-three-]{+five+} days are expected.',
        'Tug assistance remains mandatory.',
        '{+From 12 October pilots board at the outer buoy only.+}',
        'Questions: VHF channel 12.',
      ].join('\n\n'),
    );
    // Neighbouring changed paragraphs form one block; unchanged ones stay apart, so they can be folded.
    expect(diff.blocks.map((b) => b.kind)).toEqual(['changed', 'same', 'changed', 'same']);
    expect([diff.changes, diff.added, diff.removed]).toEqual([6, 5 + 1 + 5 + 4 + 52, 5 + 1 + 22 + 3 + 5]);
  });

  it('joins changes split only by spaces, not by a line break, and keeps characters of scripts without spaces and whole emoji apart', () => {
    const marks = (older: string, newer: string) => marked(compareTexts(older, newer)!);
    expect(marks('a red apple here', 'a green pear here')).toBe('a [-red apple-]{+green pear+} here');
    expect(marks('Updated 09:12\nBerths closed', 'Updated 11:40\nPiers closed')).toBe('Updated [-09:12-]{+11:40+}\n[-Berths-]{+Piers+} closed');
    expect(marks('2024年去了北京', '2024年去了上海')).toBe('2024年去了[-北京-]{+上海+}');
    expect(marks('ข้อความ ก่อน', 'ข้อความ ก้อน')).toBe('ข้อความ [-ก่-]{+ก้+}อน');
    expect(marks('Flag 🇵🇱 here', 'Flag 🇵🇹 here')).toBe('Flag [-🇵🇱-]{+🇵🇹+} here');
  });

  it('gives up on texts that differ in too many paragraphs, and shows a changed paragraph too long to compare word by word as removed and added', () => {
    const paragraphs = Array.from({ length: MAX_PARAGRAPH_EDITS }, (_, i) => `Paragraph ${i}.`);
    expect(compareTexts(paragraphs.join('\n\n'), paragraphs.map((p) => `${p} Changed.`).join('\n\n'))).toBeNull();

    const long = Array.from({ length: 30_000 }, (_, i) => `w${i % 97}`).join(' ');
    const other = Array.from({ length: 30_000 }, (_, i) => `w${(i * 7) % 89}`).join(' ');
    const diff = compareTexts(`Intro.\n\n${long}`, `Intro.\n\n${other}`)!;
    expect(diff.blocks).toEqual([{ kind: 'same', text: 'Intro.' }, { kind: 'changed', parts: [{ removed: long, added: other }] }]);
    expect(diff.changes).toBe(1);
  });

  it('gives back both texts exactly from what it marks', () => {
    // A fixed pseudo-random sequence, so a failure can be repeated.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const words = ['alpha', 'beta', '09:12', '4,000', '.', ',', 'Żółw', '中', '文', 'e-mail'];
    const paragraph = () => Array.from({ length: 1 + Math.floor(random() * 8) }, () => words[Math.floor(random() * words.length)]).join(random() < 0.2 ? '\n' : ' ');
    const text = () => Array.from({ length: 1 + Math.floor(random() * 6) }, paragraph).join('\n\n');
    for (let run = 0; run < 2000; run++) {
      const older = text();
      const newer = random() < 0.5 ? text() : older.split('\n\n').map((p) => (random() < 0.3 ? paragraph() : p)).join('\n\n');
      const diff = compareTexts(older, newer)!;
      const sides = diff.blocks.map((block) => {
        if (block.kind === 'same') return [block.text, block.text];
        return block.parts.reduce(([a, b], part) => ('same' in part ? [a + part.same, b + part.same] : [a + part.removed, b + part.added]), ['', '']);
      });
      expect(sides.map(([a]) => a).filter(Boolean).join('\n\n')).toBe(older);
      expect(sides.map(([, b]) => b).filter(Boolean).join('\n\n')).toBe(newer);
    }
  });
});
