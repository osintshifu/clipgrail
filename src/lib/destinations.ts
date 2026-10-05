import type { ResearchJob } from './research-job';
import { researchJobToJson } from './research-job';

export type DestinationId = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'clipboard' | 'markdown' | 'json';

/**
 * What a destination can do. Capabilities are only set to true when an
 * official, documented mechanism exists. None of the chat services documents
 * a prefill URL parameter (the undocumented `?q=` of ChatGPT and Perplexity
 * submits the prompt immediately), so every chat destination copies the job
 * to the clipboard and opens the site for the user to paste.
 */
export interface DestinationAdapter {
  id: DestinationId;
  name: string;
  kind: 'chat' | 'clipboard' | 'file';
  launch_url: string | null;
  supports_prefill: boolean;
  max_prefill_chars: number | null;
  supports_clipboard: boolean;
  supports_file: boolean;
  fallback: 'clipboard' | 'file' | null;
  file?: { name: string; mime: string };
}

function chat(id: DestinationId, name: string, launch_url: string): DestinationAdapter {
  return {
    id,
    name,
    kind: 'chat',
    launch_url,
    supports_prefill: false,
    max_prefill_chars: null,
    supports_clipboard: true,
    supports_file: false,
    fallback: 'clipboard',
  };
}

export const MARKDOWN_EXPORT_FILENAME = 'clipgrail-session.md';
export const JSON_EXPORT_FILENAME = 'clipgrail-session.json';

export const DESTINATIONS: Record<DestinationId, DestinationAdapter> = {
  chatgpt: chat('chatgpt', 'ChatGPT', 'https://chatgpt.com/'),
  claude: chat('claude', 'Claude', 'https://claude.ai/new'),
  gemini: chat('gemini', 'Gemini', 'https://gemini.google.com/app'),
  perplexity: chat('perplexity', 'Perplexity', 'https://www.perplexity.ai/'),
  clipboard: {
    id: 'clipboard',
    name: 'Clipboard',
    kind: 'clipboard',
    launch_url: null,
    supports_prefill: false,
    max_prefill_chars: null,
    supports_clipboard: true,
    supports_file: false,
    fallback: 'file',
  },
  markdown: {
    id: 'markdown',
    name: 'Markdown',
    kind: 'file',
    launch_url: null,
    supports_prefill: false,
    max_prefill_chars: null,
    supports_clipboard: false,
    supports_file: true,
    fallback: null,
    file: { name: MARKDOWN_EXPORT_FILENAME, mime: 'text/markdown;charset=utf-8' },
  },
  json: {
    id: 'json',
    name: 'JSON',
    kind: 'file',
    launch_url: null,
    supports_prefill: false,
    max_prefill_chars: null,
    supports_clipboard: false,
    supports_file: true,
    fallback: null,
    file: { name: JSON_EXPORT_FILENAME, mime: 'application/json;charset=utf-8' },
  },
};

/** Side effects a delivery needs, injected so the logic stays testable. */
export interface DeliveryEnvironment {
  copyText(text: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  saveFile(name: string, mime: string, content: string): Promise<void>;
}

export type DeliveryResult = { ok: true; message: string } | { ok: false; message: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Delivers exactly `job` (never a rebuilt version) to the destination. */
export async function deliverJob(
  id: DestinationId,
  job: ResearchJob,
  env: DeliveryEnvironment,
): Promise<DeliveryResult> {
  const adapter = DESTINATIONS[id];
  if (adapter.kind === 'file' && adapter.file) {
    const content = id === 'json' ? researchJobToJson(job) : job.text;
    try {
      await env.saveFile(adapter.file.name, adapter.file.mime, content);
      return { ok: true, message: `Export started: ${adapter.file.name}` };
    } catch (error) {
      return { ok: false, message: `Export failed: ${reason(error)}` };
    }
  }

  try {
    await env.copyText(job.text);
  } catch (error) {
    return {
      ok: false,
      message:
        adapter.kind === 'chat'
          ? `Could not copy to the clipboard (${reason(error)}), so ${adapter.name} was not opened. Select the text in the preview or use Export Markdown.`
          : `Could not copy to the clipboard (${reason(error)}). Select the text in the preview or use Export Markdown.`,
    };
  }
  if (adapter.kind === 'clipboard' || !adapter.launch_url) return { ok: true, message: 'Research Job copied.' };

  try {
    await env.openUrl(adapter.launch_url);
  } catch (error) {
    return { ok: false, message: `Research Job copied, but ${adapter.name} could not be opened: ${reason(error)}` };
  }
  return { ok: true, message: 'Research Job copied. Paste it into the chat.' };
}
