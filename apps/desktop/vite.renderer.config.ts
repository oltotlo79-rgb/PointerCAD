import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { defineConfig } from 'vite';
import { APP_META_CONTENT_SECURITY_POLICY, FEM_WORKER_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { desktopAppContentSecurityPolicy } from './src/occtHttpPolicy.js';
import { parseOcctAssetManifest } from '../../packages/kernel/src/occt/occtAssetManifest.js';
import { runtimeNotices } from '../../scripts/vite/runtimeNotices.mjs';
import { mathNotices } from '../../scripts/vite/mathNotices.mjs';
import { exactMathAssets } from '../../scripts/vite/exactMathAssets.mjs';
import { femRuntimeAssets } from '../../scripts/vite/femRuntimeAssets.mjs';
import { startupGuard } from '../../scripts/vite/startupGuard.mjs';

/** WASM の並列実行に必要な隔離状態を作る(FR-1003)。配信時は app:// の応答ヘッダーで付ける。 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * 出力の分け方(P5 §5.1「主チャンク 500kB 未満」、NFR-PF-5)。
 *
 * **`apps/web/vite.config.ts` と同じ分け方。片方だけ変えると Web とデスクトップで
 * 塊が食い違うので両方を同時に直す。** 画面そのもの(`packages/ui`)は 2 つの版で
 * 同じものを使うので(要件§1.5、機能差を作らない)、出来上がる塊も揃えておく。
 *
 * **後から読むもの(3D 表示・幾何カーネル)はここで名前を付けない。** 名前を付けると
 * その一群が 1 つの塊になり、起動時から読む側と混ざった瞬間に**全部が起動時に読まれる**。
 * だから `three` と `opencascade.js` は素通しにして、`ViewportCanvas` の `lazy` と
 * Worker の中の `import()` が作る塊のままにする。
 *
 * ここで名前を付けるのは、**起動時に必ず要るが、他のどこからも呼び返されないもの**だけ
 * (依存が一方向に閉じているもの)。輪(循環)をまたいで塊を割ると、読み込みの順番が
 * 変わって初期化の途中の値を見てしまうことがあるため、輪の内側(`packages/ui/src` の
 * shell / sketch / solid は互いを呼び合う)は割らない。
 *
 * 分けたものは起動時に**並列で**読まれるので、読む総量は変わらない。塊は `base: './'`
 * の相対の場所で書き出され、独自スキーム app://(標準スキームとして登録済み、
 * `src/main/appProtocol.ts`)の下でも正しく解決される。
 */
function manualChunks(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');

  // Vite shares this helper with the editor. Keep it outside pcad-core, otherwise
  // the bootstrap entry would statically require the very asset it must recover.
  if (id === '\0vite/preload-helper.js') return 'bootstrap-loader';

  if (path.includes('/node_modules/')) {
    // 画面の土台。版が上がるまで中身が変わらないので、控えが効きやすい。
    if (/\/node_modules\/(?:react-dom|react|scheduler|zustand)\//.test(path)) {
      return 'vendor-react';
    }
    // 下流の一群だけが使う外部の部品なので、下流と同じ塊に置く。
    // decimal.js は式の任意精度、fflate は `.pcad` の圧縮、comlink は Worker との往復。
    if (/\/node_modules\/(?:decimal\.js|fflate|comlink)\//.test(path)) {
      return 'pcad-core';
    }
    // three.js と opencascade.js はここへ来る。名前を付けない(上の理由)。
    return undefined;
  }

  // 文言の表(`i18n/ja/*.json` と、それを 1 つに合わせる `i18n/ja.ts`。P6 タスク52 で
  // 機能ごとに分けた)。何も読み込まない葉なので、単独の塊にしても順番の心配がない。
  // **合わせる側もここへ入れる**(理由は apps/web/vite.config.ts と同じ)。
  if (path.includes('/packages/ui/src/i18n/ja/') || path.endsWith('/packages/ui/src/i18n/ja.ts')) {
    return 'messages';
  }
  // アイコンはインライン SVG の塊で、これも何も読み込まない葉(icons.tsx の冒頭の注釈)。
  if (path.endsWith('/packages/ui/src/shell/icons.tsx')) {
    return 'icons';
  }
  // 部品の解決・式・カーネルの口・`.pcad` の読み書き。依存方向は
  // ui → model → kernel / expression の一方向なので(rules/04)、ui から見ると
  // 呼び返しの無い下流にあたる。
  if (/\/packages\/(?:model|expression|kernel|drawing|io)\//.test(path)) {
    return 'pcad-core';
  }

  return undefined;
}

// Resolve the same installed package that supplies the direct ?url asset.
// Vite inherits define in Worker builds, so both owners verify the same bytes.
const occtBytes = readFileSync(new URL('../../packages/kernel/node_modules/opencascade.js/dist/opencascade.full.wasm', import.meta.url));
const occtSha256 = createHash('sha256').update(occtBytes).digest('hex');

/** Package compression once; neither cold nor warm application startup compresses WASM. */
export function desktopOcctAssets(bytes: Uint8Array) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const compressed = gzipSync(bytes);
  const partFile = `opencascade.full-${sha256.slice(0, 16)}.bin`;
  const streamFile = `stream/opencascade.full-${sha256}.wasm`;
  const manifest = parseOcctAssetManifest({
    sha256, byteLength: bytes.byteLength, compression: 'gzip',
    parts: [{ order: 0, file: partFile, byteLength: compressed.byteLength }],
    stream: { file: streamFile, compression: 'gzip', transportByteLength: compressed.byteLength,
      transportSha256: createHash('sha256').update(compressed).digest('hex'),
      decodedByteLength: bytes.byteLength, decodedSha256: sha256 },
  });
  return { manifest, compressed, partFile, streamFile };
}

