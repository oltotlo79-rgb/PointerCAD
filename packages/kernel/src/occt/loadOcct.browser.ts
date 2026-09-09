import ocGlueUrl from 'opencascade.js/dist/opencascade.full.js?url';
import ocWasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import {
  decompressAndVerifyOcctAsset,
  parseOcctAssetManifest,
  type DownloadedOcctAssetPart,
  type OcctAssetManifest,
} from './occtAssetManifest.js';

/**
 * Emscripten が出力したグルーコードのファクトリ。
 * opencascade.js の dist/index.js が `new mainJS({ locateFile })` として呼んでいる形に合わせる。
 */
interface OcctModuleOptions {
  readonly locateFile?: (path: string) => string;
  readonly wasmBinary?: ArrayBuffer;
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

interface FetchedOcctAssetManifest {
  readonly manifest: OcctAssetManifest;
  readonly url: string;
}

async function fetchAssetManifest(): Promise<FetchedOcctAssetManifest | undefined> {
  const url = `${import.meta.env.BASE_URL}occt/manifest.json`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const contentType = response.headers.get('Content-Type') ?? '';
    if (response.status === 404 || !contentType.toLowerCase().includes('application/json')) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`OCCT 資産 manifest を取得できませんでした(HTTP ${response.status})。`);
    }
    const value: unknown = await response.json();
    return { manifest: parseOcctAssetManifest(value), url: response.url };
  } catch (error) {
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
): Promise<ArrayBuffer> {
  const downloaded: DownloadedOcctAssetPart[] = [];
  for (const part of fetched.manifest.parts) {
    const response = await fetch(new URL(part.file, fetched.url));
    if (!response.ok) {
      throw new Error(`OCCT 資産の片 ${part.order} を取得できませんでした(HTTP ${response.status})。`);
    }
    downloaded.push({ order: part.order, data: await response.arrayBuffer() });
  }
  return await decompressAndVerifyOcctAsset(fetched.manifest, downloaded);
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
export function loadOcctForBrowser(): Promise<OpenCascadeInstance> {
  cached ??= (async (): Promise<OpenCascadeInstance> => {
    const gluePromise = importOcctGlue();
    const manifestPromise = fetchAssetManifest();
    const glueModule = await gluePromise;
    const fetchedManifest = await manifestPromise;
    if (!isOcctGlueModule(glueModule)) {
      throw new Error(
        `OCCT のグルーコードを読み込めませんでした(既定の書き出しが見つかりません): ${ocGlueUrl}`,
      );
    }
    if (fetchedManifest !== undefined) {
      const wasmBinary = await fetchCompressedWasm(fetchedManifest);
      return await new glueModule.default({ wasmBinary });
    }
    return await new glueModule.default({
      locateFile: (path: string): string => (path.endsWith('.wasm') ? ocWasmUrl : path),
    });
  })();
  return cached;
}
