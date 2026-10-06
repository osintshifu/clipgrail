import { browser } from 'wxt/browser';

/**
 * The favicon Chrome has cached for a page (the "favicon" permission). It
 * comes from Chrome's own cache, never from the network; a page Chrome has
 * no icon for gets Chrome's default globe.
 */
export function faviconUrl(pageUrl: string, size = 32): string {
  const params = new URLSearchParams({ pageUrl, size: String(size) });
  return `chrome-extension://${browser.runtime.id}/_favicon/?${params.toString()}`;
}

/** Mean brightness (0-255) of an icon's visible pixels, or null when it cannot be read. */
function brightness(img: HTMLImageElement): number | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(img, 0, 0, 16, 16);
  const { data } = context.getImageData(0, 0, 16, 16);
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]! / 255;
    sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * alpha;
    weight += alpha;
  }
  return weight ? sum / weight : null;
}

/** A source's favicon on a small tile; a dark icon gets a light tile so it stays visible in the dark theme. */
export function faviconTile(pageUrl: string): HTMLSpanElement {
  const tile = document.createElement('span');
  tile.className = 'fav';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('load', () => {
    const value = brightness(img);
    tile.classList.toggle('fav-dark', value !== null && value < 70);
  });
  img.src = faviconUrl(pageUrl);
  tile.append(img);
  return tile;
}
