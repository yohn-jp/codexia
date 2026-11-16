import { readFile } from 'node:fs/promises';

const channelUrl = 'https://api.github.com/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel';
const originalFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

async function fixtureResponse(file, contentType) {
  if (typeof file !== 'string' || !file.startsWith('/')) throw new Error('Disposable Phase F fixture file path is unavailable');
  return new Response(await readFile(file), { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } });
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url === channelUrl) {
    return fixtureResponse(process.env.CODEXIA_PHASE_F_CHANNEL_FILE, 'application/json');
  }
  if (url === process.env.CODEXIA_PHASE_F_FRONTEND_URL) {
    return fixtureResponse(process.env.CODEXIA_PHASE_F_FRONTEND_IDENTITY_FILE, 'application/json');
  }
  return originalFetch(input, init);
};
