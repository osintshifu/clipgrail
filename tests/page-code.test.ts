// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanPageCode, readPageCode } from '../src/lib/page-code';

const HEAD = `
<meta property="og:site_name" content="Harbour Authority">
<meta name="og:type" content="article">
<meta property="article:published_time" content="2026-10-09T09:12:00+02:00">
<meta name="author" content="Anna   Nowak">
<meta name="twitter:site" content="@harbourauth"><meta name="twitter:creator" content="@anna">
<meta name="generator" content="WordPress 6.6.2">
<link rel="canonical" href="https://port.example.org/notices/41">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","@id":"#org","name":"Harbour Authority Ltd"},
  {"@type":["NewsArticle"],"headline":"Night closures","author":[{"@type":"Person","name":"Anna Nowak"}],"publisher":{"@id":"#org"},"datePublished":"2026-10-09T09:12:00+02:00"},
  {"@type":"BreadcrumbList","name":"Home"}]}</script>
<script type="application/ld+json">{ broken</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-7QX2KF31PL"></script>
<script>gtag('config', 'G-7QX2KF31PL'); ga('create', 'UA-1234567-1'); var sections = 'G-SECTIONS', year = 'G-20262027';</script>
<script>(function(w,l,i){})(window,'dataLayer','GTM-5JX9ZQ');</script>
<script>fbq('init', '284019573316622'); var order = '123456789012345';</script>
<script type="text/template">GTM-ZZZZ99</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4920117736251184"></script>`;
const BODY = `
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-5JX9ZQ"></iframe></noscript>
<p>Our old tag was GTM-ABCD1 and UA-9999999-9.</p>
<ins class="adsbygoogle" data-ad-client="ca-pub-4920117736251184"></ins>
<img src="https://www.facebook.com/tr?id=284019573316622&ev=PageView" alt="">`;

