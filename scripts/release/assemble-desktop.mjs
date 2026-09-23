/** Make a fresh app directory; installers are built separately from these exact bytes. */
import { argv, platform } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { captureDesktopBuildSources } from '../vite/webBuildSources.mjs';
import { collectDesktopFiles, desktopFileHash } from './desktopFileInventory.mjs';
import { assembleDesktopDistribution, desktopJson } from './desktopDistribution.mjs';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';
import { verifyCurrentManualEdition } from '../manual/currentManualEdition.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = argv.slice(2);
if (args.length !== 4 || args.some(name => !/^[a-z0-9][a-z0-9-]*$/u.test(name)) || !['win32', 'linux'].includes(platform)) {
  throw new Error('Usage: assemble-desktop.mjs <desktop-output> <manual-output> <pdf-output> <new-output>; all under dist/.');
}
if ((await lstat(join(root, 'dist'))).isSymbolicLink()) throw new Error('Desktop output parent must not be a link');
const directories = args.map(name => join(root, 'dist', name)), groups = [];
for (const path of directories.slice(0, 3)) groups.push(await collectDesktopFiles(root, path));
const build = desktopJson(groups[0].find(file => file.path === 'desktop-build.json')?.bytes);
const current = await captureDesktopBuildSources(root);
if (JSON.stringify(build.inputs) !== JSON.stringify(current)) throw new Error('Desktop source set changed after build');
const manual = desktopJson(groups[1].find(file => file.path === 'manifest.json')?.bytes);
for (const [name, expected] of Object.entries(manual.inputs)) {
  offlineAssetUrl(name);
  let path = root;
  for (const part of name.split('/')) { path = join(path, part); if ((await lstat(path)).isSymbolicLink()) throw new Error('Manual source is a link'); }
  if (desktopFileHash(await readFile(path)) !== expected) throw new Error('Manual source changed: ' + name);
}
const packages = await Promise.all(['package.json', 'apps/desktop/package.json', 'apps/web/package.json'].map(async name => desktopJson(await readFile(join(root, name)))));
if (packages.some(value => value.version !== packages[0].version)) throw new Error('Root, desktop and Web versions differ');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json')), requireRoot = createRequire(join(root, 'package.json'));
const electronVersion = requireDesktop('electron/package.json').version, builderVersion = requireRoot('electron-builder/package.json').version;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const notices = new Map();
for (const name of ['LICENSE', 'NOTICE']) notices.set(name, await readFile(join(root, name)));
await verifyCurrentManualEdition(root, groups[1]);
const assembled = assembleDesktopDistribution(groups[0], groups[1], groups[2], notices,
  { version: packages[0].version, sourceCommit, platform, arch: 'x64', electronVersion, builderVersion });
for (const [index, files] of groups.entries()) for (const file of files) {
  if (desktopFileHash(await readFile(join(directories[index], file.path))) !== desktopFileHash(file.bytes)) throw new Error('Build output changed during assembly');
}
if (JSON.stringify(await captureDesktopBuildSources(root)) !== JSON.stringify(current)) throw new Error('Source changed during desktop assembly');
const destination = directories[3]; await mkdir(destination);
const app = join(destination, 'app'); await mkdir(app);
for (const [name, bytes] of assembled.files) {
  const target = join(app, name); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
  if (desktopFileHash(await readFile(target)) !== desktopFileHash(bytes)) throw new Error('Staged desktop differs: ' + name);
}
log(JSON.stringify({ destination, files: assembled.files.size, manualBuildId: assembled.manifest.manualBuildId,
  pdfVolumes: assembled.manifest.pdfVolumes, version: assembled.manifest.version, releaseCertified: false }));
