// @ts-check
import { posix, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { FUNCTION_SIZE_BASELINE, FUNCTION_SIZE_CAP } from './eslint.functionSizeBaseline.js';
import { DEPTH_BASELINE, DEPTH_CAP, PARAMS_BASELINE, PARAMS_CAP } from './eslint.complexityBaseline.js';
import { workerReferencesConfig } from './eslint.workerReferences.js';

/**
 * 検査専用のパッケージだけは層の外側に置く。
 *
 * `@pointercad/test-utils` は性能上限の判定の切替(`expectWithinBudget`)だけを持ち、
 * 製品の実行時コードを 1 行も含まない。層(apps → ui → fem → model → kernel / expression / drawing)の
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

/** UI → model と UI → FEM → model の依存方向を機械施行する(rules/04)。 */
const layerRules = [
  { files: ['packages/expression/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  { files: ['packages/help-content/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  { files: ['packages/kernel/**/*.ts'], forbidden: ['@pointercad/*', TEST_ONLY_PACKAGE_EXCEPTION] },
  {
    files: ['packages/model/**/*.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/io', '@pointercad/help-content', '@pointercad/fem'],
  },
  {
    files: ['packages/fem/**/*.{ts,tsx}'],
    forbidden: [
      '@pointercad/ui', '@pointercad/ui/**', '@pointercad/io', '@pointercad/io/**',
      '@pointercad/help-content', '@pointercad/help-content/**',
      '@pointercad/web', '@pointercad/web/**', '@pointercad/desktop', '@pointercad/desktop/**',
      '@pointercad/apps', '@pointercad/apps/**', '**/apps/**',
      '**/ui/src/**', '**/ui/dist/**', '**/io/src/**', '**/io/dist/**',
      '**/help-content/src/**', '**/help-content/dist/**',
    ],
    // 製品は model・expression・test-utils だけを参照する（CODE.CONSISTENCY P02）。検査だけ kernel を許す:
    // 実 OCCT の検査（cadAnalysisBoundaryIdentity・curvedShellKernel）が devDependencies の kernel で形状を作るため。
    productForbidden: [
      '@pointercad/kernel', '@pointercad/kernel/**', '@pointercad/drawing', '@pointercad/drawing/**',
      '**/kernel/src/**', '**/kernel/dist/**', '**/drawing/src/**', '**/drawing/dist/**',
      'opencascade.js', 'opencascade.js/*',
    ],
  },
  {
    files: ['packages/drawing/**/*.ts'],
    forbidden: [
      '@pointercad/kernel', '@pointercad/model', '@pointercad/ui', '@pointercad/io',
      '@pointercad/help-content', 'opencascade.js', 'opencascade.js/*',
    ],
  },
  { files: ['packages/io/**/*.ts'], forbidden: ['@pointercad/ui', '@pointercad/drawing'] },
  // 検査専用の test-utils は全パッケージの devDependencies なので、他の @pointercad を実行時に参照しない（参照すると循環する）。
  // 型だけの参照は p10ModuleBoundary.test.ts の方針（型だけの model の参照は許す）に合わせて許す（CODE.CONSISTENCY P02）。
  { files: ['packages/test-utils/**/*.ts'], forbidden: ['@pointercad/*'], allowTypeImports: true },
  {
    files: ['packages/io/src/pcad/codecs/**/*.ts'],
    forbidden: ['@pointercad/ui', '@pointercad/drawing', '**/documentJson.js', '**/documentJson'],
  },
  // UI から幾何カーネルへ直接依存しない(ドキュメントモデル経由)
  { files: ['packages/ui/**/*.{ts,tsx}'], forbidden: ['@pointercad/kernel', '**/kernel/src/**', 'opencascade.js', 'opencascade.js/*'] },
  // 分割した表示・参照の処理を巨大な呼出元へ依存させない。既存の層制約も維持する。
  {
    files: reviewModuleFiles,
    forbidden: ['@pointercad/kernel', '**/kernel/src/**', 'opencascade.js', 'opencascade.js/*', '**/solidSummary.js', '**/solidSummary'],
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

// 製品の参照はidentity・世代を確認する入口を使い、採点だけの公開関数を直接使わない。
const frontendReferenceImportGuard = {
  regex: '(?:^@pointercad/model(?:/|$)|(?:^|/)model/(?:src|dist)/)',
  importNames: ['selectSubShape', 'selectMateTargetGeometry', 'rematchSubShapeRef'],
  allowTypeImports: true,
  message: '画面の参照はresolveSubShapeReference等のidentity・世代を確認する入口を使い、低水準の採点関数を直接参照しないでください。',
};

const referenceRepairFixtureImportGuard = {
  regex: '(^|/)referenceRepairFixture(?:\\.[cm]?[jt]sx?)?$',
  message: 'referenceRepairFixtureはテスト専用です。製品のコードから読み込まず、実際の文書・再計算結果を使ってください。',
};

// 追加の責務制約でも、画面から数学の計算部を呼ぶ禁止を維持する。
const uiRuntimeImportGuards = [{
  selector: "ImportExpression[source.value=/(^|\\/)referenceRepairFixture([.][cm]?[jt]sx?)?$/]",
  message: 'referenceRepairFixtureはテスト専用です。製品の画面から動的に読み込まないでください。',
}, {
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

/**
 * math-field(MathLive の構造入力の欄)への直接の .press()/.focus() を拒否する。MathLive
 * 0.110.0は焦点が入ってから約60msの間に焦点が外へ移ると欄へ戻すため、この間にキーを送ると
 * 検査が不安定になる(rules/06 §10.329)。mathEditorReady.tsのfocusFieldはこの処理の
 * 終わりを待ってから焦点を確定するので、新しい画面検査はそちらを使う。
 */
const mathFieldDirectCallGuard = {
  selector: "CallExpression[callee.property.name=/^(press|focus)$/][callee.object.callee.property.name='locator'][callee.object.arguments.0.value='math-field']",
  message: 'math-fieldへの直接の.press()/.focus()はMathLiveの焦点処理と競合します（rules/06 §10.329）。mathEditorReady.tsのfocusFieldと画面から読んだ値を使ってください。',
};

/** ブラウザー標準の窓。製品のコードでは使わない。 */
const browserDialogNames = ['confirm', 'alert', 'prompt'];
const browserDialogMessage = 'ブラウザー標準の confirm・alert・prompt はデスクトップ版で英語の OK/Cancel になります。画面の中の日本語の確認（useAppStore の requestDiscardConfirm と AppShell の DiscardConfirmDialog）か、帯の知らせ（setFileMessage）を使ってください（w91a）。';

const e2eSyntaxGuards = [{
        selector: 'CallExpression[callee.property.name="toBeVisible"] CallExpression[callee.property.name="locator"] > Literal.arguments[value=/(^| )path$/]',
        message: 'SVGの線は幅か高さが0でも描かれます。pathの面積をtoBeVisibleで判定せずexpectDrawingStrokeで実線長・線幅・表示状態を確認してください。',
      }, {
        selector: 'CallExpression[callee.name="Number"] > MemberExpression.arguments > CallExpression.object[callee.name="getComputedStyle"]',
        message: 'CSSの計算済み長さにはpx等の単位が付くため、Number.parseFloatで読む（rules/06）。',
      }, {
        selector: 'ImportDeclaration[source.value=/\\.json$/]',
        message: 'E2EのJSONはNodeのimport属性差を避けてreadFileSyncで読み、操作ラベルはuiMessageの共通入口を使ってください（rules/06 §10.91）。',
      }];

const testSyntaxGuards = [{
        selector: 'CallExpression[callee.name=/^(beforeEach|beforeAll|afterEach|afterAll)$/] > ArrowFunctionExpression.arguments[expression=true] > CallExpression.body[callee.property.name=/^mock(Clear|Reset|Restore)$/]',
        message: 'mockClear等の戻り値はmock関数です。テストhookから返すと後処理として呼ばれるため、voidのブロック本体を使ってください（rules/06 §10.67）。',
      }, {
        selector: "CallExpression[callee.callee.object.name='it'][callee.callee.property.name='each'] > ArrowFunctionExpression.arguments ForOfStatement:has(CallExpression[callee.name=/^(recomputeSheetFlat|makeSheetMetalBody)$/])",
        message: '固定面・角度等の独立したOCCTケースはit.eachの行へ展開し、1件の5秒枠へ複数の再計算を詰め込まないでください（rules/06 §10.71）。',
      }];

// no-restricted-imports covers declarations/re-exports; these also cover dynamic and type queries.
const modelFemImportGuards = [{
  selector: ':matches(ImportExpression, TSImportType)[source.value=/(^@pointercad\\/fem($|\\/)|(^|\\/)fem\\/(src|dist)\\/)/]',
  message: 'modelからFEMへの逆依存は禁止です。型もmodelの契約を使ってください（rules/04）。',
}];
const femUpperImportGuards = [{
  selector: ':matches(ImportExpression, TSImportType)[source.value=/(^@pointercad\\/(ui|io|help-content|web|desktop|apps)($|\\/)|(^|\\/)(ui|io|help-content)\\/(src|dist)\\/|(^|\\/)apps\\/)/]',
  message: 'FEMはmodelを使う計算層です。画面・アプリ・保存・ヘルプへの依存は型だけでも禁止です（rules/04）。',
}];
// FEMの製品だけ。検査は実OCCTの形状を作るためkernelを使う（layerRulesのproductForbiddenと同じ範囲）。
const femProductImportGuards = [{
  selector: ':matches(ImportExpression, TSImportType)[source.value=/(^@pointercad\\/(kernel|drawing)($|\\/)|(^|\\/)(kernel|drawing)\\/(src|dist)\\/|^opencascade\\.js($|\\/))/]',
  message: 'FEMの製品はmodel・expression・test-utilsだけを参照します。カーネル・図面の処理は動的な読込みや型でも参照しないでください（rules/04）。',
}];

/** Node組込みへのliteral参照だけをnode:表記へ統一する。非literalやrequireは判定しない。 */
/** @type {import('eslint').Rule.RuleModule} */
const nodeBuiltinPrefixRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { nodePrefix: 'Node組込み「{{name}}」はnode:前置で参照してください。' },
  },
  create(context) {
    return {
      ':matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression, TSImportType) > Literal.source'(node) {
        if (node.type !== 'Literal' || typeof node.value !== 'string') return;
        const name = node.value;
        if (!name.startsWith('node:') && isBuiltin(name)) {
          context.report({ node, messageId: 'nodePrefix', data: { name } });
        }
      },
    };
  },
};

/** 相対コード参照は.jsへ揃える。明示的な非JS資産とViteの資産queryは保つ。 */
/** @type {import('eslint').Rule.RuleModule} */
const relativeJavaScriptImportRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { jsExtension: '相対JavaScriptモジュール参照「{{name}}」は.js付きにしてください（明示.mjs/.cjsと非JS資産は対象外）。' },
  },
  create(context) {
    return {
      ':matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression, TSImportType) > Literal.source'(node) {
        if (node.type !== 'Literal' || typeof node.value !== 'string') return;
        const name = node.value;
        if (!/^\.{1,2}(?:\/|$)/.test(name)) return;
        const query = name.split('#')[0].split('?')[1];
        if (query && /(?:^|&)(?:raw|url|worker)(?:=[^&]*)?(?:&|$)/.test(query)) return;
        const pathname = name.split(/[?#]/)[0];
        const extension = posix.extname(pathname);
        if (!extension || /\.(?:ts|tsx|mts|cts|jsx)$/.test(extension) || pathname.endsWith('/')) {
          context.report({ node, messageId: 'jsExtension', data: { name } });
        }
      },
    };
  },
};

/**
 * Vitestのnamed testだけを拒否し、別名でもitを読み込む形へ統一する。
 * no-restricted-importsのpaths（importNames）では名前空間のimportとexport-fromまで拒否してしまうため、
 * 層のno-restricted-importsを上書きしない別の規則名で持つ（moduleImportStylePolicy.test.tsが境界を守る）。
 */
/** @type {import('eslint').Rule.RuleModule} */
const vitestItImportRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { useIt: 'Vitestではtestではなくitをimportしてください。' },
  },
  create(context) {
    return {
      "ImportDeclaration[source.value='vitest'] > ImportSpecifier[imported.name='test'], ImportDeclaration[source.value='vitest'] > ImportSpecifier[imported.value='test']"(node) {
        context.report({ node, messageId: 'useIt' });
      },
    };
  },
};

/** Resolve cross-package paths before applying the existing layer direction table. */
/** @type {import('eslint').Rule.RuleModule} */
const normalizedLayerImportRule = {
  meta: {
    type: 'problem',
    schema: [{ type: 'array', items: { type: 'string' }, uniqueItems: true }],
    messages: { direction: '参照「{{name}}」は正規化後の依存方向に違反しています（rules/04-設計の規律.md）。' },
  },
  create(context) {
    const file = relative(context.cwd, resolve(context.cwd, context.filename)).replaceAll('\\', '/');
    const sourcePackage = /^packages\/([^/]+)\//.exec(file)?.[1];
    const forbidden = context.options[0];
    return {
      ':matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression, TSImportType) > Literal.source'(node) {
        if (node.type !== 'Literal' || typeof node.value !== 'string') return;
        const name = node.value;
        let target = /^@pointercad\/([^/]+)(?:\/|$)/.exec(name)?.[1];
        if (/^\.{1,2}\//.test(name)) {
          const path = posix.normalize(posix.join(posix.dirname(file), name.split(/[?#]/)[0]));
          target = /^packages\/([^/]+)(?:\/|$)/.exec(path)?.[1];
          // Relative imports within the same package remain permitted.
          if (target === sourcePackage) return;
        }
        if (!target || target === 'test-utils') return;
        if (forbidden.includes('*') || forbidden.includes(target)) {
          context.report({ node, messageId: 'direction', data: { name } });
        }
      },
    };
  },
};

/** Prevent a second implementation of the adopted record predicate (CODE.CONSISTENCY P14). */
/** @type {import('eslint').Rule.RuleModule} */
const canonicalRecordPredicateRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { useCanonical: 'isRecordを再定義せず、このパッケージのvalueGuards.tsから参照してください。' },
  },
  create(context) {
    return {
      ':matches(FunctionDeclaration, FunctionExpression, VariableDeclarator)[id.name="isRecord"]'(node) {
        context.report({ node, messageId: 'useCanonical' });
      },
    };
  },
};

/**
 * 統一済みの名前の許可名簿（CODE.CONSISTENCY P02）。改名すると公開API・保存形式・i18nの鍵・data-testidが
 * 変わる名前だけを、理由とともに置く。
 */
const UNIFIED_NAME_ALLOWLIST = new Map([
  ['massTotal', '@pointercad/modelの公開型BomRowの欄（公開API。uiの部品表と図面の表が読む）'],
]);

const unifiedNamePatterns = [
  { pattern: /colour/i, messageId: 'colour' },
  { pattern: /^num[A-Z0-9]/, messageId: 'numPrefix' },
  { pattern: /[a-z0-9]Total$/, messageId: 'totalSuffix' },
];

/**
 * 名前を宣言する節の種類ごとに、その名前を持つ欄（paramsは全ての節で見る）。
 * 欄の名前（key）は計算した鍵を除く。分割代入のPropertyはdeclaresNameが束ねる側（value）だけにする。
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const DECLARING_FIELDS = {
  VariableDeclarator: ['id'], FunctionDeclaration: ['id'], FunctionExpression: ['id'], ClassDeclaration: ['id'],
  ClassExpression: ['id'], TSDeclareFunction: ['id'], TSInterfaceDeclaration: ['id'], TSTypeAliasDeclaration: ['id'],
  TSEnumDeclaration: ['id'], TSModuleDeclaration: ['id'], TSEnumMember: ['id'], TSTypeParameter: ['name'],
  AssignmentPattern: ['left'], RestElement: ['argument'], ArrayPattern: ['elements'], CatchClause: ['param'],
  TSParameterProperty: ['parameter'], ImportDefaultSpecifier: ['local'], ImportNamespaceSpecifier: ['local'],
  Property: ['key'], PropertyDefinition: ['key'], MethodDefinition: ['key'], TSAbstractPropertyDefinition: ['key'],
  TSAbstractMethodDefinition: ['key'], TSPropertySignature: ['key'], TSMethodSignature: ['key'],
};

/**
 * 識別子が新しい名前を宣言する位置にあるか。参照・メンバーの読み取り・分割代入で読む欄の名前は含めない
 * （外のAPIの名前を使う側を止めない）。
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function declaresName(node) {
  const parent = node.parent;
  if (!parent) return false;
  /** @param {string} field */
  const holds = field => {
    if (field === 'key' && Reflect.get(parent, 'computed') === true) return false;
    const value = Reflect.get(parent, field);
    return value === node || (Array.isArray(value) && value.includes(node));
  };
  if (holds('params')) return true;
  if (parent.type === 'Property' && parent.parent.type === 'ObjectPattern') return parent.value === node;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') {
    // 別名を付けた時だけ見る（外の名前をそのまま読む・公開する時は見ない）。
    const [own, outer] = parent.type === 'ImportSpecifier' ? [parent.local, parent.imported] : [parent.exported, parent.local];
    return own === node && !(outer.type === 'Identifier' && outer.name === node.name);
  }
  return (DECLARING_FIELDS[parent.type] ?? []).some(holds);
}

/** 統一済みの名前（色はcolor、件数はxxxCount、合計はtotalXxx）を新しく崩さない（CODE.CONSISTENCY P02）。 */
/** @type {import('eslint').Rule.RuleModule} */
const unifiedNameRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      colour: '色の綴りはcolorに統一しています。「{{name}}」はcolorで書いてください。',
      numPrefix: '件数はxxxCountに統一しています。「{{name}}」は…Countの形にしてください。',
      totalSuffix: '「{{name}}」のような…Totalの名前は作らず、件数はxxxCount、合計はtotalXxx（totalBytesなど）にしてください。',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (UNIFIED_NAME_ALLOWLIST.has(node.name)) return;
        const hit = unifiedNamePatterns.find(({ pattern }) => pattern.test(node.name));
        if (hit && declaresName(node)) context.report({ node, messageId: hit.messageId, data: { name: node.name } });
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const beamResultAssertionRule = {
  meta: { type: 'problem', schema: [], messages: { result: 'Assert the beam result separately to avoid deep array type expansion.' } },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'expect') return;
        const first = node.arguments[0];
        if (first?.type !== 'ArrayExpression') return;
        for (const element of first.elements) {
          const value = element?.type === 'ChainExpression' ? element.expression : element;
          if (value?.type !== 'MemberExpression') continue;
          const key = value.property;
          if ((!value.computed && key.type === 'Identifier' && key.name === 'result') ||
              (value.computed && key.type === 'Literal' && key.value === 'result')) {
            context.report({ node: value, messageId: 'result' });
          }
        }
      },
    };
  },
};

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
      // 承認済みの外部原文。変更せず、配布時に一覧・サイズ・全バイトを照合する。
      // アプリが作成する受渡し処理はpackages配下に置き、通常の検査対象を維持する。
      'vendor/exact-math/runtime/**',
      'vendor/exact-math/notices/**',
      // Pinned upstream FEM distribution; authored FEM source remains checked.
      'packages/fem/runtime/assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  workerReferencesConfig,
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...testSyntaxGuards],
    },
  },
  {
    // packages/expression の検査だけ計算部の直接起動を拒否する(rules/06 §10.323)。
    // flat configは同じfilesパターンのno-restricted-syntaxを上書きするため、上の
    // '**/*.test.{ts,tsx}' の2件をここにも複製してから3件目を足す(2026-09-24 OPS-09)。
    // packages/ui 等にも同名のspawnSync('python',…)を使う既存検査があるが、
    // exactRuntime.testSupport.tsはexpressionパッケージのexportsに公開しておらず
    // 他パッケージから使えないため、対象をexpressionだけに絞る(統括2026-09-24 08:0xの指示)。
    files: ['packages/expression/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.name=/^(beforeEach|beforeAll|afterEach|afterAll)$/] > ArrowFunctionExpression.arguments[expression=true] > CallExpression.body[callee.property.name=/^mock(Clear|Reset|Restore)$/]',
        message: 'mockClear等の戻り値はmock関数です。テストhookから返すと後処理として呼ばれるため、voidのブロック本体を使ってください（rules/06 §10.67）。',
      }, {
        selector: "CallExpression[callee.callee.object.name='it'][callee.callee.property.name='each'] > ArrowFunctionExpression.arguments ForOfStatement:has(CallExpression[callee.name=/^(recomputeSheetFlat|makeSheetMetalBody)$/])",
        message: '固定面・角度等の独立したOCCTケースはit.eachの行へ展開し、1件の5秒枠へ複数の再計算を詰め込まないでください（rules/06 §10.71）。',
      }, {
        selector: "CallExpression[callee.name='spawnSync'][arguments.0.value='python']",
        message: '計算部は exactRuntime.testSupport.ts の spawnExactRuntime で起動する（rules/06 §10.323）。',
      }],
    },
  },
  ...[
    { files: ['packages/model/**/*.ts'], guards: modelFemImportGuards, productGuards: [] },
    { files: ['packages/fem/**/*.{ts,tsx}'], guards: femUpperImportGuards, productGuards: femProductImportGuards },
  ].flatMap(/** @returns {import('typescript-eslint').FlatConfig.Config[]} */ ({ files, guards, productGuards }) => [{
    // 検査のファイルは次の塊が上書きするので、productGuardsは製品とtestSupportにだけ効く。
    files,
    rules: { 'no-restricted-syntax': ['error', ...guards, ...productGuards] },
  }, {
    files: files.map(file => file.replace('**/*.', '**/*.test.')),
    rules: { 'no-restricted-syntax': ['error', ...testSyntaxGuards, ...guards] },
  }]),
  {
    // E09: 製品の全関数は200行まで。後に続く狭い対象の厳しい上限（30〜120）はflat configの後勝ちで残る。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.testSupport.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: { 'max-lines-per-function': ['error', { max: FUNCTION_SIZE_CAP, skipBlankLines: true, skipComments: true }] },
  },
  {
    // P06: 製品の関数の引数と入れ子の上限（E09と同じ適用範囲）。既存の超過は末尾の表でファイルごとに固定する。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.testSupport.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: { 'max-params': ['error', { max: PARAMS_CAP }], 'max-depth': ['error', { max: DEPTH_CAP }] },
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
      'packages/ui/src/sketch/numericInputEvaluation.ts', 'packages/ui/src/sketch/twoPointArcInput.ts',
      'packages/ui/src/sketch/splineInputDraft.ts', 'packages/ui/src/sketch/numericInputChoices.ts',
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
      'no-restricted-syntax': ['error', ...modelFemImportGuards, {
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
      'no-restricted-syntax': ['error', ...modelFemImportGuards, {
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
      'no-restricted-syntax': ['error', ...modelFemImportGuards, {
        selector: "ImportDeclaration[source.value='@pointercad/kernel'] > ImportSpecifier[imported.name!=/^(matchFace|matchEdge|matchVertex|resolveFaceReference|resolveEdgeReference|resolveVertexReference)$/]",
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
        'max-lines-per-function': ['error', { max: FUNCTION_SIZE_CAP, skipBlankLines: true, skipComments: true }],
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 0 }],
        'no-restricted-syntax': ['error', ...modelFemImportGuards, {
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
      }, mathFieldDirectCallGuard],
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
    // 製品のコードからブラウザー標準の確認・通知・入力の窓を出さない。デスクトップ版では
    // 英語の OK/Cancel になり、日本語の画面から浮く。確認は画面の中の日本語の3択
    // (AppShell.tsx の DiscardConfirmDialog、ストアの requestDiscardConfirm)を使う。
    // no-restricted-syntax は同じファイルの他の塊が上書きするため、別の規則で拒否する。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-globals': ['error', ...browserDialogNames.map((name) => ({ name, message: browserDialogMessage }))],
      'no-restricted-properties': ['error', ...['window', 'globalThis', 'self', 'top', 'parent'].flatMap((object) =>
        browserDialogNames.map((property) => ({ object, property, message: browserDialogMessage })))],
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
      'max-lines-per-function': ['error', { max: FUNCTION_SIZE_CAP, skipBlankLines: true, skipComments: true }],
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
    files: ['packages/ui/src/sketch/numericInputChoices.ts'],
    rules: {
      'max-lines': ['error', { max: 550, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[importKind!='type'][source.value!='@pointercad/model']",
        message: '選択肢の表はmodelの定数だけを使い、入力遷移・画面・ストアの実行依存を戻さないでください（レビューF11）。',
      }, {
        selector: 'ImportExpression, ExportNamedDeclaration[source][exportKind!="type"], ExportAllDeclaration, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], FunctionExpression[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: '選択肢の表へ通信・Worker・非同期処理・別の実行処理の再公開を追加しないでください（レビューF11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/sketch/numericInputEvaluation.ts'],
    rules: {
      'max-lines': ['error', { max: 220, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[importKind!='type'][source.value!=/^(?:@pointercad\\/expression|\\.\\.\\/i18n\\/t\\.js|\\.\\/numericFieldUnits\\.js|\\.\\/numericMathValues\\.js)$/]",
        message: '入力欄の評価へ、道具の段階遷移・文書の更新・画面やストアの実行依存を戻さないでください（レビューR14/F11）。',
      }, {
        selector: 'ImportExpression, ExportNamedDeclaration[source][exportKind!="type"], ExportAllDeclaration, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: '入力欄の評価へ通信・Worker・非同期処理や他の実行処理の再公開を追加しないでください（レビューR14/F11）。',
      }],
    },
  },
  {
    files: ['packages/ui/src/sketch/twoPointArcInput.ts', 'packages/ui/src/sketch/splineInputDraft.ts'],
    rules: {
      'max-lines': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': ['error', ...uiRuntimeImportGuards, propertyPanelImportGuard, {
        selector: "ImportDeclaration[source.value!=/^(?:@pointercad\\/model|\\.\\.\\/i18n\\/t\\.js)$/]",
        message: '円弧とスプラインの下書きへ、入力状態機械・画面・ストアの依存を戻さないでください（レビューR14/F11）。',
      }, {
        selector: 'ImportExpression, ExportNamedDeclaration[source][exportKind!="type"], ExportAllDeclaration, NewExpression[callee.name="Worker"], FunctionDeclaration[async=true], ArrowFunctionExpression[async=true], CallExpression[callee.name="fetch"]',
        message: '円弧とスプラインの下書きへ通信・Worker・非同期処理を追加しないでください（レビューR14/F11）。',
      }],
    },
  },
  // E09: 上限を超える既存の関数を持つファイルは、そのファイルで最大の実測値まで（既存の上限より緩めない）。
  // 同じファイルの小さい関数の増加は functionSizePolicy.test.ts が関数ごとの値で拒否する。
  ...FUNCTION_SIZE_BASELINE.map(/** @returns {import('typescript-eslint').FlatConfig.Config} */ ({ file, functions }) => ({
    files: [file],
    rules: { 'max-lines-per-function': ['error', {
      max: Math.max(...functions.map(([, lines]) => lines)), skipBlankLines: true, skipComments: true }] },
  })),
  // P06: 上限を超える既存の関数を持つファイルは、そのファイルで最大の実測値まで（上限より緩めるのは表の行だけ）。
  // 同じファイルの小さい関数の増加は complexityPolicy.test.ts が関数ごとの値で拒否する。
  ...PARAMS_BASELINE.map(/** @returns {import('typescript-eslint').FlatConfig.Config} */ ({ file, functions }) => ({
    files: [file],
    rules: { 'max-params': ['error', { max: Math.max(...functions.map(([, count]) => count)) }] },
  })),
  ...DEPTH_BASELINE.map(/** @returns {import('typescript-eslint').FlatConfig.Config} */ ({ file, functions }) => ({
    files: [file],
    rules: { 'max-depth': ['error', { max: Math.max(...functions.map(([, depth]) => depth)) }] },
  })),
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
    // CODE.CONSISTENCY P02: 型の書き方を製品と検査で揃える。型情報を使わない規則なので、srcの外の検査（ui/integration）と設定にも掛ける。
    // オブジェクトの型はinterface。型だけのimportはimport typeにし、import()の型注釈も使わない（disallowTypeAnnotations）。
    // fixStyleは自動修正の出力だけを決める。2026-11-07の数え上げで、型だけを読む文はimport typeが4,233文・inlineのtype修飾だけの文が60文、
    // import typeの文の総数4,471がinlineのtype修飾を含む文4,194より多いのでseparate-type-imports。値と型を同じ文で読むinlineの書き方も規則は受け入れる。
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports', disallowTypeAnnotations: true, fixStyle: 'separate-type-imports' }],
    },
  },
  {
    // CODE.CONSISTENCY P02: 統一済みの名前（色はcolor、件数はxxxCount、合計はtotalXxx）を製品と検査で崩さない。
    // e2eは既存のundoTotal（e2e/tests/solid.spec.ts）を直すまで対象外。
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    plugins: { 'naming-style': { rules: { 'unified-names': unifiedNameRule } } },
    rules: { 'naming-style/unified-names': 'error' },
  },
  {
    files: ['packages/ui/src/**/*.tsx', 'apps/*/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...[
    // 個別の層制約がない製品パッケージにもfixtureの禁止を適用する。
    { files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'], forbidden: [] },
    ...layerRules,
  ].flatMap(/** @returns {import('typescript-eslint').FlatConfig.Config[]} */ ({ files, forbidden, productForbidden = [], allowTypeImports = false }) => {
    // Keep upper-layer guards even when a narrower model rule overrides this group; the rule schema requires unique group members.
    const restricted = files.every(file => file.startsWith('packages/model/'))
      ? [...new Set([...forbidden, '@pointercad/ui', '@pointercad/ui/**', '@pointercad/io', '@pointercad/io/**',
        '@pointercad/help-content', '@pointercad/help-content/**', '@pointercad/fem', '@pointercad/fem/**',
        '**/fem/src/**', '**/fem/dist/**', '**/ui/src/**', '**/ui/dist/**', '**/io/src/**', '**/io/dist/**',
        '**/help-content/src/**', '**/help-content/dist/**'])] : forbidden;
    /** @param {string[]} group */
    const layerPatterns = group => group.length === 0 ? [] : [{
      group,
      message: '依存方向 UI → model / FEM → model → kernel / expression / drawing に違反しています(rules/04-設計の規律.md)。',
      ...(allowTypeImports ? { allowTypeImports } : {}),
    }];
    const patterns = layerPatterns(restricted);
    // productForbiddenは製品（次の検査を除く塊）にだけ足す。
    const productPatterns = layerPatterns([...restricted, ...productForbidden]);
    // 混在する汎用groupはfixtureだけ。全patternがui/appsのgroupだけをfrontendとする。
    const frontend = files.every((file) => file.startsWith('packages/ui/') || file.startsWith('apps/'));
    return [{
      files,
      rules: { 'no-restricted-imports': ['error', { patterns }] },
    }, {
      files,
      ignores: ['**/*.test.ts', '**/*.test.tsx'],
      // flat configの上書きでも、元の層制約と製品専用の追加制約を同時に残す。
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [...productPatterns, referenceRepairFixtureImportGuard,
            ...(frontend ? [frontendReferenceImportGuard] : [])],
        }],
      },
    }];
  }),
  {
    // 製品の公開名を明示する。検査と設定ファイルのdefault exportは対象外にする（CODE.CONSISTENCY P02）。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.config.{ts,tsx}'],
    rules: {
      'no-restricted-exports': ['error', {
        restrictDefaultExports: {
          direct: true, named: true, defaultFrom: true, namedFrom: true, namespaceFrom: true,
        },
      }],
    },
  },
  {
    // 狭いoverrideの既存規則を置き換えない独立した表記規則。
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { 'module-style': { rules: { 'node-prefix': nodeBuiltinPrefixRule,
      'relative-js-extension': relativeJavaScriptImportRule, 'vitest-it': vitestItImportRule } } },
    rules: { 'module-style/node-prefix': 'error',
      'module-style/relative-js-extension': 'error', 'module-style/vitest-it': 'error' },
  },
  // A separate rule preserves narrower no-restricted-imports overrides.
  ...layerRules.filter(({ files }) => files.length === 1 &&
    /^packages\/(expression|kernel|drawing|model)\/[*]/.test(files[0])).map(/** @returns {import('typescript-eslint').FlatConfig.Config} */ ({ files, forbidden }) => ({
    files,
    plugins: { 'layer-boundary': { rules: { normalized: normalizedLayerImportRule } } },
    rules: { 'layer-boundary/normalized': ['error', [...new Set(forbidden
      .filter(name => name.startsWith('@pointercad/'))
      .map(name => name.slice('@pointercad/'.length).split('/')[0]))]] },
  })),
  {
    // Use a separate rule so narrower syntax overrides cannot remove this guard.
    files: ['packages/model/src/**/*.{ts,tsx}'],
    ignores: ['packages/model/src/valueGuards.ts', '**/*.test.{ts,tsx}', '**/*.testSupport.{ts,tsx}'],
    plugins: { 'record-guard': { rules: { canonical: canonicalRecordPredicateRule } } },
    rules: { 'record-guard/canonical': 'error' },
  },
  {
    files: ['packages/ui/src/beam/**/*.test.ts'],
    plugins: { 'beam-assertion': { rules: { 'separate-result': beamResultAssertionRule } } },
    rules: { 'beam-assertion/separate-result': 'error' },
  },
  {
    // P01: 配布されない作業資料へのコメント依存を再混入させない。
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}', 'e2e/tests/**/*.ts'],
    rules: { 'no-warning-comments': ['error', { terms: ['scratchpad/claude'], location: 'anywhere' }] },
  },
);
