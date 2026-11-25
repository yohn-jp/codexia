import { type GlobalStyleRule, globalStyle as vanillaGlobalStyle } from '@vanilla-extract/css';

const documentSelectors = new Set([':root', 'html', 'body', '#root']);

function splitSelectorList(selector: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(selector.slice(start).trim());
  return selectors;
}

function scopeSelector(selector: string): string {
  if (documentSelectors.has(selector) || /^:root(?:\[[^\]]+\])+$/u.test(selector)) return selector;

  const rootDescendant = /^(:root(?:\[[^\]]+\])*)\s+(.+)$/u.exec(selector);
  if (rootDescendant) return `${rootDescendant[1]} :where(#root) :is(${rootDescendant[2]})`;

  if (/^(?:html|body)(?:\b|[#.:]|[>+~]|\[)/u.test(selector)) return selector;
  return `:where(#root) :is(${selector})`;
}

export function scopeGlobalSelector(selector: string): string {
  return splitSelectorList(selector).map(scopeSelector).join(',\n');
}

export function scopedGlobalStyle(selector: string, declarations: GlobalStyleRule): void {
  vanillaGlobalStyle(scopeGlobalSelector(selector), declarations);
}
