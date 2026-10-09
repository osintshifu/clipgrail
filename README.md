<div align="center">

![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-1F62C4?style=flat-square)
![Chrome 142+](https://img.shields.io/badge/Chrome-142%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-555555?style=flat-square)
![Local storage](https://img.shields.io/badge/storage-local-00897B?style=flat-square)
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

**Record visited pages. Clip useful content. Keep your sources organized.**

</div>

<br>

<div align="center">

[Features](#features) · [Quick start](#quick-start) · [Record browsing](#record-browsing) · [Research Jobs](#research-jobs) · [Privacy](#privacy) · [User guide](docs/USER_GUIDE.md)

</div>

ClipGrail is a **Chrome web clipper and research workspace**. Capture web content, record the pages you visit, organize sources in a local library, and prepare source-referenced material for further analysis. No account or server required. AI is optional.

### Features

| Feature | What it does |
| --- | --- |
| **Browsing session recording** | Automatically save visited page URLs, titles, and available navigation context. |
| **Web clipping** | Save readable page text, selected passages, links, or tab addresses. |
| **Page code** | Record the trackers in a clipped page (Google Analytics, Google tag, Tag Manager, Meta Pixel, AdSense) and what it declares about itself, each with where it was found; search finds the pages that share them. |
| **Pivots** | List the tracker IDs, declared names, email, Bitcoin and Ethereum addresses, IBANs and Telegram links found in several sources, and open the sources each is in. |
| **Text snapshots** | Keep earlier captures, timestamps, extraction details, and SHA-256 hashes, see which captures saved the same text, and compare two of them word by word. |
| **Research library** | Organize sources into sessions; follow a session on its timeline, mark important sources, search saved text, notes and selections, and add notes. |
| **Research Jobs** | Combine a prompt with selected sources referenced as `[S1]`, `[S2]`, and so on. |
| **Export and backup** | Copy jobs, export Markdown or JSON, and back up or restore local research data. |

### Quick start

**Requirements:** Chrome 142+ and Node.js 24.15+ or 22.22+.

```bash
git clone https://github.com/osintshifu/clipgrail.git
cd clipgrail
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `.output/chrome-mv3`.
3. Click the ClipGrail toolbar icon to open ClipGrail in a popup. To keep it open beside the page, choose **··· > Toolbar button opens > Side panel**.

ClipGrail is not currently available in the Chrome Web Store.

### Record browsing

Click **Record** in ClipGrail, browse normally in that Chrome window, then click **Stop**. New pages are added to the active research session with their URL, title, how you reached them and, where Chrome can determine it, the page they were opened from. The extension shows **REC** while recording. After **Stop**, ClipGrail lists the recorded pages so you can remove the ones you do not need and mark the important ones.

**Recording saves page addresses, not page content.** To preserve readable text, clip the pages you need. A page the session already has is not saved again, unless it has the page only as a link saved without opening it; returning to a page after 30 minutes or more is noted as a visit. Addresses with a recognised sign-in or access token, such as a password-reset link, are not recorded. Sites you list under **··· › Sites not recorded**, such as your mail or bank, are skipped with their subdomains.

### Clip and organize

| Action | Saved material |
| --- | --- |
| **Clip page** (`Alt+Shift+K`) | Readable article or visible page text, plus capture details and the page code. |
| **Clip selection** | Selected text linked to its source, plus the page code. |
| **Save link** | URL without opening or downloading the destination. |
| **Save tabs** | URLs and titles of selected or current-window tabs. |

ClipGrail extracts readable text with Mozilla Readability, retains earlier versions, and marks incomplete or failed captures. The **Library** opens in a browser tab, with sessions, source notes, and saved text snapshots. Search covers saved text, notes, selections, titles, URLs, and labels; `site:`, `after:`, and `before:` narrow the results. A session's **Timeline** shows its captures and recorded visits in time order, each source lists the sources it led to, and a star marks the important ones. **Pivots** lists the values that several sources share, such as a tracker ID, an email address or a crypto address, with the sources each is in. The **Deletion log** says what each label no longer in use was: a deleted source keeps its title and address there, so a missing S4 can be explained.

### Research Jobs

Select sources, write a task or use an editable preset (**Analyze**, **Compare**, **Fact Check**, **Custom**), and choose **Links only**, **Selections**, or **Full text**. ClipGrail generates one document with:

- Your **task** and source-handling rules.
- Selected **source material**, labelled `[S1]`, `[S2]`, etc.
- Clear indicators for missing, partial, or shortened content.

Copy the job, export it as **Markdown** or **JSON**, or open ChatGPT, Claude, Gemini, or Perplexity with the job on your clipboard. **You paste and submit it yourself.** ClipGrail does not send prompts to AI services.

### Privacy

- **Local by default:** research data stays in your Chrome profile. No ClipGrail account, backend, telemetry, or cloud sync.
- **Controlled access:** page text is read after a direct action on that tab. Saving tabs and recording request additional browser permissions.
- **Your data:** export a JSON backup regularly. Uninstalling the extension removes locally stored research data; restoring a backup replaces existing data.
- **Privacy policy:** [PRIVACY.md](PRIVACY.md).

### Limits

Chrome `http`/`https` pages only, not in Incognito windows; no PDF, image, or video extraction and no OCR. Captured text is limited to 1,000,000 characters per snapshot or selection. Page recordings do not create full-page archives or video recordings.

### Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run zip
```

Built with TypeScript, WXT, and Mozilla Readability. See the [user guide](docs/USER_GUIDE.md) for permissions, capture behavior, backup limits, and troubleshooting. Report bugs or request features in [Issues](https://github.com/osintshifu/clipgrail/issues).

### License

[MIT](LICENSE). Third-party licenses are listed in [`public/licenses`](public/licenses).
