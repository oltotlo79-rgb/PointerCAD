// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * 検査専用のパッケージだけは層の外側に置く。
 *
 * `@pointercad/test-utils` は性能上限の判定の切替(`expectWithinBudget`)だけを持ち、
 * 製品の実行時コードを 1 行も含まない。層(apps → ui → model → kernel / expression / drawing)の
 * どこからも devDependencies として参照してよいので、`@pointercad/*` を丸ごと禁じる
 * 最下層(expression / help-content / kernel)でも、これだけは除外する。
 * `!` で始まる項目は除外を表す(no-restricted-imports の group は gitignore と同じ書き方)。
 * 決定の記録は docs/plans/P6-入出力.md §0.a-0.68(利用者の承認)。
 */
const TEST_ONLY_PACKAGE_EXCEPTION = '!@pointercad/test-utils';

/** 依存方向 apps → ui → model → kernel / expression / drawing を機械施行する(rules/04)。 */
const layerRules = [
  { files: ['packages/expression/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  { files: ['packages/help-content/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  { files: ['packages/kernel/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  {
    files: ['packages/model/**/*.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content'],
  },
  {
    files: ['packages/drawing/**/*.ts'],
    forbidden: [
      '@pointercad/kernel', '@pointercad/model', '@pointercad/ui', '@pointercad/io',
      '@pointercad/help-content', 'opencascade.js', 'opencascade.js/*',
    ],
  },
  { files: ['packages/io/**/*.ts'], forbidden: ['@pointercad/ui', '@pointercad/drawing'] },
  // UI から幾何カーネルへ直接依存しない(ドキュメントモデル経由)
  { files: ['packages/ui/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
  { files: ['apps/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // apps/* の型出力先(tsconfig の outDir)。生成物なので点検の対象にしない。
      '**/dist-types/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // 担当が置く一時のもの(組み立ての出力・撮った画面)。製品のコードではないので見ない。
      // `eslint .` が生成物で落ちるのを防ぐ(docs/報告記録.md 2026-09-06 14:2x・15:5x)。
      'scratchpad/**',
      'shots/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.name="Number"] > MemberExpression.arguments > CallExpression.object[callee.name="getComputedStyle"]',
        message: 'CSSの計算済み長さにはpx等の単位が付くため、Number.parseFloatで読む（rules/06）。',
      }],
    },
  },
  {
    // 型情報を使うルールはソースとテストにだけ適用する。
    // 設定ファイル(*.config.ts)は projectService の対象外なので型情報なしのルールだけが効く。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['packages/ui/src/**/*.tsx', 'apps/*/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...layerRules.map(({ files, forbidden }) => ({
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: forbidden,
              message:
                '依存方向 apps → ui → model → kernel / expression / drawing に違反しています(rules/04-設計の規律.md)。',
            },
          ],
        },
      ],
    },
  })),
);
