import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  manifest: {
    name: 'ClipGrail',
    description: 'Local web research capture.',
    // The newest API used: sidePanel.onClosed (Chrome 142). sidePanel.close and onOpened need 141, action.openPopup 127.
    minimum_chrome_version: '142',
    permissions: [
      // Read the current tab only after a user action (toolbar icon, shortcut, context menu).
      'activeTab',
      'scripting',
      'sidePanel',
      'contextMenus',
      // Favicons of saved pages, read from Chrome's own cache (no network request).
      'favicon',
      // Settings, presets and the active session (chrome.storage.local); capture notices (chrome.storage.session).
      'storage',
      // Keeps research data in IndexedDB out of quota limits and storage eviction.
      'unlimitedStorage',
    ],
    // Asked for the first time the user saves tabs (tabs) or records (tabs and webNavigation): the addresses and
    // titles of the tabs, and how each page was reached, so a recorded page's "found on" is never guessed.
    optional_permissions: ['tabs', 'webNavigation'],
    // Research data is kept in the regular profile, so ClipGrail stays out of Incognito windows instead of keeping what is done there.
    incognito: 'not_allowed',
    action: { default_title: 'Open ClipGrail' },
    commands: {
      'clip-page': {
        suggested_key: { default: 'Alt+Shift+K' },
        description: 'Clip the current page to ClipGrail',
      },
    },
  },
});
