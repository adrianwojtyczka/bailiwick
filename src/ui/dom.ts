/** Small helpers for building the interface without a framework. */

type Attributes = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/**
 * Creates an element with attributes and children.
 *
 * The HUD is a handful of panels over a canvas; a framework would add bundle
 * weight and a layer of indirection for no benefit at this size.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') {
      node.className = String(value);
    } else if (name === 'text') {
      node.textContent = String(value);
    } else {
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }

  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.firstChild.remove();
}

/** A button that calls `onClick` and never submits or scrolls the page. */
export function button(
  label: string,
  className: string,
  onClick: () => void,
  attributes: Attributes = {},
): HTMLButtonElement {
  const node = el('button', { class: className, type: 'button', ...attributes }, label);
  node.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}
