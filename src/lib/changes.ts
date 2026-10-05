/**
 * Tells the other open ClipGrail pages (side panels in other windows, the
 * library) that research data changed, so they read it again. A page never
 * receives its own announcements.
 */
const CHANNEL_NAME = 'clipgrail-data';
let channel: BroadcastChannel | undefined;

function getChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function announceDataChange(): void {
  getChannel()?.postMessage({ type: 'data-changed' });
}

/** Calls `listener` once a burst of changes made in other pages has settled, for example while someone types a note there. */
export function onDataChange(listener: () => void, delayMs = 300): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  getChannel()?.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type !== 'data-changed') return;
    clearTimeout(timer);
    timer = setTimeout(listener, delayMs);
  });
}
