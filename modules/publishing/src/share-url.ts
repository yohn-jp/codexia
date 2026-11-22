export function publicReaderOrigin(input: {
  native: boolean;
  configuredReaderOrigin: string | null;
  currentOrigin: string;
}): string | null {
  const candidate = input.native ? input.configuredReaderOrigin : input.currentOrigin;
  if (!candidate) return null;

  let url: URL;
  try { url = new URL(candidate); }
  catch { return null; }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (input.native && url.protocol !== "https:") return null;
  if (!input.native && !["http:", "https:"].includes(url.protocol)) return null;
  return url.origin;
}

export function publicReaderUrl(origin: string, projectId: string, token: string): string {
  return new URL(
    `/r/publishing/${encodeURIComponent(projectId)}/${encodeURIComponent(token)}`,
    `${origin}/`,
  ).toString();
}
