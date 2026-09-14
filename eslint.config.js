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

const reviewModuleFiles = [
  'packages/ui/src/solid/referenceSummary.ts',
  'packages/ui/src/solid/solidReferenceNames.ts',
  'packages/ui/src/solid/springPropertyUpdates.ts',
  'packages/ui/src/solid/holeThreadPropertyUpdates.ts',
  'packages/ui/src/solid/chamferPropertyUpdates.ts',
  'packages/ui/src/solid/surfacePropertyUpdates.ts',
  'packages/ui/src/solid/solidLabels.ts',
  'packages/ui/src/solid/solidHistoryState.ts',
  'packages/ui/src/solid/treeSummary.ts',
  'packages/ui/src/solid/solidPropertyContracts.ts',
  'packages/ui/src/solid/solidPropertyFields.ts',
];

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
  {
    files: ['packages/io/src/pcad/codecs/**/*.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/drawing', '**/documentJson.js', '**/documentJson'],
  },
  // UI から幾何カーネルへ直接依存しない(ドキュメントモデル経由)
  { files: ['packages/ui/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
  // 分割した表示・参照の処理を巨大な呼出元へ依存させない。既存の層制約も維持する。
  {
    files: reviewModuleFiles,
    forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*', '**/solidSummary.js', '**/solidSummary'],
  },
    {
      files: ['packages/model/src/part/solidSketchReferences.ts'],
      forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content', '**/resolvePart.js', '**/resolvePart'],
    },
    {
      files: ['packages/model/src/part/solidPlanKey*.ts'],
      forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content', '@pointercad/kernel',
        'comlink', 'opencascade.js', 'opencascade.js/*'],
    },
  {
    files: ['packages/model/src/kernelBridge/*Conversions.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content', '**/kernelBridge.js', '**/kernelBridge'],
  },
  {
    files: ['packages/model/src/kernelBridge/subShapeMatching.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content', 'comlink',
      '**/kernelBridge.js', '**/kernelBridge', 'opencascade.js', 'opencascade.js/*'],
  },
  { files: ['apps/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', 'opencascade.js', 'opencascade.js/*'] },
];

// 追加の責務制約でも、画面から数学の計算部を呼ぶ禁止を維持する。
const uiRuntimeImportGuards = [{
  selector: "ImportDeclaration[importKind!='type'][source.value=/^@pointercad\\/expression\\/math\\/(worker|geometry)$/]",
  message: '画面の実行時は数学のcontracts/client入口を使い、計算処理はWorkerへ依頼してください。型だけならimport typeを使います（レビューF09）。',
}, {
  selector: "ImportExpression[source.value=/^@pointercad\\/expression\\/math\\/(worker|geometry)$/]",
  message: '画面から数学の計算部を動的に読み込まず、計算Workerへ依頼してください（レビューF09）。',
}, {
  selector: ":matches(ExportNamedDeclaration, ExportAllDeclaration)[exportKind!='type'][source.value=/^@pointercad\\/expression\\/math\\/(worker|geometry)$/]",
  message: '画面用の入口から数学の計算部を再公開せず、通信に必要な型だけを公開してください（レビューF09）。',
}];

const propertyPanelImportGuard = {
  selector: ':matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression)[source.value=/PropertyPanel(\\.js)?$/]',
  message: '外観・測定・入力単位の担当モジュールから大きなプロパティパネルを参照し直さないでください（レビューR14/F11）。',
};

