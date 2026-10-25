import ocGlueUrl from 'opencascade.js/dist/opencascade.full.js?url';
import ocWasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import {
  decompressAndVerifyOcctAsset,
  parseOcctAssetManifest,
  type DownloadedOcctAssetPart,
  type OcctAssetManifest,
} from './occtAssetManifest.js';
import {
  compileVerifiedOcctResponse,
  createOcctInstantiationHook,
  OcctStreamingUnavailableError,
  verifyOcctStreamingResponse,
  verifyOcctDirectResponse,
  type OcctInstantiationHook,
  type VerifiedOcctResponse,
} from './compiledOcctModule.js';
import { OcctCompilationCache } from './occtCompilationCache.js';
import { validateDesktopOcctTransportReply } from './desktopOcctTransportContract.js';

/**
 * Emscripten が出力したグルーコードのファクトリ。
 * opencascade.js の dist/index.js が `new mainJS({ locateFile })` として呼んでいる形に合わせる。
 */
export interface OcctModuleOptions {
  readonly locateFile?: (path: string) => string;
  readonly wasmBinary?: ArrayBuffer;
  readonly instantiateWasm?: OcctInstantiationHook['instantiateWasm'];
}

type OcctModuleFactory = new (moduleOptions: OcctModuleOptions) => Promise<OpenCascadeInstance>;

/** 実行時 import で読み込んだグルーコードの形。 */
interface OcctGlueModule {
  readonly default: OcctModuleFactory;
}

/**
 * 実行時 import の結果がファクトリを持つかを実行時に確かめる。
 *
 * import() の引数が文字列リテラルでないとき、TypeScript は結果を any として扱う。
 * `as` による強制変換で型を合わせることは禁じられている(rules/02-禁止事項.md)ため、
 * unknown で受けてから中身を実際に調べて絞り込む。読み込みに失敗した場合は
 * 型の食い違いを黙って通さず、理由の分かる例外にする(NFR-UX-5)。
 */
function isOcctGlueModule(value: unknown): value is OcctGlueModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    typeof value.default === 'function'
  );
}

let cached: Promise<OpenCascadeInstance> | undefined;
const compiledModules = new OcctCompilationCache();

declare const __PCAD_DESKTOP_OCCT_IDENTITY__: unknown;

function diagnosticObserver(owner: 'parent-fetch' | 'worker'): (phase: string) => void {
  const started = performance.now(), instanceId = crypto.randomUUID();
  return phase => {
    if (import.meta.env.VITE_PCAD_E2E === '1') console.debug('[pcad:kernel-startup]', JSON.stringify({
      owner, instanceId, phase, atEpochMs: Date.now(), timeOrigin: performance.timeOrigin,
      elapsedMs: performance.now() - started,
    }));
  };
}

function desktopIdentity(): { readonly sha256: string; readonly byteLength: number } | undefined {
  if (typeof __PCAD_DESKTOP_OCCT_IDENTITY__ === 'undefined') return undefined;
  const value = __PCAD_DESKTOP_OCCT_IDENTITY__;
  if (typeof value !== 'object' || value === null || !('sha256' in value) ||
      !('byteLength' in value) || typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.byteLength !== 'number' ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 || value.byteLength > 64 * 1024 * 1024) {
    throw new Error('Desktop OCCT build identity is invalid.');
  }
  return { sha256: value.sha256, byteLength: value.byteLength };
}

async function fetchVerifiedDirectOcct(
  wasmUrl: string, signal?: AbortSignal, observe?: (phase: string) => void,
  fetchStarted = false,
): Promise<VerifiedOcctResponse> {
  const identity = desktopIdentity();
  if (identity === undefined) throw new Error('Desktop OCCT build identity is missing.');
  const url = new URL(wasmUrl, location.href);
  // URL.origin is "null" for custom protocols: compare the actual scheme and host too.
  if (!['app:', 'http:', 'https:'].includes(url.protocol) || url.protocol !== location.protocol ||
      url.host !== location.host || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '' || !/\/assets\/opencascade\.full-[^/%]+\.wasm$/.test(url.pathname)) {
    throw new Error('Desktop OCCT asset URL is invalid.');
  }
  if (!fetchStarted) observe?.('fetch-start');
  const response = await fetch(url, { signal, redirect: 'error' });
  observe?.('response-headers');
  return verifyOcctDirectResponse(response, { ...identity, url: url.href }, signal, observe);
}

