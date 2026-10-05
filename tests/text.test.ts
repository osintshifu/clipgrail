// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { countCharacters, elementToText, normalizeText, truncateToCharacters } from '../src/lib/text';

describe('elementToText', () => {
  it('keeps paragraphs, list structure, table cells and preformatted text', () => {
    const div = document.createElement('div');
    div.innerHTML = `
      <h2>Heading</h2><p>First   paragraph with <b>bold</b> text.</p><p>Second<br>line</p>
      <ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
      <ol start="3"><li>Three</li><li>Four</li></ol>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <pre>  code
    indented</pre><script>alert(1)</script>`;
    expect(elementToText(div)).toBe(
      [
        'Heading',
        '',
        'First paragraph with bold text.',
        '',
        'Second',
        'line',
        '',
        '- One',
        '- Two',
        '  - Nested',
        '',
        '3. Three',
        '4. Four',
        '',
        'A | B',
        '1 | 2',
        '',
        '  code',
        '    indented',
      ].join('\n'),
    );
  });
});

describe('character counting and truncation', () => {
  it('counts code points and never splits a surrogate pair when truncating', () => {
    const text = 'ab😀cd';
    expect(text.length).toBe(6);
    expect(countCharacters(text)).toBe(5);
    expect(truncateToCharacters(text, 3)).toEqual({ text: 'ab😀', truncated: true, originalCharacterCount: 5 });
    expect(truncateToCharacters(text, 5)).toEqual({ text, truncated: false, originalCharacterCount: 5 });
  });

  it('normalizes line endings, trailing spaces, blank runs and lone surrogates', () => {
    expect(normalizeText('  a \r\nb\t\r\n\n\n\nc\uD800 ')).toBe('a\nb\n\nc�');
  });
});
