import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { collectDesktopFiles, desktopOutputHashes } from '../release/desktopFileInventory.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const W21_DESKTOP_OUTPUT = 'apps/desktop/dist';
const outputFolders = ['main', 'preload', 'renderer'];
export const W21_DESKTOP_ENTRIES = ['main/main.cjs', 'preload/preload.cjs', 'renderer/index.html'];
export const W21_DESKTOP_FORMAT = 'pointercad-w21-desktop-build/1';

export function desktopExecutable() {
  const executable = requireDesktop('electron');
  if (typeof executable !== 'string') throw new Error('Electron実行ファイルなし');
  return executable;
}

async function runIdentity() {
  const { PCAD_W21_RUN_ID: runId, PCAD_W21_MANIFEST_SHA256: manifestSha256,
    PLAYWRIGHT_JSON_OUTPUT_FILE: report } = process.env;
  const local = typeof report === 'string' ? relative(root, report) : '';
  if (!/^[a-zA-Z0-9_-]+$/u.test(runId ?? '') || !/^[a-f0-9]{64}$/u.test(manifestSha256 ?? '')
    || typeof report !== 'string' || !isAbsolute(report) || !local.startsWith(`scratchpad${sep}`)) {
    throw new Error('W21 desktop build requires a run, manifest and owned report path');
  }
  if (await realpath(dirname(report)) !== resolve(dirname(report))) throw new Error('W21 report folder is redirected');
  return { runId, manifestSha256, report };
}

async function captureBinary() {
  const file = await realpath(desktopExecutable());
  const executablePath = relative(await realpath(root), file);
  if (isAbsolute(executablePath) || !executablePath.startsWith(`node_modules${sep}`)) {
    throw new Error('W21 must use Electron from the frozen checkout dependency store');
  }
  const before = await lstat(file);
  if (!before.isFile() || before.size <= 0) throw new Error('Invalid Electron executable');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  const after = await lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error('Electron executable changed while reading');
  }
  return { sha256: hash.digest('hex'), bytes: after.size };
}

async function captureDesktopBuild(identity) {
  const outputs = {};
  for (const folder of outputFolders) {
    const files = await collectDesktopFiles(root, resolve(root, W21_DESKTOP_OUTPUT, folder));
    for (const [path, sha256] of Object.entries(desktopOutputHashes(files))) outputs[`${folder}/${path}`] = sha256;
  }
  if (!W21_DESKTOP_ENTRIES.every(entry => Object.hasOwn(outputs, entry))) throw new Error('Incomplete fresh Electron output');
  const electron = await captureBinary();
  return { format: W21_DESKTOP_FORMAT, ...identity, checkedAt: new Date().toISOString(), outputs, electron };
}

const receiptPath = ({ report }) => resolve(dirname(report), 'w21-desktop-build-ready.json');

export async function recordW21DesktopBuild() {
  if (process.env.VITE_PCAD_E2E !== '1') throw new Error('W21 desktop build did not use the E2E build environment');
  const identity = await runIdentity();
  const receipt = await captureDesktopBuild(identity);
  await writeFile(receiptPath(identity), `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
}

async function recordW21DesktopBuildAfter() {
  const identity = await runIdentity();
  const ready = JSON.parse(await readFile(receiptPath(identity), 'utf8'));
  const observed = await captureDesktopBuild(identity);
  const { checkedAt: readyAt, ...built } = ready;
  const { checkedAt, ...current } = observed;
  if (!Number.isFinite(Date.parse(readyAt)) || Date.parse(readyAt) > Date.parse(checkedAt)
    || JSON.stringify(built) !== JSON.stringify(current)) {
    throw new Error('W21 desktop output or Electron executable differs from the fresh build');
  }
  const reportSha256 = createHash('sha256').update(await readFile(identity.report)).digest('hex');
  const target = resolve(dirname(identity.report), 'w21-desktop-build-after.json');
  await writeFile(target, `${JSON.stringify({ ready, observed, reportSha256 })}\n`, { flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.PCAD_DEDICATED_MEASUREMENT !== 'w21') throw new Error('Expected dedicated W21 Electron run');
  await recordW21DesktopBuildAfter();
}