function isDesktopOcctBridge(value: unknown): value is { prepareOcctTransport: () => unknown } {
  return typeof value === 'object' && value !== null &&
    'prepareOcctTransport' in value && typeof value.prepareOcctTransport === 'function';
}

async function fetchVerifiedDesktopOcct(
  wasmUrl: string, signal?: AbortSignal, observe?: (phase: string) => void,
): Promise<VerifiedOcctResponse> {
  // Workers have no preload bridge; the normal broker supplies their compiled module.
  if (typeof window === 'undefined') return fetchVerifiedDirectOcct(wasmUrl, signal, observe);
  const identity = desktopIdentity();
  if (identity === undefined) throw new Error('Desktop OCCT build identity is missing.');
  const bridge: unknown = 'pointercadDesktop' in window ? window.pointercadDesktop : undefined;
  if (!isDesktopOcctBridge(bridge)) {
    throw new Error('Desktop OCCT transport bridge is missing.');
  }
  signal?.throwIfAborted();
  // Preparation, cache reads and any cache fill belong to the original fetch interval.
  observe?.('fetch-start');
  const preparation: Promise<unknown> = Promise.resolve(bridge.prepareOcctTransport());
  const reply = await awaitDesktopPreparation(preparation, signal);
  signal?.throwIfAborted();
  const transport = validateDesktopOcctTransportReply(reply, identity);
  if (transport.kind === 'direct') {
    observe?.('transport-direct-port-unavailable');
    return fetchVerifiedDirectOcct(wasmUrl, signal, observe, true);
  }
  observe?.('transport-http');
  const response = await fetch(transport.url, { signal, mode: 'cors', credentials: 'include', redirect: 'error' });
  observe?.('response-headers');
  // Keep the genuine fetched Response for native compileStreaming cache metadata.
  return verifyOcctStreamingResponse(response, { ...identity, url: transport.url }, signal, observe);
}

async function awaitDesktopPreparation(preparation: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  if (signal === undefined) return preparation;
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      onAbort = () => {
        const reason: unknown = signal.reason;
        if (reason instanceof Error) {
          reject(reason);
          return;
        }
        const error = new Error(typeof reason === 'string' ? reason : 'Desktop OCCT preparation aborted.', { cause: reason });
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Both callbacks remain attached after cancellation, so a late IPC rejection is handled.
      void preparation.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export interface FetchedOcctAssetManifest {
  readonly manifest: OcctAssetManifest;
  readonly url: string;
}

async function fetchAssetManifest(
  strict = false,
  signal?: AbortSignal,
): Promise<FetchedOcctAssetManifest | undefined> {
  const url = `${import.meta.env.BASE_URL}occt/manifest.json`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
      ...(strict ? { mode: 'same-origin' as const, redirect: 'error' as const } : {}),
    });
    if (strict) {
      const expected = new URL(url, location.href);
      if (response.redirected || response.url !== expected.href || expected.origin !== location.origin) {
        throw new Error('OCCT 資産 manifest の URL が一致しません。');
      }
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (response.status === 404) {
      if (strict) throw new Error('OCCT 資産 manifest が見つかりません。');
      return undefined;
    }
    if (strict && response.status !== 200) {
      throw new Error(`OCCT 資産 manifest を取得できませんでした(HTTP ${response.status})。`);
    }
    if (strict && contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      throw new Error('OCCT 資産 manifest の Content-Type が不正です。');
    }
    if (!strict && !contentType.toLowerCase().includes('application/json')) return undefined;
    if (!response.ok) {
      throw new Error(`OCCT 資産 manifest を取得できませんでした(HTTP ${response.status})。`);
    }
    const value: unknown = await response.json();
    return { manifest: parseOcctAssetManifest(value), url: response.url };
  } catch (error) {
    if (strict) throw error;
    // serve / Electron では従来の `?url` が実在するため、manifest が無ければ元経路へ戻る。
    // ?urlはビルド時に実URLへ置換される。文字数へ畳み込むと置換用の印まで
    // 数式へ混ざるため、空URLとの比較のまま代替資産の有無を判定する。
    if (ocWasmUrl !== '') {
      return undefined;
    }
    throw error;
  }
}

