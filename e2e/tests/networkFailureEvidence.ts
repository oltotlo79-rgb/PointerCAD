import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Page, TestInfo } from '@playwright/test';

/**
 * 読込の失敗の記録(どの画面検査からも使える小さい補助)。
 * Chromium の console の文「Failed to load resource: net::ERR_…」には url が入らないので、requestfailed で
 * 失敗した要求の url・種類・誤りの文・時刻を集めておき、console の誤りがあった時だけ、判定の前に、
 * 集めた要求と、その時の通信の状態(Windows の TCP の状態ごとの数・preview の口への接続の数・一時ポートの範囲、
 * Linux の /proc/net/sockstat)を添付し、ログにも 1 行の JSON で出す。判定(誤りが空であること)は呼び手のまま変えない。
 * 誤りが無い時は通信の状態を取りに行かない(所要を増やさない)。通信の状態を取れなくても投げない。
 */

/** 失敗した要求 1 件。時刻は検査側の performance.now()(同じ検査の他の記録と比べられる)。 */
export interface FailedRequest { readonly url: string; readonly resourceType: string; readonly errorText: string | null; readonly atMs: number }
/** 集めた要求。上限を超えた分は数だけ数える。 */
export interface FailedRequestLog { readonly requests: FailedRequest[]; dropped: number }
/** その時の通信の状態。取れなかった時は理由を残す。 */
export type NetworkState =
  | { readonly status: 'windows'; readonly tcpStates: Readonly<Record<string, number>>; readonly previewPort: number;
    readonly previewConnections: number; readonly dynamicPortStart: number | null; readonly dynamicPortCount: number | null }
  | { readonly status: 'linux'; readonly sockstat: Readonly<Record<string, Readonly<Record<string, number>>>> }
  | { readonly status: 'unavailable'; readonly reason: string };
export interface RequestFailureRecord {
  readonly label: string; readonly errors: readonly string[]; readonly failedRequests: readonly FailedRequest[];
  readonly droppedRequests: number; readonly network: NetworkState;
}

const URL_LIMIT = 2000;
const CAPTURE_TIMEOUT_MS = 15_000;

/** page の requestfailed を集め始める。ページを開く前に呼ぶ。 */
export function collectFailedRequests(page: Page, limit = 100): FailedRequestLog {
  const log: FailedRequestLog = { requests: [], dropped: 0 };
  page.on('requestfailed', request => {
    if (log.requests.length >= limit) { log.dropped += 1; return; }
    log.requests.push({ url: request.url().slice(0, URL_LIMIT), resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? null, atMs: performance.now() });
  });
  return log;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const port = (value: unknown): number | null => count(value) ? value : null;

/** Windows の PowerShell の出力(下の windowsScript が出す JSON)を確かめて整える。形が違えば取れなかった扱い。 */
export function windowsNetworkState(output: unknown, previewPort: number): NetworkState {
  if (!isRecord(output) || !Array.isArray(output.states) || !count(output.preview)) {
    return { status: 'unavailable', reason: 'malformed windows TCP output' };
  }
  const tcpStates: Record<string, number> = {};
  for (const row of output.states) {
    if (!isRecord(row) || typeof row.state !== 'string' || !count(row.count)) {
      return { status: 'unavailable', reason: 'malformed windows TCP state row' };
    }
    tcpStates[row.state] = row.count;
  }
  return { status: 'windows', tcpStates, previewPort, previewConnections: output.preview,
    dynamicPortStart: port(output.start), dynamicPortCount: port(output.count) };
}

/** Linux の /proc/net/sockstat の本文を「種類: 名前 値 …」ごとに整える。TCP の行が無ければ取れなかった扱い。 */
export function linuxNetworkState(text: string): NetworkState {
  const sockstat: Record<string, Record<string, number>> = {};
  for (const line of text.split(/\r?\n/u)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const words = line.slice(colon + 1).trim().split(/\s+/u), values: Record<string, number> = {};
    for (let index = 0; index + 1 < words.length; index += 2) {
      const value = Number(words[index + 1]);
      if (Number.isSafeInteger(value)) values[words[index] ?? ''] = value;
    }
    sockstat[line.slice(0, colon).trim()] = values;
  }
  return sockstat.TCP === undefined ? { status: 'unavailable', reason: 'no TCP line in /proc/net/sockstat' } : { status: 'linux', sockstat };
}

/** 状態ごとの TCP の数、preview の口(ローカルか相手)の接続の数、一時ポートの範囲を 1 つの JSON で出す。 */
function windowsScript(previewPort: number): string {
  return ["$ErrorActionPreference='Stop'",
    '$c=@(Get-NetTCPConnection)',
    '$s=@($c|Group-Object -Property State|ForEach-Object{[pscustomobject]@{state=[string]$_.Name;count=[int]$_.Count}})',
    `$p=@($c|Where-Object{$_.LocalPort -eq ${String(previewPort)} -or $_.RemotePort -eq ${String(previewPort)}}).Count`,
    '$r=@(Get-NetTCPSetting|Where-Object{$_.DynamicPortRangeStartPort})|Select-Object -First 1',
    '[pscustomobject]@{states=$s;preview=$p;start=$r.DynamicPortRangeStartPort;count=$r.DynamicPortRangeNumberOfPorts}|ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
}

/** 今の通信の状態を取る。失敗しても投げず、理由つきの unavailable を返す(検査の合否を変えない)。 */
export async function captureNetworkState(previewPort: number): Promise<NetworkState> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        windowsScript(previewPort)], { timeout: CAPTURE_TIMEOUT_MS, windowsHide: true });
      return windowsNetworkState(JSON.parse(stdout), previewPort);
    }
    if (process.platform === 'linux') return linuxNetworkState(await readFile('/proc/net/sockstat', 'utf8'));
    return { status: 'unavailable', reason: `unsupported platform ${process.platform}` };
  } catch (error: unknown) {
    return { status: 'unavailable', reason: String(error).slice(0, 500) };
  }
}

/** 検査の設定の baseURL の口(preview)。読めなければ 0。 */
function previewPortOf(info: TestInfo): number {
  const base = info.project.use.baseURL;
  if (typeof base !== 'string') return 0;
  try { return Number(new URL(base).port) || 0; } catch { return 0; }
}

/**
 * console の誤りがあった時だけ、判定の前に呼び手が呼ぶ。集めた要求と、その時の通信の状態を添付し、
 * ログへ `[通信の失敗]` の 1 行の JSON で出す。誤りが無ければ何もしない(null)。判定は呼び手のまま。
 */
export async function recordRequestFailures(info: TestInfo, input: { readonly label: string; readonly errors: readonly string[];
  readonly failed: FailedRequestLog; readonly capture?: () => Promise<NetworkState> }): Promise<RequestFailureRecord | null> {
  if (input.errors.length === 0) return null;
  let network: NetworkState;
  try { network = await (input.capture ?? (() => captureNetworkState(previewPortOf(info))))(); }
  catch (error: unknown) { network = { status: 'unavailable', reason: String(error).slice(0, 500) }; }
  const record: RequestFailureRecord = { label: input.label, errors: input.errors.slice(0, 30).map(text => text.slice(0, 2000)),
    failedRequests: [...input.failed.requests], droppedRequests: input.failed.dropped, network };
  console.log('[通信の失敗]', JSON.stringify(record));
  await info.attach('request-failures', { contentType: 'application/json', body: JSON.stringify(record, null, 2) });
  return record;
}
