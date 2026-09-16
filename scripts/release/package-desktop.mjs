/** Build unsigned candidates only. Do not install, publish, alter a user profile or reuse an output. */
import { argv, env, platform } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectDesktopFiles } from './desktopFileInventory.mjs';
import { desktopJson, verifyDesktopDistribution } from './desktopDistribution.mjs';
import { prepareDesktopInstallerResources, writeDesktopUninstallFiles } from './desktopInstallerResources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = argv.slice(2);
if (args.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/u.test(args[0]) || !['win32', 'linux'].includes(platform)) {
  throw new Error('Specify one existing staged desktop name under dist/.');
}
const staged = join(root, 'dist', args[0]), app = join(staged, 'app'), outputs = join(staged, 'artifacts');
const stagedFiles = await collectDesktopFiles(root, app);
const manifestBytes = stagedFiles.find(file => file.path === 'desktop-package.json')?.bytes;
const manifest = desktopJson(manifestBytes);
verifyDesktopDistribution(stagedFiles, manifestBytes);
if (manifest.platform !== platform || manifest.arch !== 'x64' || manifest.builderVersion !== '26.15.3') throw new Error('Desktop build target differs');
const require = createRequire(join(root, 'package.json'));
if (require('electron-builder/package.json').version !== manifest.builderVersion) throw new Error('Desktop builder version differs');
const temporary = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), '--temp-root'],
  { cwd: root, encoding: 'utf8' }).trim();
for (const name of ['TEMP', 'TMP', 'TMPDIR']) env[name] = temporary;
const cacheRoot = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), 'desktop-builder-cache'],
  { cwd: root, encoding: 'utf8' }).trim();
for (const [name, folder] of Object.entries({ ELECTRON_BUILDER_CACHE: 'builder', ELECTRON_CACHE: 'electron',
  XDG_CACHE_HOME: 'cache', XDG_CONFIG_HOME: 'config' })) {
  const path = join(cacheRoot, folder); await mkdir(path); env[name] = path;
}
env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
env.electron_config_cache = env.ELECTRON_CACHE;
await mkdir(outputs); // An existing or partially built candidate is never overwritten.
const resources = join(staged, 'packaging');
await prepareDesktopInstallerResources(root, resources);
const { build, createTargets, Platform } = await import('electron-builder');
const target = platform === 'win32' ? Platform.WINDOWS : Platform.LINUX;
const artifacts = await build({ projectDir: app, publish: 'never',
  targets: createTargets([target], platform === 'win32' ? 'nsis' : 'AppImage', 'x64'),
  config: { extends: join(root, 'apps/desktop/electron-builder.yml'), electronVersion: manifest.electronVersion,
    directories: { app, output: outputs, buildResources: resources },
    afterPack: platform === 'win32' ? context => writeDesktopUninstallFiles(root, context.appOutDir, resources) : undefined } });
const unpacked = join(outputs, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources/app');
const verified = verifyDesktopDistribution(await collectDesktopFiles(root, unpacked), manifestBytes);
const assets = [];
for (const path of artifacts) {
  const name = relative(outputs, path);
  if (isAbsolute(name) || name === '..' || name.startsWith('..' + sep)) throw new Error('Builder artifact escaped output');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Missing package artifact');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assets.push({ name: name.split(sep).join('/'), bytes: info.size, sha256: hash.digest('hex') });
}
if (assets.length === 0) throw new Error('Builder produced no artifact');
const receipt = { format: 'pointercad-desktop-candidate/1', version: manifest.version, sourceCommit: manifest.sourceCommit,
  platform, arch: 'x64', signed: false, assets, application: verified, installed: false, releaseCertified: false };
await writeFile(join(staged, 'candidate.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
log(JSON.stringify(receipt));