async function fetchCompressedWasm(
  fetched: FetchedOcctAssetManifest,
  stage: (name: string) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const downloaded: DownloadedOcctAssetPart[] = [];
  for (const part of fetched.manifest.parts) {
    const response = await fetch(new URL(part.file, fetched.url), { signal });
    if (!response.ok) {
      throw new Error(`OCCT 資産の片 ${part.order} を取得できませんでした(HTTP ${response.status})。`);
    }
    downloaded.push({ order: part.order, data: await response.arrayBuffer() });
  }
  stage('downloaded');
  const binary = await decompressAndVerifyOcctAsset(fetched.manifest, downloaded);
  stage('verified');
  return binary;
}

/** The broker and the Worker share this verified HTTP entry point. */
export async function fetchVerifiedOcctForBroker(
  signal?: AbortSignal,
  directWasmUrl = ocWasmUrl,
): Promise<VerifiedOcctResponse | undefined> {
  const observe = diagnosticObserver('parent-fetch');
  if (location.protocol === 'app:') return fetchVerifiedDesktopOcct(directWasmUrl, signal, observe);
  // The desktop app's direct ?url WASM has no HTTP manifest/stream response.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return undefined;
  // Vite's development server serves the direct ?url asset and may answer a
  // missing manifest request with index.html. Preserve that existing path.
  if (import.meta.env.DEV) return undefined;
  // A bundled Desktop renderer may be served over HTTP too. Its fixed build
  // URL uses the same direct WASM path as the packaged app. Web builds have
  // no direct URL and must verify the manifest without falling back.
  if (directWasmUrl !== '') return undefined;
  const fetched = await fetchAssetManifest(true, signal);
  if (fetched?.manifest.stream === undefined) return undefined;
  return fetchVerifiedStreamingOcct(fetched, signal);
}

async function fetchVerifiedStreamingOcct(
  fetched: FetchedOcctAssetManifest,
  signal?: AbortSignal,
  observe: (phase: string) => void = diagnosticObserver('parent-fetch'),
): Promise<VerifiedOcctResponse | undefined> {
  const manifest = parseOcctAssetManifest(fetched.manifest);
  const stream = manifest.stream;
  if (stream === undefined) return undefined;
  const manifestUrl = new URL(fetched.url);
  const url = new URL(stream.file, manifestUrl);
  if (!manifestUrl.pathname.endsWith('/occt/manifest.json') ||
      manifestUrl.search !== '' || manifestUrl.hash !== '' ||
      url.origin !== manifestUrl.origin ||
      (typeof location !== 'undefined' && url.origin !== location.origin) ||
      url.search !== '' || url.hash !== '' ||
      url.pathname.includes('%') ||
      !url.pathname.endsWith(`/occt/${stream.file}`)) {
    throw new Error('OCCT streaming 資産の URL が不正です。');
  }
  observe('fetch-start');
  const response = await fetch(url, { signal, mode: 'same-origin', redirect: 'error' });
  observe('response-headers');
  if (!response.ok) {
    throw new Error(`OCCT streaming 資産を取得できませんでした(HTTP ${response.status})。`);
  }
  let verified: VerifiedOcctResponse;
  try {
    verified = await verifyOcctStreamingResponse(response, {
      url: url.href,
      sha256: stream.decodedSha256,
      byteLength: stream.decodedByteLength,
    }, signal, observe);
  } catch (error) {
    if (!(error instanceof OcctStreamingUnavailableError)) throw error;
    await response.body?.cancel();
    return undefined;
  }
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null && contentLength !== String(stream.transportByteLength)) {
    throw new Error('OCCT streaming 資産の圧縮輸送長が一致しません。');
  }
  return verified;
}

