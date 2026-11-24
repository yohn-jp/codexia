const renderable = (children) => children.flat(Infinity)
  .filter((child) => child !== null && child !== undefined && child !== false);

export function replace(node, ...children) {
  node.replaceChildren(...renderable(children));
}

export function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else if (value !== false && value != null) node.setAttribute(name, value);
  }
  node.append(...renderable(children));
  return node;
}

export function button(label, onClick, attributes = {}) {
  return h('button', { type: 'button', onclick: onClick, ...attributes }, label);
}

export function confirmAction(title, body, confirmLabel, onConfirm, onCancel) {
  const dialog = h('dialog', { 'aria-label': title });
  const cancel = button('取消', () => dialog.close(), { autofocus: true });
  dialog.append(h('h2', {}, title), h('p', {}, body), h('div', { class: 'actions' }, cancel,
    button(confirmLabel, () => dialog.close('confirmed'), { class: 'primary' })));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'confirmed') onConfirm();
    else onCancel?.();
    dialog.remove();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
