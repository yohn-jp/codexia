export function publicReaderOrigin(input: { currentOrigin: string }): string | null {
  const candidate = input.currentOrigin;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return url.origin;
}

export function publicReaderUrl(origin: string, projectId: string, token: string): string {
  return new URL(`/r/publishing/${encodeURIComponent(projectId)}/${encodeURIComponent(token)}`, `${origin}/`).toString();
}
