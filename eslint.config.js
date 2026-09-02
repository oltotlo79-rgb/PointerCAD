// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** 依存方向 apps → ui → model → kernel / expression を機械的に守らせる(rules/04-設計の規律.md)。 */
const layerRules = [
  { files: ['packages/expression/**/*.ts'], forbidden: ['@pointercad/*'] },
  { files: ['packages/help-content/**/*.ts'], forbidden: ['@pointercad/*'] },
  { files: ['packages/kernel/**/*.ts'], forbidden: ['@pointercad/*'] },
  {
    files: ['packages/model/**/*.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/drawing', '@pointercad/io', '@pointercad/help-content'],
  },
  { files: ['packages/drawing/**/*.ts'], forbidden: ['@pointercad/ui', '@pointercad/io'] },
  { files: ['packages/io/**/*.ts'], forbidden: ['@pointercad/ui', '@pointercad/drawing'] },
  // UI から幾何カーネルへ直接依存しない(ドキュメントモデル経由)
  { files: ['packages/ui/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
  { files: ['apps/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
                '依存方向 apps → ui → model → kernel / expression に違反しています(rules/04-設計の規律.md)。',
            },
          ],
        },
      ],
    },
  })),
);
