/** Build a fresh, attributable Web candidate. The separate assembler adds matching HTML/PDF manuals. */
import { argv, env } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { collectOfflineAssetFiles } from '../vite/offlineAssets.mjs';

import { captureWebBuildSources } from '../vite/webBuildSources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = argv.slice(2);
if (args.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/u.test(args[0])) throw new Error('Specify one new output name under dist/.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temp = execFileSync('python', ['-B', '-X', 'utf8', join(root, 'scripts/lib/task_workspace.py'), '--temp-root'],
  { cwd: root, encoding: 'utf8' }).trim();
env.TEMP = temp; env.TMP = temp; env.TMPDIR = temp;
const inputs = await captureWebBuildSources(root), parent = join(root, 'dist'), destination = join(parent, args[0]);
await mkdir(parent, { recursive: true });
if ((await lstat(parent)).isSymbolicLink()) throw new Error('Output parent must not be a link');
await mkdir(destination);
await build({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
  build: { outDir: destination, emptyOutDir: false } });
if (JSON.stringify(await captureWebBuildSources(root)) !== JSON.stringify(inputs)) throw new Error('Source changed during Web generation');
const collected = await collectOfflineAssetFiles(root, destination), outputs = {};
for (const file of collected.files) outputs[file.path] = hash(file.bytes);
for (const name of collected.excluded) outputs[name] = hash(await readFile(join(destination, name)));
await writeFile(join(destination, 'web-build.json'), JSON.stringify({ format: 'pointercad-web-build/1', inputs, outputs }), { flag: 'wx' });
log(JSON.stringify({ destination, sources: Object.keys(inputs).length, files: Object.keys(outputs).length, releaseCertified: false }));
