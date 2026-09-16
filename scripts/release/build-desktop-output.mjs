/** Build attributable desktop bytes into a new project-local directory. */
import { argv, env } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { captureDesktopBuildSources } from '../vite/webBuildSources.mjs';
import { collectDesktopFiles, desktopOutputHashes } from './desktopFileInventory.mjs';
import { inspectDesktopEntry } from './desktopEntryReferences.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = argv.slice(2);
if (args.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/u.test(args[0])) throw new Error('Specify one new output name under dist/.');
const temp = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), '--temp-root'],
  { cwd: root, encoding: 'utf8' }).trim();
env.TEMP = temp; env.TMP = temp; env.TMPDIR = temp;
const inputs = await captureDesktopBuildSources(root), parent = join(root, 'dist'), destination = join(parent, args[0]);
await mkdir(parent, { recursive: true });
if ((await lstat(parent)).isSymbolicLink()) throw new Error('Desktop output parent must not be a link');
await mkdir(destination);
for (const kind of ['main', 'preload', 'renderer']) {
  await build({ root: join(root, 'apps/desktop'), configFile: join(root, 'apps/desktop', 'vite.' + kind + '.config.ts'),
    build: { outDir: join(destination, kind), emptyOutDir: false } });
}
if (JSON.stringify(await captureDesktopBuildSources(root)) !== JSON.stringify(inputs)) throw new Error('Source changed during desktop generation');
const files = await collectDesktopFiles(root, destination), outputs = desktopOutputHashes(files), references = {};
for (const name of ['main/main.cjs', 'preload/preload.cjs']) {
  const file = files.find(item => item.path === name);
  if (!file) throw new Error('Missing desktop entry: ' + name);
  references[name] = inspectDesktopEntry(name, file.bytes);
}
await writeFile(join(destination, 'desktop-build.json'), JSON.stringify({ format: 'pointercad-desktop-build/1', inputs, outputs, references }), { flag: 'wx' });
log(JSON.stringify({ destination, sources: Object.keys(inputs).length, files: files.length, releaseCertified: false }));