export default defineConfig({
  define: {
    __PCAD_DESKTOP_OCCT_IDENTITY__: JSON.stringify({
      sha256: occtSha256, byteLength: occtBytes.byteLength,
    }),
  },
  // 資産の場所を相対で書き出す。独自スキーム app:// の下でも正しく解決される。
  base: './',
  // Webと同じ字体を通常の静的資産として配り、JSへバイト列を埋め込まない。
  publicDir: 'resources',
  plugins: [react(), mathNotices(), runtimeNotices(), exactMathAssets(), femRuntimeAssets(FEM_WORKER_CONTENT_SECURITY_POLICY), startupGuard(), {
    name: 'pointercad-desktop-occt-gzip',
    apply: 'build',
    generateBundle() {
      const asset = desktopOcctAssets(occtBytes);
      this.emitFile({ type: 'asset', fileName: `occt/${asset.partFile}`, source: asset.compressed });
      this.emitFile({ type: 'asset', fileName: `occt/${asset.streamFile}`, source: asset.compressed });
      this.emitFile({ type: 'asset', fileName: 'occt/manifest.json', source: JSON.stringify(asset.manifest) });
    },
  }, {
    name: 'pointercad-renderer-security-policy',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: () => [{
      tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: desktopAppContentSecurityPolicy(APP_META_CONTENT_SECURITY_POLICY) },
      injectTo: 'head-prepend',
    }] },
  }],
  // Emscripten のグルーコードを事前バンドルさせない。Node 専用の分岐が含まれるため。
  optimizeDeps: { exclude: ['opencascade.js'] },
  // 幾何カーネルの Worker は ES モジュールとして出力する。
  // Worker の中で実行時 import() を使うため(packages/kernel/src/occt/loadOcct.browser.ts)。
  worker: { format: 'es' },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    // 50MB の WASM が誤って埋め込まれないよう、資産の埋め込みを無効にする。
    assetsInlineLimit: 0,
    // 主チャンクを 500kB 未満に保つ(P5 §5.1)。分け方の理由は上の manualChunks にある。
    rollupOptions: { output: { manualChunks } },
  },
  server: { headers: crossOriginIsolationHeaders },
});
