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
    expect(cleanPageCode({ ...code, extra: 'x' })).toEqual({ declared: code.declared, trackers: code.trackers });
  });

  it('refuses page code that breaks its contract', () => {
    const valid = { declared: [{ field: 'author', value: 'Anna', from: ['meta author'] }], trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: ['noscript'] }] };
    const broken: unknown[] = [
      null,
      { declared: valid.declared },
      { ...valid, trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ</script>', where: ['noscript'] }] },
      { ...valid, trackers: [{ kind: 'ga4', id: 'G-SECTIONS', where: ['inline_script'] }] },
      { ...valid, trackers: [{ kind: 'gtm', id: 'GTM-5JX9ZQ', where: [] }] },
      { ...valid, declared: [{ field: 'author', value: 'Anna', from: ['meta author', 'meta author'] }] },
      { ...valid, declared: [{ field: 'canonical', value: 'javascript:alert(1)', from: ['link rel=canonical'] }] },
      { ...valid, declared: Array.from({ length: 41 }, () => valid.declared[0]) },
    ];
    expect(cleanPageCode(valid)).toEqual(valid);
    for (const value of broken) expect(cleanPageCode(value), JSON.stringify(value)).toBeNull();
  });
});
