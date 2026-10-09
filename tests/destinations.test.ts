import { describe, expect, it, vi } from 'vitest';
import type { DeliveryEnvironment } from '../src/lib/destinations';
import { DESTINATIONS, deliverJob } from '../src/lib/destinations';
import type { ResearchJob } from '../src/lib/research-job';
import { DEFAULT_JOB_SETTINGS } from '../src/lib/research-job';

const job = { text: '# TASK\n\nCheck.\n', id: 'job-1', settings: { ...DEFAULT_JOB_SETTINGS } } as ResearchJob;

function env(overrides: Partial<DeliveryEnvironment> = {}): DeliveryEnvironment & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    copyText: vi.fn(async (text: string) => void calls.push(`copy:${text}`)),
    openUrl: vi.fn(async (url: string) => void calls.push(`open:${url}`)),
    saveFile: vi.fn(async (name: string, _mime: string, content: string) => void calls.push(`save:${name}:${content}`)),
    ...overrides,
  };
}

describe('deliverJob', () => {
  it('copies the exact job before opening a chat site, without prefill', async () => {
    const e = env();
    expect(await deliverJob('claude', job, e)).toEqual({ ok: true, message: 'Job copied. Paste it into the chat.' });
    expect(e.calls).toEqual([`copy:${job.text}`, 'open:https://claude.ai/new']);
    expect(Object.values(DESTINATIONS).some((d) => d.supports_prefill)).toBe(false);
  });

  it('does not open the site or claim success when copying fails', async () => {
    const e = env({ copyText: vi.fn(async () => Promise.reject(new Error('Document is not focused.'))) });
    const result = await deliverJob('chatgpt', job, e);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ChatGPT was not opened');
    expect(e.openUrl).not.toHaveBeenCalled();
  });

  it('exports the same job as Markdown and JSON files', async () => {
    const e = env();
    await deliverJob('markdown', job, e);
    await deliverJob('json', job, e);
    expect(e.calls[0]).toBe(`save:clipgrail-session.md:${job.text}`);
    const json = JSON.parse(e.calls[1]!.slice('save:clipgrail-session.json:'.length));
    expect(json.job.text).toBe(job.text);
  });
});
