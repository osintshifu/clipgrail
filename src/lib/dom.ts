// DOM helpers for ClipGrail pages. Page content is only ever inserted as text.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; attrs?: Record<string, string>; on?: Partial<Record<string, (event: Event) => void>> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(k, fn);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** Replaces the children of `el`, skipping empty entries. */
export function fill(el: HTMLElement, children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}
