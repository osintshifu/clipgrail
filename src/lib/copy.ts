import type { Child } from './dom';
import { h } from './dom';
import { icon } from './icons';

/** How a page says what was copied, or why it was not. */
export type CopyReport = (copied: boolean, what: string, error?: unknown) => void;

/** Puts `text` on the clipboard and reports it; true once copied. */
export async function copyToClipboard(text: string, what: string, report: CopyReport): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    report(false, what, error);
    return false;
  }
  report(true, what);
  return true;
}

/** An icon button that copies `text`; it shows a check for a moment once copied. */
export function copyButton(text: string, what: string, report: CopyReport, className = 'copy-value'): HTMLButtonElement {
  const button = h('button', { class: className, attrs: { type: 'button', title: 'Copy', 'aria-label': `Copy ${what}` } }, [icon('copy')]);
  button.addEventListener('click', (event) => {
    // In a row that opens something, copying does not open it.
    event.stopPropagation();
    void copyToClipboard(text, what, report).then((copied) => {
      if (!copied) return;
      button.replaceChildren(icon('check'));
      button.classList.add('copied');
      setTimeout(() => {
        button.replaceChildren(icon('copy'));
        button.classList.remove('copied');
      }, 1500);
    });
  });
  return button;
}

/** A text button that copies `text` and says Copied for a moment. */
export function copyTextButton(label: string, text: () => string, what: () => string, report: CopyReport, attrs: Record<string, string> = {}): HTMLButtonElement {
  const button = h('button', { class: 'link copy-all', attrs: { type: 'button', ...attrs } }, [label]);
  button.addEventListener('click', () => {
    void copyToClipboard(text(), what(), report).then((copied) => {
      if (!copied) return;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = label), 1500);
    });
  });
  return button;
}

/** A value in a details list, with its copy button after the text. */
export function copyableValue(children: Child[], text: string, report: CopyReport, mono = false): HTMLElement {
  return h('dd', { class: `copyable${mono ? ' mono' : ''}` }, [h('span', { class: 'dd-text' }, children), copyButton(text, text, report)]);
}
