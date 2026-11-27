export function stripSourceComments(source) {
  const characters = source.split('');
  let state = 'code';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];
    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') state = 'code';
      else characters[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (character !== '\n' && character !== '\r') {
        characters[index] = ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if ((state === 'single' && character === "'") || (state === 'double' && character === '"') ||
          (state === 'template' && character === '`')) state = 'code';
      continue;
    }
    if (character === '/' && next === '/') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      characters[index] = ' ';
      characters[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (character === "'") state = 'single';
    else if (character === '"') state = 'double';
    else if (character === '`') state = 'template';
  }
  return characters.join('');
}
