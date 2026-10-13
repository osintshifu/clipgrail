<div align="center">

![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-1F62C4?style=flat-square)
![Chrome 142+](https://img.shields.io/badge/Chrome-142%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-555555?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-BC4C00?style=flat-square)](LICENSE)

</div>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
  <img src="docs/images/logo-light.svg" alt="ClipGrail logomark" width="140">
</picture>
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.svg">
  <img src="docs/images/wordmark-light.svg" alt="ClipGrail" width="160">
</picture>

**Web clipping and browsing-session recording for Chrome.**

Save pages, selections, links and tabs. Keep everything organized for later.

</div>

<br>

<div align="center">

[Quick start](#quick-start) · [Features](#features) · [Capture](#capture) · [Recording](#record-browsing) · [Library](#library) · [Research Jobs](#research-jobs) · [Privacy](#privacy-and-data)

</div>

---

ClipGrail is a **Chrome extension for capturing web content and keeping track of your research**. Clip an article, save a passage or a link, or record the pages you visit. Find everything later in a searchable library, including earlier captures of the same page.

No account, server or API key required. The AI chat features are optional.

## Quick start

**Requirements:** Chrome 142+ and Node.js 24.15+ or 22.22+.

```bash
git clone https://github.com/osintshifu/clipgrail.git
cd clipgrail
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `.output/chrome-mv3`.
3. Click the ClipGrail toolbar icon to start clipping.

ClipGrail opens as a popup by default. To keep it next to the page, choose **··· > Toolbar button opens > Side panel**. It is not currently available in the Chrome Web Store.

## Features

| Feature | What it does |
| --- | --- |
| **Page clipping** | Save readable article or page text, selected passages, links and tab URLs. |
| **Session recording** | Log visited pages, their titles and how you reached them while browsing. |
| **Library** | Keep sources in sessions, add notes, mark important pages and search saved content. |
| **Page details** | Extract declared site information, tracker IDs, contacts, social profiles and payment addresses from clipped pages. |
| **Pivots** | Find identifiers that appear across multiple saved pages and jump to their sources. |
| **Capture history** | Keep text snapshots, timestamps and SHA-256 hashes; compare saved versions of a page. |
| **Research Jobs** | Combine a task with selected sources, labelled `[S1]`, `[S2]`, etc., for export or use in an AI chat. |
| **Export and backup** | Export Markdown or JSON, copy source links, and back up or restore your library. |

## Capture

| Action | How | Saved |
| --- | --- | --- |
| **Clip page** | **Clip page**, `Alt+Shift+K`, or right-click > **ClipGrail > Clip page** | Readable text, page details and capture information |
| **Clip selection** | Select text, then **Selection** or right-click > **ClipGrail > Clip selection** | Selected text with its page URL |
| **Clip URL** | Right-click a link > **ClipGrail > Clip URL** | Link address without opening the destination |
| **Save tabs** | **Tabs ▾** > current, selected or all tabs in the window | URLs and titles, without reading the pages |
| **Clip saved URLs** | **Clip page** on a saved source, or **Clip N pages** in the Library | Readable text captured later, with permission for those sites |

ClipGrail uses **Mozilla Readability** to extract article text and falls back to visible page text when needed. Clips are saved to the active session (or **Inbox**). Capturing the same URL again adds another snapshot instead of replacing the old one.

A clipped page can also include a picture of its **visible area**. Links and tab URLs are saved without loading their destination; they do not include page text or a picture until clipped.

### Capture status

| Status | Meaning |
| --- | --- |
| **Text saved** | Readable text was captured. |
| **Partial text** | Text was cut at the 1,000,000-character limit. |
| **Selections only** | Only selected passages were saved. |
| **URL only** | The address was saved, but the page was not read. |
| **Capture failed** | No readable text could be saved. |

A failed capture does not remove earlier successful text.

## Record browsing

Click **Record**, browse in that Chrome window, then click **Stop**. ClipGrail saves visited **URLs, titles and available navigation context**, including the page that led to another page. The toolbar shows **REC** while recording.

**Recording saves addresses, not page content.** After stopping, review the pages, remove unwanted entries, mark important ones or clip selected pages to save their text. You can also start and stop recording from the right-click menu.

- **Timeline** shows visits and captures in date order. A return visit after at least 30 minutes can appear as **Visited again**.
- **··· > Sites not recorded** excludes specified domains and their subdomains from recording. Manually clipping those sites still works.
- Recording works in **one Chrome window at a time** and stops when that window closes.
- ClipGrail skips URLs containing certain recognized access-token parameters, but this does not catch every sensitive URL. Exclude private sites explicitly.

## Library

Open **Library** to work with all saved sources in a browser tab. You can:

- Create sessions, move sources, add notes and mark important pages.
- Search titles, URLs, notes, selections, saved text, earlier captures and page details.
- Filter by status, browse the **Timeline** or show **Important** sources from all sessions.
- Open several saved pages at once or select multiple sources for clipping.
- View earlier text snapshots and use **Compare with…** to see additions and removals.
- Check the **Deletion log** to understand missing source labels after moving or removing items.

Search supports quoted phrases and filters such as `site:example.org`, `after:2026-10-01` and `before:2026-10-31`. Each session labels its sources **S1**, **S2**, **S3**, etc.; labels are not reused.

### Page details and Pivots

Clipping a page also collects identifiers available in its code, links and text:

| Type | Examples |
| --- | --- |
| **Page information** | Site name, author, publisher, publication date, canonical URL, generator |
| **Trackers** | Google Analytics, Google tag, Tag Manager, Meta Pixel, AdSense IDs |
| **Contacts and accounts** | Email addresses, phone numbers, links to social profiles |
| **Payment addresses** | Bitcoin, Ethereum and IBAN identifiers |

**Found in the page** shows extracted values and where they were found. **Pivots** groups matching values across sources, with **Shared only** for identifiers seen in more than one source. Click a value to see the pages containing it, or copy the results as a tab-separated list.

A shared tracker or contact is **a lead, not proof of shared ownership**. ClipGrail does not visit linked profiles or run external lookups.

### Text snapshots

Each capture keeps its time, extraction method and **SHA-256 of the saved text**. The Library identifies identical snapshots and lets you compare different ones word by word. A hash can confirm that stored text is identical; it does not verify the page's author or authenticity.

## Research Jobs

Use **Create job** to prepare a prompt and a set of saved sources:

1. Write a task or choose **Analyze**, **Compare**, **Fact Check** or **Custom**.
2. Pick **Links only**, **Selections** or **Full text**.
3. Select sources, adjust the text limit or optional details, and click **Generate job**.
4. **Copy Markdown**, export **Markdown/JSON**, or open **ChatGPT, Claude, Gemini or Perplexity**.

Each source is labelled `[S1]`, `[S2]`, etc. The job marks missing, failed or shortened captures instead of hiding them. Notes, capture times, referring pages and original URLs are included only when selected.

**Opening an AI chat copies the job and opens the service. You paste and submit it yourself.** ClipGrail does not automatically send anything to an AI provider. Right-click **ClipGrail > Open in** also works directly on a page or selection.

## Privacy and data

- Research data stays in your **Chrome profile**. No ClipGrail account, backend, telemetry or cloud sync.
- Page text is read after you act on that tab, or after you approve site access to clip a saved URL. Recording collects addresses and navigation context, **not page text**.
- Chrome requests optional permissions when needed for tab URLs, recording, background clipping or clipboard actions. You can withdraw tab and site access from **···**.
- **··· > Back up all data (JSON)** saves your library. **Restore from backup** replaces existing data; it does not merge collections. Backups have a **200 MB** limit.
- Backups do **not** include visible-page pictures or the **Sites not recorded** list. Uninstalling the extension deletes locally stored research data.

See [PRIVACY.md](PRIVACY.md) for details.

## Limits

- Chrome `http`/`https` pages only; no Incognito, PDF extraction, image or video extraction, or OCR.
- Page text and selections are limited to **1,000,000 characters**; extraction times out after **30 seconds**.
- Recording is a list of visited pages, **not** a screen recording or full-page archive. Some navigation inside single-page apps may not register as a new visit.
- ClipGrail is not a crawler. It does not follow links automatically, run remote searches or submit prompts to AI services.
- Text snapshots record extracted content, not a verified copy of everything a website displayed.

## Development

Built with **TypeScript**, [WXT](https://wxt.dev/) and [Mozilla Readability](https://github.com/mozilla/readability).

```bash
npm run dev
npm run build
npm run zip
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm test`. Bugs and requests: [GitHub Issues](https://github.com/osintshifu/clipgrail/issues).

## License

[MIT](LICENSE). Third-party notices: [`public/licenses`](public/licenses). ClipGrail is not affiliated with ChatGPT, Claude, Gemini or Perplexity.