const e2eSyntaxGuards = [{
        selector: 'CallExpression[callee.name="Number"] > MemberExpression.arguments > CallExpression.object[callee.name="getComputedStyle"]',
        message: 'CSSの計算済み長さにはpx等の単位が付くため、Number.parseFloatで読む（rules/06）。',
      }, {
        selector: 'ImportDeclaration[source.value=/\\.json$/]',
        message: 'E2EのJSONはNodeのimport属性差を避けてreadFileSyncで読み、操作ラベルはuiMessageの共通入口を使ってください（rules/06 §10.91）。',
      }];

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
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.name=/^(beforeEach|beforeAll|afterEach|afterAll)$/] > ArrowFunctionExpression.arguments[expression=true] > CallExpression.body[callee.property.name=/^mock(Clear|Reset|Restore)$/]',
        message: 'mockClear等の戻り値はmock関数です。テストhookから返すと後処理として呼ばれるため、voidのブロック本体を使ってください（rules/06 §10.67）。',
      }, {
        selector: "CallExpression[callee.callee.object.name='it'][callee.callee.property.name='each'] > ArrowFunctionExpression.arguments ForOfStatement:has(CallExpression[callee.name=/^(recomputeSheetFlat|makeSheetMetalBody)$/])",
        message: '固定面・角度等の独立したOCCTケースはit.eachの行へ展開し、1件の5秒枠へ複数の再計算を詰め込まないでください（rules/06 §10.71）。',
      }],
    },
  },
  {
    files: ['packages/io/src/pcad/documentJson.ts', 'packages/io/src/pcad/codecs/**/*.ts'],
    rules: {
      // R14: 新しいフィーチャーは担当codecへ追加し、入口や1関数への再集中を検出する。
      'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: [...reviewModuleFiles, 'packages/model/src/part/solidSketchReferences.ts'],
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: [...reviewModuleFiles, 'packages/model/src/part/solidSketchReferences.ts',
      'packages/model/src/kernelBridge/*Conversions.ts',
      'packages/ui/src/appearance/AppearanceMenu.tsx', 'packages/ui/src/appearance/AppearanceSection.tsx',
      'packages/ui/src/appearance/appearancePropertyValues.ts', 'packages/ui/src/shell/propertyFieldUnits.ts',
      'packages/ui/src/sketch/numericFieldUnits.ts', 'packages/ui/src/sketch/numericInputTools.ts',
      'packages/ui/src/solid/MeasurementSections.tsx', 'packages/ui/src/solid/measureFormatting.ts',
      'packages/ui/src/solid/SectionViewSection.tsx',
      'packages/ui/src/solid/SelectionSetSection.tsx',
      'packages/ui/src/sketch/CanvasSection.tsx',
      'packages/ui/src/solid/PrintCheckSection.tsx',
      'packages/ui/src/sketch/InferConstraintsSection.tsx',
      'packages/ui/src/shell/propertySectionText.ts'],
    rules: { 'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }] },
  },
  {
    files: ['packages/model/src/kernelBridge/*Conversions.ts'],
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', {
        selector: "ImportDeclaration[source.value='@pointercad/kernel'][importKind!='type']",
        message: '依頼・結果の変換はkernelの型だけを参照し、カーネルの実行を通信の入口へ残してください（レビューF08）。',
      }, {
        selector: "ImportDeclaration[source.value='comlink'], ImportExpression, AwaitExpression, FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], FunctionExpression[async=true]",
        message: '変換処理へ非同期ジョブや通信を戻さず、Workerの寿命・中止・失敗を所有する入口へ置いてください（レビューF08）。',
      }, {
        selector: 'NewExpression[callee.name=/^(Worker|SharedWorker|MessageChannel)$/]',
        message: '依頼・結果の変換ではWorkerや通信ポートを作成しないでください（レビューF08）。',
      }],
    },
  },
  {
    files: ['packages/model/src/kernelBridge/*Contracts.ts'],
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', {
        selector: "ImportDeclaration[importKind!='type']",
        message: 'カーネルとの契約は型だけを参照し、変換や通信の実行処理を持たせないでください（レビューF08）。',
      }, {
        selector: 'FunctionDeclaration, ClassDeclaration, VariableDeclaration',
        message: 'カーネルとの契約へ実行処理を戻さず、変換・通信の担当モジュールへ置いてください（レビューF08）。',
      }],
    },
  },
    {
      files: ['packages/model/src/kernelBridge/subShapeMatching.ts'],
      rules: {
      'max-lines': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }],
      'no-restricted-syntax': ['error', {
        selector: "ImportDeclaration[source.value='@pointercad/kernel'] > ImportSpecifier[imported.name!=/^(matchFace|matchEdge|matchVertex)$/]",
        message: '部分形状の照合は既存の採点関数だけを使い、形状生成やWorkerの実行を持ち込まないでください（レビューF08）。',
      }, {
        selector: "ImportDeclaration[source.value='@pointercad/kernel'] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)",
        message: '部分形状の照合では採点関数を明示し、カーネルの一括参照を使わないでください（レビューF08）。',
      }, {
        selector: 'ImportExpression, AwaitExpression, FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], FunctionExpression[async=true], NewExpression[callee.name=/^(Worker|SharedWorker|MessageChannel)$/]',
        message: '部分形状の照合は同期の純粋な処理を保ち、通信やWorkerの寿命を管理しないでください（レビューF08）。',
      }],
      },
    },
    {
      files: ['packages/model/src/part/solidPlanKey*.ts'],
      rules: {
        'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
        'max-lines-per-function': ['error', { max: 260, skipBlankLines: true, skipComments: true }],
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }],
        'no-restricted-syntax': ['error', {
          selector: ":matches(ImportDeclaration[importKind!='type'], ExportNamedDeclaration[exportKind!='type'], ExportAllDeclaration[exportKind!='type'])[source.value=/resolvePart/]",
          message: 'キャッシュの鍵は解決済みの型だけを参照し、履歴の再計算を呼び戻さないでください（レビューF11）。',
        }, {
          selector: 'ImportExpression, AwaitExpression, FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], FunctionExpression[async=true], NewExpression[callee.name=/^(Worker|SharedWorker|MessageChannel)$/]',
          message: '鍵の変換に通信や形状計算を混ぜず、解決済みの入力から同期して材料を作ってください（レビューF11）。',
        }],
      },
    },
  {
    files: ['packages/kernel/src/occt/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.name="keep"] > CallExpression.arguments[callee.property.name="get"]',
        message: 'OCCT Handle.get()は借用です。keep(handle)で所有者を保持し、borrowHandle(handle)でdeleteを持たない参照を読んでください（rules/06 §10.91）。',
      }, {
        selector: 'CallExpression[callee.property.name="keep"] > CallExpression.arguments[callee.property.name="get"]',
        message: 'OCCT Handle.get()の借用先を解放一覧へ登録しないでください。borrowHandleを使います（rules/06 §10.91）。',
      }],
    },
  },
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...e2eSyntaxGuards],
    },
  },
  {
    files: ['e2e/tests/**/*.ts'],
    ignores: ['e2e/tests/recompute.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...e2eSyntaxGuards, {
        selector: 'CallExpression[callee.property.name="poll"] :matches(MemberExpression[property.name=/^(requestedGeneration|completedGeneration|lastOutcome|isComputing)$/], CallExpression[callee.name="readRecomputeStats"])',
        message: '再計算の待機はrecompute.tsの共通関数を使い、世代・結末・有限上限を個別に作り直さないでください。',
      }],
    },
  },
  {
    files: ['packages/ui/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/*.worker.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards],
    },
  },
  {
    files: [
      'packages/ui/src/appearance/AppearanceMenu.tsx',
      'packages/ui/src/appearance/AppearanceSection.tsx',
      'packages/ui/src/solid/MeasurementSections.tsx',
      'packages/ui/src/solid/SectionViewSection.tsx',
      'packages/ui/src/solid/SelectionSetSection.tsx',
      'packages/ui/src/sketch/CanvasSection.tsx',
      'packages/ui/src/solid/PrintCheckSection.tsx',
      'packages/ui/src/sketch/InferConstraintsSection.tsx',
      'packages/ui/src/shell/propertySectionText.ts',
      'packages/ui/src/appearance/appearancePropertyValues.ts',
      'packages/ui/src/shell/propertyFieldUnits.ts',
      'packages/ui/src/sketch/numericFieldUnits.ts',
    ],
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard],
    },
  },
  {
    files: ['packages/ui/src/shell/propertySectionText.ts'],
    rules: {
      'max-lines': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[source.value!='../i18n/t.js'], ImportExpression, ExportNamedDeclaration[source], ExportAllDeclaration",
        message: '件数の表示は文言だけを参照し、画面・ストア・計算の実行処理を戻さないでください（レビューF11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/sketch/numericInputTools.ts'],
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 30, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, {
        selector: 'ImportDeclaration, ImportExpression, ExportNamedDeclaration[source], ExportAllDeclaration',
        message: '道具と入力段の契約へ状態機械・画面・ストア等の依存を戻さないでください（レビューR14/F11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/appearance/appearancePropertyValues.ts', 'packages/ui/src/sketch/numericFieldUnits.ts',
      'packages/ui/src/solid/measureFormatting.ts'],
    rules: {
      'max-lines': ['error', { max: 180, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[importKind!='type'][source.value!=/^@pointercad\\/(expression|model)$/]",
        message: '値・単位の純粋な処理へReact・ストア・入力状態機械の実行依存を戻さないでください（レビューR14/F11）。',
      }, {
        selector: 'ImportExpression, ExportNamedDeclaration[source][exportKind!="type"], ExportAllDeclaration',
        message: '値・単位の純粋な処理へ動的読込や別モジュールの実行処理の再公開を加えないでください（レビューR14/F11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/sketch/numericInputPresentation.ts'],
    rules: {
      'max-lines': ['error', { max: 180, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[source.value!=/^(?:@pointercad\\/model|\\.\\.\\/i18n\\/t\\.js|\\.\\/numericFieldUnits\\.js|\\.\\/numericInputTools\\.js)$/]",
        message: '入力表示の札と値の整形へ、入力状態機械・文書の更新・画面やストアの依存を戻さないでください（レビューR14/F11）。',
      }, {
        selector: 'ImportExpression, ExportNamedDeclaration[source][exportKind!="type"], ExportAllDeclaration',
        message: '入力表示の担当へ動的読込や他の実行処理の再公開を戻さないでください（レビューR14/F11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/solid/solidReferenceNames.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, {
        selector: "ImportDeclaration[importKind!='type'][source.value!=/^(@pointercad\\/model|\\.\\.\\/sketch\\/featureSummary\\.js)$/]",
        message: '参照名の変換はモデルと点の表示だけを使い、通信・入力状態へ依存しません。',
      }, {
        selector: 'ImportExpression, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: '参照名の変換へ通信・Worker・非同期処理を追加しません。',
      }],
    },
  },
  {
    files: ['packages/ui/src/solid/springPropertyUpdates.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, {
        selector: "ImportDeclaration[importKind!='type'][source.value!=/^\\.\\/springExpressions\\.js$/]",
        message: 'ばねの値更新は共通のばね式だけを使い、表示・通信・入力状態へ依存しません。',
      }, {
        selector: 'ImportExpression, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: 'ばねの値更新へ通信・Worker・非同期処理を追加しません。',
      }],
    },
  },
  {
    files: ['packages/ui/src/solid/holeThreadPropertyUpdates.ts', 'packages/ui/src/solid/chamferPropertyUpdates.ts',
      'packages/ui/src/solid/surfacePropertyUpdates.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, {
        selector: "ImportDeclaration[importKind!='type'][source.value!=/^@pointercad\\/(model|expression)$/]",
        message: '穴・ねじ・面取り・曲面の値更新は式とモデルだけを使い、表示・通信・入力状態へ依存しません。',
      }, {
        selector: 'ImportExpression, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: '穴・ねじ・面取り・曲面の値更新へ通信・Worker・非同期処理を追加しません。',
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
