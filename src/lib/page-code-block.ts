import type { PageCodeRow, PageCodeView } from './describe';
import type { CopyReport } from './copy';
import { copyTextButton, copyToClipboard, copyableValue } from './copy';
import { h } from './dom';
import { plural } from './text';

/**
 * The page code of a capture in its details: declared values, trackers and values in the page, each with where it
 * was read and a button that copies it, and what it cannot show. Each section copies whole as one value a line.
 */
export function pageCodeBlock(view: PageCodeView, report: CopyReport, heading?: string): HTMLElement {
  const rows = (list: PageCodeRow[]) =>
    list.length
      ? h(
          'dl',
          { class: 'details' },
          list.flatMap((row) => [
            h('dt', {}, [row.label]),
            copyableValue([h('span', { class: row.mono ? 'mono' : '' }, [row.value]), row.from ? h('span', { class: 'from' }, [` · ${row.from}`]) : null], row.value, report),
          ]),
        )
      : h('p', { class: 'small' }, ['None found.']);
  const section = (title: string, list: PageCodeRow[]) => [
    h('div', { class: 'section-head' }, [
      h('span', { class: 'section-title' }, [title]),
      list.length
        ? copyTextButton('Copy all', () => list.map((row) => `${row.label}: ${row.value}`).join('\n'), () => plural(list.length, 'value'), report, { 'aria-label': `Copy all: ${title}` })
        : null,
    ]),
    rows(list),
  ];
  return h('div', { class: 'page-code' }, [
    heading ? h('p', { class: 'small' }, [heading]) : null,
    ...(view.trackers || view.declared.length ? section(view.declaredTitle, view.declared) : []),
    ...(view.trackers ? section('Trackers in the page code', view.trackers) : []),
    ...(view.values ? section(view.valuesTitle, view.values) : []),
    h('p', { class: 'small' }, [view.note]),
  ]);
}

/**
 * What the page showed when it was clipped, in a box at the top of the library reader: contacts and addresses, what the
 * page declares and its trackers, a row for each kind. Each value is a button that copies it and says on hover where
 * it was read; Copy all copies every value, one a line.
 */
export function foundInPageBlock(view: PageCodeView, report: CopyReport, capture?: string): HTMLElement {
  const groups: Array<[string, PageCodeRow[]]> = [];
  if (view.values) groups.push([view.valuesCut ? `Contacts and addresses: the first ${view.values.length}` : 'Contacts and addresses', view.values]);
  // Without page code, the declared values are what Readability read with the text.
  if (view.trackers || view.declared.length) groups.push([view.trackers ? 'Declared by the page' : 'Read by Readability', view.declared]);
  if (view.trackers) groups.push(['Trackers', view.trackers]);
  const all = groups.flatMap(([, list]) => list);
  const value = (row: PageCodeRow) => {
    const button = h('button', { class: `found-value${row.mono ? ' mono' : ''}`, attrs: { type: 'button', title: `${row.from ? `From ${row.from}. ` : ''}Click to copy.` } }, [row.value]);
    button.addEventListener('click', () => {
      void copyToClipboard(row.value, row.value, report).then((copied) => {
        if (!copied) return;
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 1500);
      });
    });
    return button;
  };
  const group = ([title, list]: [string, PageCodeRow[]]) => {
    const kinds = new Map<string, PageCodeRow[]>();
    for (const row of list) kinds.set(row.label, [...(kinds.get(row.label) ?? []), row]);
    return h('div', { class: 'found-group' }, [
      h('div', { class: 'found-group-title' }, [list.length ? `${title} · ${list.length}` : title]),
      list.length
        ? h('dl', { class: 'found-list' }, [...kinds].flatMap(([label, rows]) => [h('dt', {}, [label]), h('dd', {}, rows.map(value))]))
        : h('p', { class: 'small' }, ['None found.']),
    ]);
  };
  return h('section', { class: 'found', attrs: { 'aria-label': 'Found in the page' } }, [
    h('div', { class: 'found-head' }, [
      h('span', { class: 'section-title' }, ['Found in the page']),
      h('span', { class: 'small' }, [[plural(all.length, 'value'), capture].filter(Boolean).join(' · ')]),
      all.length
        ? copyTextButton('Copy all', () => all.map((row) => `${row.label}: ${row.value}`).join('\n'), () => plural(all.length, 'value'), report, { 'aria-label': 'Copy all values found in the page' })
        : null,
    ]),
    ...(all.length ? groups.map(group) : [h('p', { class: 'small' }, ['Nothing found.'])]),
    h('p', { class: 'small found-note' }, [view.note]),
  ]);
}
