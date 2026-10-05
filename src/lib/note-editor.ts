import { h } from './dom';

interface NoteOptions {
  id: string;
  key: string;
  label: string;
  value: string;
  hint: string;
  read: () => Promise<string | undefined>;
  write: (value: string) => Promise<unknown>;
  onEdit?: (value: string) => void;
}

interface Editor {
  options: NoteOptions;
  box: HTMLElement;
  input: HTMLTextAreaElement;
  status: HTMLElement;
  warning: HTMLElement;
  pending: Set<Promise<void>>;
  error: string | null;
  revision: number;
}

// Retain failed drafts and in-flight writes when a reader is rebuilt.
const editors = new Map<string, Editor>();

function saved(editor: Editor, value: string | undefined): void {
  if (value === undefined) {
    editor.warning.textContent = 'Note unavailable. Copy your text before leaving.';
    editor.warning.hidden = false;
    editor.status.textContent = 'Unavailable';
    editor.error = 'This source or capture no longer exists.';
    return;
  }
  if (editor.error || editor.pending.size) return;
  if (document.activeElement === editor.input && editor.input.value !== value) {
    editor.status.textContent = 'Changed elsewhere';
    editor.warning.textContent = 'Changed elsewhere. Next edit replaces the saved note.';
    editor.warning.hidden = false;
  } else {
    editor.input.value = value;
    editor.warning.hidden = true;
    editor.status.textContent = 'Saved';
  }
}

/** Immediate writes, last committed write wins; external refreshes never overwrite a focused draft. */
export function noteEditor(options: NoteOptions): HTMLElement {
  const previous = editors.get(options.key);
  if (previous) {
    previous.options = options;
    saved(previous, options.value);
    return previous.box;
  }
  const status = h('span', { class: 'small note-status', attrs: { role: 'status' } }, ['Saved']);
  const input = h('textarea', { attrs: { id: options.id, rows: '2' } });
  input.value = options.value;
  const warning = h('p', { class: 'note-warning', attrs: { role: 'status', hidden: '' } });
  const box = h('div', { class: 'note-editor' }, [
    h('div', { class: 'row between' }, [h('label', { attrs: { for: options.id } }, [options.label]), status]),
    input,
    h('p', { class: 'small' }, [options.hint]),
    warning,
  ]);
  const editor: Editor = { options, box, input, status, warning, pending: new Set(), error: null, revision: 0 };
  editors.set(options.key, editor);
  input.addEventListener('input', () => {
    const value = input.value;
    const revision = ++editor.revision;
    editor.error = null;
    warning.hidden = true;
    status.textContent = 'Saving…';
    // Create the transaction now, rather than queueing it behind a timer.
    const write = editor.options.write(value);
    editor.options.onEdit?.(value);
    const task = write.then(() => {
      if (revision === editor.revision) status.textContent = 'Saved';
    }, (error: unknown) => {
      if (revision !== editor.revision) return;
      editor.error = error instanceof Error ? error.message : String(error);
      status.textContent = 'Not saved';
      warning.textContent = `Not saved: ${editor.error}. Edit to retry.`;
      warning.hidden = false;
    }).finally(() => editor.pending.delete(task));
    editor.pending.add(task);
  });
  input.addEventListener('blur', () => {
    const revision = editor.revision;
    void Promise.all([...editor.pending]).then(async () => {
      if (!input.isConnected || document.activeElement === input || revision !== editor.revision || editor.error) return;
      const value = await editor.options.read();
      if (document.activeElement !== input && revision === editor.revision) saved(editor, value);
    }).catch(() => {
      status.textContent = 'Could not refresh';
    });
  });
  return box;
}

/** Finish this view's note writes before moving a source; a failed note blocks the move. */
export async function finishNoteWrites(): Promise<void> {
  const visible = [...editors.values()].filter((e) => e.box.isConnected);
  await Promise.all(visible.flatMap((e) => [...e.pending]));
  const failed = visible.find((e) => e.error);
  if (failed) throw new Error(`Note not saved: ${failed.error}`);
}

/** Restore focus and selection after moving an existing editor into rebuilt markup. */
export function keepNoteFocus(): () => void {
  const input = document.activeElement;
  if (!(input instanceof HTMLTextAreaElement) || !input.closest('.note-editor')) return () => undefined;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const scroll = input.scrollTop;
  return () => {
    if (!input.isConnected) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, end);
    input.scrollTop = scroll;
  };
}
