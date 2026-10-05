import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  manifest: {
    name: 'ClipGrail',
    description: 'Local web research capture.',
    // sidePanel.open() needs Chrome 116.
    minimum_chrome_version: '116',
    permissions: [
      // Read the current tab only after a user action (toolbar icon, shortcut, context menu).
      'activeTab',
      'scripting',
      'sidePanel',
      'contextMenus',
      // Settings, presets and the active session (chrome.storage.local); capture notices (chrome.storage.session).
      'storage',
      // Keeps research data in IndexedDB out of quota limits and storage eviction.
      'unlimitedStorage',
    ],
    action: { default_title: 'Open ClipGrail' },
    commands: {
      'clip-page': {
        suggested_key: { default: 'Alt+Shift+K' },
        description: 'Clip the current page to ClipGrail',
      },
    },
  },
});
