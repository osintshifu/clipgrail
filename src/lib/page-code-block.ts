import type { PageCodeRow, PageCodeView } from './describe';
import type { CopyReport } from './copy';
import { copyTextButton, copyableValue } from './copy';
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
