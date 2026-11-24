import { projectAuth } from './owner-auth.mjs';
import { projectConsole } from './owner-console.mjs';
import { projectReader } from './owner-reader.mjs';

/** Derive owner-auth, console, and reader observations from canonical source files. */
export function project(source) {
  const projections = [projectAuth(source), projectConsole(source), projectReader(source)];
  return {
    screens: projections.flatMap(({ screens }) => screens),
    controls: projections.flatMap(({ controls }) => controls),
    transitions: projections.flatMap(({ transitions }) => transitions),
    gaps: projections.flatMap(({ gaps }) => gaps ?? []),
  };
}
