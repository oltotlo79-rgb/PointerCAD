/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import * as console from 'node:console';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { env } from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import type { FullConfig } from '@playwright/test';

/** Warm the first-screen files from the same build that the ordinary preview serves. */
const STARTUP_PLAN = resolve(dirname(fileURLToPath(import.meta.url)),
  '../apps/web/dist/.vite/preview-startup.json');
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

function isAssetPath(path: unknown): path is string {
  return typeof path === 'string' && !/[\\?#:]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

async function readStartupPaths(): Promise<string[]> {
  const paths: unknown = JSON.parse(await readFile(STARTUP_PLAN, 'utf8'));
  if (!Array.isArray(paths) || !paths.every(isAssetPath) || paths[0] !== 'index.html') {
    throw new Error('Invalid preview startup asset list');
  }
  return [...new Set(paths)];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function receiveOne(baseUrl: string, path: string, warmed: Warmed, deadline: AbortSignal): Promise<void> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  try {
    const url = new URL(path === 'index.html' ? './' : `./${encodedPath}`, baseUrl);
    const response = await fetch(url, { signal, redirect: 'error' });
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
  if (env.PCAD_E2E_PREVIEW_WARMUP === '0') return;
  const baseUrl = config.webServer?.url;
  if (baseUrl === undefined) {
    console.log('[温め] preview を使わない組み立て(Electron だけ)なので、温めは行いません');
    return;
  }
  let files: string[];
  try {
    files = await readStartupPaths();
  } catch (error) {
    console.warn(`[温め] 警告: ${STARTUP_PLAN} を読めないため温めを行わずに検査を始めます(${reason(error)})`);
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
