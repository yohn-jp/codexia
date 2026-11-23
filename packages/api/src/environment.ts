export function readCodexiaEnvironment(suffix: string): string | undefined {
  return process.env[`CODEXIA_${suffix}`];
}
