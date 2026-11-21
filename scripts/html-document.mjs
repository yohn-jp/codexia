import { parse } from 'parse5';

function textContent(node) {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textContent).join('');
}

// Browser-equivalent parsing of built HTML; never parse tags or attributes with regex.
export function inspectHtml(html) {
  const document = parse(html);
  const scripts = [];
  const stylesheets = [];
  const references = [];
  let title = null;
  let nonce = null;

  function visit(node) {
    if (node.tagName) {
      const attrs = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
      const src = attrs.get('src');
      const href = attrs.get('href');
      if (src) references.push(src);
      if (href) references.push(href);
      if (node.tagName === 'script' && src) scripts.push(src);
      if (node.tagName === 'link' && href &&
          attrs.get('rel')?.split(/\s+/u).some((part) => part.toLowerCase() === 'stylesheet')) {
        stylesheets.push(href);
      }
      if (node.tagName === 'title' && title === null) title = textContent(node);
      if (node.tagName === 'meta' && attrs.get('name')?.toLowerCase() === 'codexia-style-nonce') {
        nonce = attrs.get('content') ?? null;
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  return { title, nonce, scripts, stylesheets, references };
}
