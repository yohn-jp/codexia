export function normalizeKnowledgeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja").trim();
}

export function normalizeKnowledgeSurface(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja");
}