export async function loadManifestOcct<T>(
  fetched: FetchedOcctAssetManifest,
  factory: (options: OcctModuleOptions) => Promise<T>,
  stage: (name: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  const manifest = parseOcctAssetManifest(fetched.manifest);
  if (manifest.stream !== undefined) {
    const verified = await fetchVerifiedStreamingOcct({ ...fetched, manifest }, signal, stage);
    if (verified !== undefined) {
      stage('compile-start');
      const module = await compiledModules.getOrCompile(verified, compileVerifiedOcctResponse, signal);
      stage('compile-end');
      return instantiateCompiledOcct(module, factory, stage, signal);
    }
  }
  // Only a MIME/encoding mismatch reaches this path. Fetch the legacy gzip
  // entity separately: the decoded stream response is never a .bin part.
  const wasmBinary = await fetchCompressedWasm({ ...fetched, manifest }, stage, signal);
  stage('instantiate');
  return factory({ wasmBinary });
}

async function instantiateCompiledOcct<T>(
  module: WebAssembly.Module,
  factory: (options: OcctModuleOptions) => Promise<T>,
  stage: (name: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  const observe = (name: string): void => {
    try { stage(name); } catch { /* Diagnostic callbacks do not own module initialization. */ }
  };
  const hook = createOcctInstantiationHook(module, signal, observe);
  stage('instantiate');
  try {
    observe('factory-start');
    const factoryPromise = factory({ instantiateWasm: hook.instantiateWasm }).then(instance => {
      observe('factory-end');
      return instance;
    });
    const [instance] = await Promise.all([factoryPromise, hook.completion]);
    stage('instantiate-end');
    return instance;
  } finally {
    hook.close();
  }
}

export async function loadLegacyOcct<T>(
  wasmUrl: string,
  factory: (options: OcctModuleOptions) => Promise<T>,
  stage: (name: string) => void,
): Promise<T> {
  stage('instantiate-fallback');
  return factory({ locateFile: (path: string): string => (path.endsWith('.wasm') ? wasmUrl : path) });
}

async function importOcctGlue(): Promise<unknown> {
  const glueModule: unknown = await import(/* @vite-ignore */ ocGlueUrl);
  return glueModule;
}

/**
 * ブラウザ(および Web Worker)で OCCT を読み込む。
 *
 * グルーコードと wasm を ?url で「場所」としてだけ受け取り、グルーコードは実行時の
 * import() で読む。こうするとバンドラはこの 2 ファイルを資産として出力するだけで
 * 中身を解析しないため、グルーコードに含まれる Node 専用の分岐(fs / path / module の
 * 読み込み)がブラウザ向けビルドで解決できずに失敗する問題が起きない。
 *
 * 初期化には時間がかかるので、読み込み手続きは 1 回だけ実行して使い回す。
 */
export function loadOcctForBrowser(
  moduleOffer?: () => Promise<WebAssembly.Module | undefined>,
): Promise<OpenCascadeInstance> {
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<OpenCascadeInstance> => {
    const stage = diagnosticObserver('worker');
    stage('start');
    const gluePromise = importOcctGlue();
    const manifestPromise = moduleOffer === undefined ? fetchAssetManifest() : undefined;
    const glueModule = await gluePromise;
    stage('glue-ready');
    if (!isOcctGlueModule(glueModule)) {
      throw new Error(
        `OCCT のグルーコードを読み込めませんでした(既定の書き出しが見つかりません): ${ocGlueUrl}`,
      );
    }
    if (moduleOffer !== undefined) {
      const offered = await moduleOffer();
      if (offered !== undefined) {
        stage('broker-verified');
        const instance = await instantiateCompiledOcct(
          offered, (options) => new glueModule.default(options), stage,
        );
        stage('ready');
        return instance;
      }
    }
    if (location.protocol === 'app:') {
      const verified = await fetchVerifiedDesktopOcct(ocWasmUrl, undefined, stage);
      stage('compile-start');
      const module = await compiledModules.getOrCompile(verified, compileVerifiedOcctResponse);
      stage('compile-end');
      const instance = await instantiateCompiledOcct(module, options => new glueModule.default(options), stage);
      stage('ready');
      return instance;
    }
    const fetchedManifest = await (manifestPromise ?? fetchAssetManifest());
    if (fetchedManifest !== undefined) {
      const instance = await loadManifestOcct(
        fetchedManifest,
        (options) => new glueModule.default(options),
        stage,
      );
      stage('ready');
      return instance;
    }
    const instance = await loadLegacyOcct(
      ocWasmUrl,
      (options) => new glueModule.default(options),
      stage,
    );
    stage('ready');
    return instance;
  })();
  cached = pending;
  void pending.catch(() => { if (cached === pending) cached = undefined; });
  return pending;
}
