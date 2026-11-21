import { link, mkdtemp, open, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const noFollow = fsConstants.O_NOFOLLOW ?? 0;

/** Create output without following links, replacing, or truncating an existing path. */
export async function writeFileExclusive(filename, bytes, mode = 0o600) {
  const stageDirectory = await mkdtemp(path.join(path.dirname(filename), '.codexia-output-'));
  const stagePath = path.join(stageDirectory, 'output');
  try {
    const handle = await open(stagePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(stagePath, filename);
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}
