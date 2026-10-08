import { describe, expect, it } from 'vitest';
import { isFromOwnPage } from '../src/lib/messages';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OWN = `chrome-extension://${ID}/`;

describe('messages', () => {
  it('accepts requests only from ClipGrail pages, not from a script injected into a web page', () => {
    expect(isFromOwnPage({ id: ID, url: `${OWN}sidepanel.html` }, ID, OWN)).toBe(true);
    expect(isFromOwnPage({ id: ID, url: `${OWN}library.html?view=all` }, ID, OWN)).toBe(true);
    expect(isFromOwnPage({ id: ID, url: 'https://news.example.org/story' }, ID, OWN)).toBe(false);
    expect(isFromOwnPage({ id: 'another-extension', url: 'chrome-extension://another-extension/page.html' }, ID, OWN)).toBe(false);
    expect(isFromOwnPage({ id: ID }, ID, OWN)).toBe(false);
  });
});