describe('page code', () => {
  it('reads trackers from the code with where each was found, and what the page declares with the tags it came from', () => {
    const doc = new DOMParser().parseFromString(`<!doctype html><html><head>${HEAD}</head><body>${BODY}</body></html>`, 'text/html');
    const code = readPageCode(doc);
    // Words that only look like IDs, IDs in the visible text and in templates, and a bare number are not trackers.
    expect(code.trackers).toEqual([
      { kind: 'ga4', id: 'G-7QX2KF31PL', where: ['script_address', 'inline_script'] },
      { kind: 'ua', id: 'UA-1234567-1', where: ['inline_script'] },
      { kind: 'gtm', id: 'GTM-5JX9ZQ', where: ['inline_script', 'noscript'] },
      { kind: 'meta_pixel', id: '284019573316622', where: ['inline_script', 'image'] },
      { kind: 'adsense', id: 'ca-pub-4920117736251184', where: ['script_address', 'ad_tag'] },
    ]);
    // A value declared twice keeps both tags; schema.org names given by reference are followed; the site around the article is not read.
    expect(code.declared).toEqual([
      { field: 'site_name', value: 'Harbour Authority', from: ['og:site_name'] },
      { field: 'author', value: 'Anna Nowak', from: ['meta author', 'schema.org author'] },
      { field: 'published', value: '2026-10-09T09:12:00+02:00', from: ['article:published_time', 'schema.org datePublished'] },
      { field: 'type', value: 'article', from: ['og:type'] },
      { field: 'x_account', value: '@harbourauth', from: ['twitter:site'] },
      { field: 'x_account', value: '@anna', from: ['twitter:creator'] },
      { field: 'generator', value: 'WordPress 6.6.2', from: ['meta generator'] },
      { field: 'canonical', value: 'https://port.example.org/notices/41', from: ['link rel=canonical'] },
      { field: 'type', value: 'NewsArticle', from: ['schema.org'] },
      { field: 'publisher', value: 'Harbour Authority Ltd', from: ['schema.org publisher'] },
    ]);
    // What is stored is checked again and copied without anything else the page put there.
    expect(cleanPageCode({ ...code, extra: 'x' })).toEqual({ declared: code.declared, trackers: code.trackers, values: code.values });
  });

  it('reads contacts, accounts and payment addresses from the links, the text and the schema.org data of the page, and keeps a limited number', () => {
    // jsdom has no layout, so the text the page shows is its text without scripts here.
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      get(this: HTMLElement) {
        const copy = this.cloneNode(true) as HTMLElement;
        for (const script of Array.from(copy.querySelectorAll('script, style'))) script.remove();
        return copy.textContent;
      },
      configurable: true,
    });
    const read = (body: string) => readPageCode(new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, 'text/html'));
    const code = read(`<header>
      <a href="https://twitter.com/HarbourAuth">X</a> <a href="https://x.com/intent/follow?screen_name=harbourauth">Follow</a>
      <a href="https://twitter.com/HarbourAuth/status/1">Post</a> <a href="https://twitter.com/share?url=https://port.example.org">Share</a>
      <a href="https://t.me/HarbourNews">Telegram</a> <a href="https://www.facebook.com/harbour.authority/">Facebook</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://port.example.org">Share</a> <a href="https://instagram.com/harbour_auth">Instagram</a>
      <a href="https://www.instagram.com/p/C1x2y3z/">Post</a> <a href="https://pl.linkedin.com/company/harbour-authority">LinkedIn</a>
      <a href="https://www.youtube.com/@HarbourTV/videos">YouTube</a> <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Video</a>
      <a href="https://www.tiktok.com/@harbour.auth">TikTok</a> <a href="https://github.com/harbour-desk">GitHub</a>
      <a href="https://github.com/features">Features</a> <a href="https://github.com/harbour-desk/port-app">Code</a>
      <a href="https://discord.gg/Hb7xQ2">Discord</a> <a href="https://old.reddit.com/r/Harbour/">Reddit</a></header>
      <footer>Press: <a href="mailto:Press@Port.example.org?subject=Hello">the press office</a>, sales@port.example.org.
      Call <a href="tel:+48 (22) 555-01-23">+48 22 555 01 23</a> or <a href="tel:112">112</a>. Donate: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</footer>
      <script type="application/ld+json">{"@type":"Organization","email":"mailto:Support@Port.example.org","telephone":"+48-22-555-01-23",
        "sameAs":["https://twitter.com/HarbourAuth","https://www.wikidata.org/wiki/Q42"],"contactPoint":[{"@type":"ContactPoint","email":"sales@port.example.org"}]}</script>`);
    // A post, a share button, a page of the site itself and a short number are not values; one written twice is listed once.
    expect(code.values).toEqual([
      { kind: 'email', value: 'press@port.example.org', where: ['link'] },
      { kind: 'email', value: 'sales@port.example.org', where: ['page_text', 'schema_org'] },
      { kind: 'email', value: 'support@port.example.org', where: ['schema_org'] },
      { kind: 'phone', value: '+48225550123', where: ['link', 'schema_org'] },
      { kind: 'x', value: '@HarbourAuth', where: ['link', 'schema_org'] },
      { kind: 'telegram', value: 't.me/harbournews', where: ['link'] },
      { kind: 'facebook', value: 'facebook.com/harbour.authority', where: ['link'] },
      { kind: 'instagram', value: 'instagram.com/harbour_auth', where: ['link'] },
      { kind: 'linkedin', value: 'linkedin.com/company/harbour-authority', where: ['link'] },
      { kind: 'youtube', value: 'youtube.com/@harbourtv', where: ['link'] },
      { kind: 'tiktok', value: 'tiktok.com/@harbour.auth', where: ['link'] },
      { kind: 'github', value: 'github.com/harbour-desk', where: ['link'] },
      { kind: 'discord', value: 'discord.gg/Hb7xQ2', where: ['link'] },
      { kind: 'reddit', value: 'reddit.com/r/harbour', where: ['link'] },
      { kind: 'bitcoin', value: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', where: ['page_text'] },
    ]);
    expect(cleanPageCode(code)).toEqual({ declared: [], trackers: [], values: code.values });
    // A page with more values than a capture keeps says so.
    const many = read(Array.from({ length: 105 }, (_, i) => `staff${i}@port.example.org`).join(' '));
    expect([many.values?.length, many.values_cut]).toEqual([100, true]);
  });

  it('reads the forms real pages use, leaves out what the page did not declare, and stays quick on a page built to slow it down', () => {
    const read = (head: string, body = '') => readPageCode(new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, 'text/html'));
    // The Google tag ID, the Meta Pixel configuration script, an AMP page.
    expect(read(`<script async src="https://www.googletagmanager.com/gtag/js?id=GT-NFBTKH4"></script>
      <script src="https://connect.facebook.net/signals/config/284019573316622?v=2.9"></script>`).trackers).toEqual([
      { kind: 'google_tag', id: 'GT-NFBTKH4', where: ['script_address'] },
      { kind: 'meta_pixel', id: '284019573316622', where: ['script_address'] },
    ]);
    expect(read('', `<amp-analytics type="gtag"><script type="application/json">{"vars":{"gtag_id":"G-7QX2KF31PL"}}</script></amp-analytics>
      <amp-analytics config="https://www.googletagmanager.com/amp.json?id=GTM-5JX9ZQ"></amp-analytics>
      <amp-pixel src="https://www.facebook.com/tr?id=284019573316622&ev=PageView"></amp-pixel>`).trackers.map((t) => [t.id, t.where])).toEqual([
      ['G-7QX2KF31PL', ['amp_tag']],
      ['GTM-5JX9ZQ', ['amp_tag']],
      ['284019573316622', ['amp_tag']],
    ]);
    // Line breaks inside JSON-LD strings; the article as the main entity of a page; the page and site types left out; an empty canonical link.
    expect(read(`<link rel="canonical" href="">
      <script type="application/ld+json">{"@type":"WebPage","datePublished":"2026-10-01","mainEntity":{"@type":"NewsArticle","headline":"Line one
line two","author":"Anna Nowak"}}</script>
      <script type="application/ld+json">{"@type":"WebSite","publisher":{"@type":"Organization","name":"Harbour Authority Ltd"}}</script>`).declared).toEqual([
      { field: 'published', value: '2026-10-01', from: ['schema.org datePublished'] },
      { field: 'type', value: 'NewsArticle', from: ['schema.org'] },
      { field: 'author', value: 'Anna Nowak', from: ['schema.org author'] },
      { field: 'publisher', value: 'Harbour Authority Ltd', from: ['schema.org publisher'] },
    ]);
    const started = performance.now();
    read(`<script>var x='${'facebook.com/tr?'.repeat(60_000)}';</script>`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses page code that breaks its contract', () => {
    const valid = {
      declared: [{ field: 'author', value: 'Anna', from: ['meta author'] }],
      trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: ['noscript'] }],
      values: [{ kind: 'x', value: '@HarbourAuth', where: ['link'] }],
    };
    const broken: unknown[] = [
      null,
      { declared: valid.declared },
      { ...valid, trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ</script>', where: ['noscript'] }] },
      { ...valid, trackers: [{ kind: 'ga4', id: 'G-SECTIONS', where: ['inline_script'] }] },
      { ...valid, trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: [] }] },
      { ...valid, declared: [{ field: 'author', value: 'Anna', from: ['meta author', 'meta author'] }] },
      { ...valid, declared: [{ field: 'canonical', value: 'javascript:alert(1)', from: ['link rel=canonical'] }] },
      { ...valid, declared: Array.from({ length: 41 }, () => valid.declared[0]) },
      { ...valid, values: [{ kind: 'github', value: 'github.com/features', where: ['link'] }] },
      { ...valid, values: [{ kind: 'email', value: 'Press@Port.example.org', where: ['link'] }] },
      { ...valid, values: [{ kind: 'phone', value: '+48225550123', where: ['footer'] }] },
      { declared: [], trackers: [], values_cut: true },
    ];
    expect(cleanPageCode(valid)).toEqual(valid);
    for (const value of broken) expect(cleanPageCode(value), JSON.stringify(value)).toBeNull();
  });
});
