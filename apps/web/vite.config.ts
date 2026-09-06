import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** WASM の並列実行に必要な隔離状態を作る(FR-1003)。開発時も配信時と同じ条件にする。 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * 出力の分け方(P5 §5.1「主チャンク 500kB 未満」、NFR-PF-5)。
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
 * 分けたものは起動時に**並列で**読まれるので、読む総量は変わらない。効くのは
 * 「1 本の巨大なファイルにしない」ことと、次の版で変わっていない塊がブラウザの
 * 控えから使えること(NFR-PF-5 の「2 回目 3 秒」)。
 */
function manualChunks(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');

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
  // **合わせる側もここへ入れる。** 分けた JSON だけを名前付きの塊にすると、合わせる
  // 1 行だけが起動時の塊に残り、塊をまたぐ参照が 9 本に増えるため。
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

export default defineConfig({
  plugins: [react()],
  // Emscripten のグルーコードを事前バンドルさせない。Node 専用の分岐が含まれるため。
  optimizeDeps: { exclude: ['opencascade.js'] },
  // 幾何カーネルの Worker は ES モジュールとして出力する。
  // Worker の中で実行時 import() を使うため(packages/kernel/src/occt/loadOcct.browser.ts)。
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    // 50MB の WASM が誤って埋め込まれないよう、資産の埋め込みを無効にする。
    assetsInlineLimit: 0,
    // 主チャンクを 500kB 未満に保つ(P5 §5.1)。分け方の理由は上の manualChunks にある。
    rollupOptions: { output: { manualChunks } },
  },
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
});
