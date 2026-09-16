import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createDesktopUninstallScript } from './desktopUninstall.mjs';

export async function prepareDesktopInstallerResources(root, destination) {
  await mkdir(destination);
  await writeFile(join(destination, 'installer.nsh'), await readFile(join(root, 'apps/desktop/packaging/installer.nsh')), { flag: 'wx' });
}

/** Called by builder after the actual Electron runtime has been assembled, before NSIS compilation. */
export async function writeDesktopUninstallFiles(root, appOutDir, resources) {
  const local = relative(root, appOutDir);
  if (isAbsolute(local) || local === '' || local === '..' || local.startsWith('..' + sep)) throw new Error('Installer output must remain in the project');
  let cursor = root;
  for (const part of local.split(sep)) {
    cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Installer output contains a link');
  }
  const names = []; let visited = 0;
  const walk = async (directory, depth) => {
    if (depth > 32) throw new Error('Installer output folders are too deep');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 40_000 || entry.isSymbolicLink()) throw new Error('Invalid installer output');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) names.push(relative(appOutDir, path).split(sep).join('/'));
      else throw new Error('Installer output contains a special file');
    }
  };
  await walk(appOutDir, 0);
  await writeFile(join(resources, 'uninstall-files.nsh'), createDesktopUninstallScript(names), { flag: 'wx' });
}
