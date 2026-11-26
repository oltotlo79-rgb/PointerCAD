/// <reference lib="dom" />
import { readdir } from 'node:fs/promises';
import * as console from 'node:console';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, URL } from 'node:url';
import type { FullConfig } from '@playwright/test';

/**
 * 画面検査の開始の前に、preview が配る dist の全ファイルを 1 回受け取って温める(2026-11-20、統括の案 (a))。
 * 画面検査は 1 回の起動ごとに apps/web/dist を作り直す(scripts/lib/e2eWebServer.mjs)ので、作り直した直後の数百本が、
 * 最初の数ページで初めて読まれる。新しく書いたファイルの最初の読みは、実測で 8〜14ms(2 回目は 0.3ms)かかり、
 * ほかの入出力と重なると 5〜23 秒に伸びて、起動の待ち(startupHealth.ts の 15 秒)の内側で受け取りが終わらない事があった。
 * 先に全部を 1 回受け取っておけば、その時間は検査の待ちの外へ出る。待ちの 15 秒・期待値・やり直しは変えない。
 *
 * Playwright は webServer の起動と待ちを終えてから globalSetup を流す(playwright の runner の createGlobalSetupTasks)。
 * preview を使わない組み立て(Electron だけ。webServer に url が無い)では何もせず、その旨を 1 行出す。
 * 温めの失敗(サーバーが返さない・時間切れ)は検査の失敗にせず、警告の 1 行にして検査を始める: 温めは速さのための手当てで、
 * 本当にサーバーが返さないなら、その後の検査が自分の診断つきで落ちるため、ここで落とすと原因が 1 本の準備の失敗に隠れる。
 */
const DIST_DIRECTORY = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const PARALLEL_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 60_000;
const BYTES_PER_MIB = 1_048_576;

interface Warmed {
  received: number;
  bytes: number;
  started: number;
  failures: string[];
}

async function distFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => (entry.isDirectory()
    ? distFiles(`${directory}${entry.name}/`, `${prefix}${entry.name}/`)
    : entry.isFile() ? [`${prefix}${entry.name}`] : [])));
  return nested.flat().sort();
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function receiveOne(baseUrl: string, path: string, warmed: Warmed, deadline: AbortSignal): Promise<void> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  try {
    const response = await fetch(new URL(`./${encodedPath}`, baseUrl), { signal, redirect: 'error' });
    const contentType = response.headers.get('content-type');
    const htmlFallback = contentType?.startsWith('text/html') === true && !/\.html?$/iu.test(path);
    if (!response.ok || response.body === null || htmlFallback) {
      await response.body?.cancel();
      warmed.failures.push(`${path}: HTTP ${response.status}${htmlFallback ? ' (HTML fallback)' : ''}`);
      return;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) bytes += chunk.value.byteLength;
    } finally { reader.releaseLock(); }
    warmed.received += 1;
    warmed.bytes += bytes;
  } catch (error) {
    warmed.failures.push(`${path}: ${reason(error)}`);
  }
}

async function receiveAll(baseUrl: string, files: readonly string[]): Promise<Warmed> {
  const warmed: Warmed = { received: 0, bytes: 0, started: 0, failures: [] };
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  async function worker(): Promise<void> {
    for (let path = files[warmed.started]; path !== undefined && !deadline.aborted; path = files[warmed.started]) {
      warmed.started += 1;
      await receiveOne(baseUrl, path, warmed, deadline);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker));
  return warmed;
}

export default async function globalWarmPreview(config: FullConfig): Promise<void> {
  const baseUrl = config.webServer?.url;
  if (baseUrl === undefined) {
    console.log('[温め] preview を使わない組み立て(Electron だけ)なので、温めは行いません');
    return;
  }
  let files: string[];
  try {
    files = await distFiles(DIST_DIRECTORY);
  } catch (error) {
    console.warn(`[温め] 警告: ${DIST_DIRECTORY} を読めないため温めを行わずに検査を始めます(${reason(error)})`);
    return;
  }
  const startedAt = performance.now();
  const warmed = await receiveAll(baseUrl, files);
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(`[温め] preview から dist ${warmed.received}/${files.length} 本・${(warmed.bytes / BYTES_PER_MIB).toFixed(1)}MiB を ${elapsedMs}ms で受け取りました(同時 ${PARALLEL_REQUESTS})`);
  const unreached = files.length - warmed.started;
  if (warmed.failures.length > 0 || unreached > 0) {
    console.warn(`[温め] 警告: 受け取れなかった物 ${warmed.failures.length} 本・時間切れで始めなかった物 ${unreached} 本。検査は始めます。例: ${warmed.failures.slice(0, 3).join(' / ')}`);
  }
}
