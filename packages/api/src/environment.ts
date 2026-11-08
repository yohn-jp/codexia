/** Read the Codexia setting first, then retain the Scriptorium deployment alias. */
export function readCodexiaEnvironment(suffix: string): string | undefined {
  const codexiaValue = process.env[`CODEXIA_${suffix}`];
  return codexiaValue === undefined ? process.env[`SCRIPTORIUM_${suffix}`] : codexiaValue;
}
