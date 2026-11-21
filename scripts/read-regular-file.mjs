import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Read a regular file through one descriptor, without following its final symlink. */
export async function readRegularFile(file, { encoding = 'utf8', message = `Expected a regular file: ${file}` } = {}) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) {
      const error = new Error(message);
      error.code = 'ERR_NOT_REGULAR_FILE';
      throw error;
    }
    return await handle.readFile(encoding);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      const notRegularFile = new Error(message);
      notRegularFile.code = 'ERR_NOT_REGULAR_FILE';
      throw notRegularFile;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
