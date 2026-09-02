import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 50MB 超の WASM のコンパイルに時間がかかる(opencascade.js の既知の性質)。
    // 上限を短くすると環境差で不安定になるため長めに取る。
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // OCCT を1プロセスに1インスタンスだけ作って共有する。
    // Vitest 4 で test.poolOptions は廃止され、上位の項目へ移された。
    // 旧 poolOptions.forks.singleFork の代わりが fileParallelism: false で、
    // 同時に動く worker を1つに固定しテストファイルを順番に実行する。
    pool: 'forks',
    fileParallelism: false,
    // Vitest 4 の既定の表示は、端末以外(パイプ・リダイレクト・CI)へ出すとき
    // テストごとの console 出力を省く。OCCT の初期化時間を必ず記録に残すため、
    // 出力の形式を明示する。
    reporters: ['default'],
  },
});
