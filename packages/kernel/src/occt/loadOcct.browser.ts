import ocGlueUrl from 'opencascade.js/dist/opencascade.full.js?url';
import ocWasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

/**
 * Emscripten が出力したグルーコードのファクトリ。
 * opencascade.js の dist/index.js が `new mainJS({ locateFile })` として呼んでいる形に合わせる。
 */
type OcctModuleFactory = new (moduleOptions: {
  locateFile(path: string): string;
}) => Promise<OpenCascadeInstance>;

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
    const glueModule: unknown = await import(/* @vite-ignore */ ocGlueUrl);
    if (!isOcctGlueModule(glueModule)) {
      throw new Error(
        `OCCT のグルーコードを読み込めませんでした(既定の書き出しが見つかりません): ${ocGlueUrl}`,
      );
    }
    return await new glueModule.default({
      locateFile: (path: string): string => (path.endsWith('.wasm') ? ocWasmUrl : path),
    });
  })();
  return cached;
}
