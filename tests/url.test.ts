import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/lib/url';

describe('normalizeUrl', () => {
  it('removes only documented tracking parameters and keeps meaningful ones in order', () => {
    expect(
      normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=SHARE123&t=42&utm_source=x&fbclid=abc'),
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42');
    expect(normalizeUrl('https://example.com/a?ref=homepage&mc_cid=1&mc_eid=2&mc_custom=3&gclid=9')).toBe(
      'https://example.com/a?ref=homepage&mc_custom=3',
    );
    // `si` is only a tracking parameter on YouTube.
    expect(normalizeUrl('https://example.com/search?si=units')).toBe('https://example.com/search?si=units');
    expect(normalizeUrl('https://example.com/page?utm_medium=email')).toBe('https://example.com/page');
  });

  it('drops anchors and credentials but keeps hash routes, paths and trailing slashes', () => {
    expect(normalizeUrl('https://user:pw@Example.com/docs/#section-2')).toBe('https://example.com/docs/');
    expect(normalizeUrl('https://app.example.com/#/items/7')).toBe('https://app.example.com/#/items/7');
    expect(normalizeUrl('https://example.com/a#:~:text=quote')).toBe('https://example.com/a');
  });

  it('returns null for URLs that cannot be captured', () => {
    expect(normalizeUrl('chrome://settings')).toBeNull();
    expect(normalizeUrl('file:///tmp/a.html')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});
