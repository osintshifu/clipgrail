import type { PageCodeRow, PageCodeView } from './describe';
import { h } from './dom';

/** The page code of a capture in its details: declared values and trackers, each with where it was read, and what it cannot show. */
export function pageCodeBlock(view: PageCodeView, heading?: string): HTMLElement {
  const rows = (list: PageCodeRow[]) =>
    list.length
      ? h(
          'dl',
          { class: 'details' },
          list.flatMap((row) => [
            h('dt', {}, [row.label]),
            h('dd', {}, [h('span', { class: row.mono ? 'mono' : '' }, [row.value]), row.from ? h('span', { class: 'from' }, [` · ${row.from}`]) : null]),
          ]),
        )
      : h('p', { class: 'small' }, ['None found.']);
  const section = (title: string, list: PageCodeRow[]) => [h('span', { class: 'section-title' }, [title]), rows(list)];
  return h('div', { class: 'page-code' }, [
    heading ? h('p', { class: 'small' }, [heading]) : null,
    ...(view.trackers || view.declared.length ? section(view.declaredTitle, view.declared) : []),
    ...(view.trackers ? section('Trackers in the page code', view.trackers) : []),
    h('p', { class: 'small' }, [view.note]),
  ]);
}
