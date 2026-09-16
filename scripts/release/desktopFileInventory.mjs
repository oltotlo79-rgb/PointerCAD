import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';

export const desktopFileHash = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** The desktop OCCT is uncompressed and exceeds Pages' per-file limit. */
export async function collectDesktopFiles(projectRoot, outputFolder) {
  const root = await realpath(projectRoot), folder = resolve(outputFolder), local = relative(root, folder);
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
    throw new Error('Desktop output must remain inside the project');
  }
  let cursor = root;
  for (const part of local.split(sep)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Desktop output contains a link');
  }
  const files = [], folded = new Set();
  let total = 0, visited = 0;
  const walk = async (directory, depth) => {
    if (depth > 32) throw new Error('Desktop folder nesting is excessive');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      if (++visited > 40_000) throw new Error('Desktop output has too many entries');
      const path = resolve(directory, entry.name), name = relative(folder, path).split(sep).join('/');
      offlineAssetUrl(name);
      if (entry.isSymbolicLink()) throw new Error('Desktop file must not be a link: ' + name);
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      const before = await lstat(path);
      if (!entry.isFile() || !before.isFile() || before.isSymbolicLink() || before.size === 0
        || before.size > 134_217_728 || files.length >= 20_000 || folded.has(name.toLowerCase())) {
        throw new Error('Invalid desktop file: ' + name);
      }
      const bytes = await readFile(path), after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('Desktop file changed while reading: ' + name);
      }
      total += bytes.length;
      if (total > 1_073_741_824) throw new Error('Desktop application output exceeds 1 GiB');
      folded.add(name.toLowerCase()); files.push({ path: name, bytes });
    }
  };
  await walk(folder, 0);
  return files;
}

export function desktopOutputHashes(files) {
  return Object.fromEntries(files.map(file => [file.path, desktopFileHash(file.bytes)]));
}
