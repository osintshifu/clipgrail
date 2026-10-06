import { browser } from 'wxt/browser';

/** Width and height of a stored thumbnail: the top of the visible page, 16:10. */
const WIDTH = 800;
const HEIGHT = 500;

/**
 * A small JPEG of what the window's active tab shows, as a data URL, or null
 * when Chrome does not allow it. Uses the activeTab access that the capture
 * itself needs, so it asks for nothing more.
 */
export async function captureThumbnail(windowId: number | undefined): Promise<string | null> {
  if (windowId === undefined) return null;
  try {
    const shot = await browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
    const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const context = canvas.getContext('2d');
    if (!context) return null;
    // Scale to the thumbnail width and keep the top of the page.
    const scale = WIDTH / bitmap.width;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(bitmap, 0, 0, WIDTH, bitmap.height * scale);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
