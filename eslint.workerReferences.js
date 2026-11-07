// @ts-check
/**
 * コードに作業資料の置き場（scratchpad/claude）への参照と、作業担当の識別子を書かない規則（コード規約 P01）。
 * 作業資料は Git に無いので、取り出した写し・CI・利用者からは辿れない。出典は公開される docs の文書名・
 * rules/06 の節番号・要件の番号で書き、担当の識別子（cl-v103-…・cx-v103-…・cx-mc23-…・w87a など）は説明の文に直す。
 *
 * 見る所: コメント（context.sourceCode.getAllComments()）、文字列のリテラル、正規表現のリテラル（`\/` は `/` として読む）、
 * テンプレートリテラルの文字の部分、JSX の文字。識別子の名前は見ない。
 *
 * WORKER_REFERENCE_ALLOWLIST は、消すと動作か凍結された検査の期待値が変わる箇所だけを、ファイル・文字列・件数・理由で
 * 固定する。件数は下げることだけができる: 実物の件数が名簿と違えば（増えても減っても）そのファイルの先頭で報告する。
 * 名簿の文字列と一致した部分だけを除いて見るので、同じ文字列・コメントの中の別の参照は報告される。
 * 適用範囲は WORKER_REFERENCE_FILES（packages・apps・e2e の .ts/.tsx）。
 */

/** 担当の識別子と作業資料の置き場の型（調査 gap-report の正規表現に、cx-mc23-… などの Codex の名前の型を加えた）。 */
export const WORKER_REFERENCE_PATTERNS = [
  // 作業資料の置き場。区切りは / と \（Windows のパス）の両方。
  /scratchpad[\\/]+claude/giu,
  // cl-v103-…・cx-v103-…・cx-p1…・cx-mc23-…・cx-gr09-…・cx-f01r-…・cx-ops01b-…・cx-t03 など（英字の後に数字の付く名前）。
  /\b(?:cl|cx)-[a-z]+\d+[a-z0-9]*\b/gu,
  // w87a・w91a・w1d・w2c-… など（w、数字 1〜3 桁、英字 1 つ）。
  /\bw\d{1,3}[a-z]\b/gu,
];

/** 適用するファイル（eslint.config.js が files に使う）。 */
export const WORKER_REFERENCE_FILES = ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}'];

const G3192_TRANSCRIPT = 'scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json';

/**
 * 許可名簿。file はリポジトリの根からの相対パス（/ 区切り）、text は除く文字列、count はそのファイルの
 * コメント・文字列に現れる text の数（ちょうど一致を求める）。
 * @type {ReadonlyArray<{ readonly file: string, readonly text: string, readonly count: number, readonly reason: string }>}
 */
export const WORKER_REFERENCE_ALLOWLIST = [
  {
    file: 'packages/model/src/assembly/standard/sections.ts', text: G3192_TRANSCRIPT, count: 22,
    reason: '山形鋼 14 行・溝形鋼 8 行の note。steelHBeamOracle.test.ts の「retains pre-W7 sections.ts content」が'
      + 'H 形鋼の行を除く全文のハッシュで凍結しているため（消すにはハッシュの更新の判断が要る）',
  },
  {
    file: 'packages/model/src/assembly/standard/steelAngleChannelOracle.fixture.ts', text: G3192_TRANSCRIPT, count: 1,
    reason: 'SECTION_ADDITION_TRANSCRIPT。steelHBeamOracle.test.ts の「preserves the frozen W6d fixture」が'
      + 'ファイル全体のハッシュで凍結しているため',
  },
  {
    file: 'packages/model/src/assembly/standard/steelCatalog.ts', text: G3192_TRANSCRIPT, count: 2,
    reason: 'ssAngleDraft・ssChannelDraft の locator。steelAngleChannelOracle.test.ts が凍結された '
      + 'SECTION_ADDITION_TRANSCRIPT を locator に含むことを求めるため',
  },
  {
    file: 'packages/model/src/assembly/standard/steelS45cOracle.testSupport.ts', text: 'cl-v103-gap-ex03-steel', count: 1,
    reason: '冒頭のコメント。steelAngleChannelOracle.test.ts の「retains the frozen W1/W4b/W5 bytes」が'
      + 'ファイル全体のハッシュで凍結しているため',
  },
  {
    file: 'e2e/tests/memoryHighwaterFlow.ts', text: 'scratchpad/claude/inspections', count: 1,
    reason: '実行時に使う。GPU の使用量の記録を読む検査が、記録のファイルをこのフォルダーの下に限る（動作を変えない）',
  },
  {
    file: 'e2e/release/offlineCandidateServer.ts',
    text: 'scratchpad/claude/agents/cx-v103-consistency-sol-20261026/w21-test-fixture/', count: 1,
    reason: '実行時に使う。W21 の検査用の原票のパスを正規表現で固定している（動作を変えない）',
  },
];

/**
 * @param {string} cwd
 * @param {string} filename
 * @returns {string}
 */
function repositoryPath(cwd, filename) {
  const normalizedCwd = cwd.replaceAll('\\', '/').replace(/\/+$/u, '');
  const normalizedFile = filename.replaceAll('\\', '/');
  const prefix = normalizedCwd + '/';
  return normalizedFile.toLowerCase().startsWith(prefix.toLowerCase()) ? normalizedFile.slice(prefix.length) : normalizedFile;
}

/**
 * 文の中の参照を、名簿の文字列を除いてから探す。
 * @param {string} text
 * @param {readonly string[]} allowed
 * @returns {string[]}
 */
export function findWorkerReferences(text, allowed = []) {
  let rest = text;
  for (const item of allowed) rest = rest.split(item).join(' ');
  /** @type {string[]} */
  const found = [];
  for (const pattern of WORKER_REFERENCE_PATTERNS) {
    for (const match of rest.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

/** @type {import('eslint').Rule.RuleModule} */
const noWorkerReferencesRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      reference: 'コードに作業資料の置き場や担当の識別子「{{text}}」を書かないでください。出典は公開される docs の文書名・'
        + 'rules/06 の節番号・要件の番号で書き、担当の識別子は説明の文に直してください（コード規約 P01、eslint.workerReferences.js）。',
      allowlistCount: '許可名簿の「{{text}}」は {{expected}} 件ですが、このファイルには {{actual}} 件あります。'
        + '増やさず、減らしたら eslint.workerReferences.js の件数を実物へ下げてください（0 件なら行を消す）。',
    },
  },
  create(context) {
    const file = repositoryPath(context.cwd, context.filename);
    const entries = WORKER_REFERENCE_ALLOWLIST.filter(entry => entry.file === file);
    const allowed = entries.map(entry => entry.text);
    /** @type {Map<string, number>} */
    const seen = new Map(entries.map(entry => [entry.text, 0]));
    /**
     * @param {string} text
     * @param {import('eslint').AST.SourceLocation | null | undefined} loc
     */
    const inspect = (text, loc) => {
      for (const item of allowed) seen.set(item, (seen.get(item) ?? 0) + text.split(item).length - 1);
      for (const found of findWorkerReferences(text, allowed)) {
        if (loc) context.report({ loc, messageId: 'reference', data: { text: found } });
      }
    };
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) inspect(comment.value, comment.loc);
      },
      Literal(node) {
        if ('regex' in node && node.regex) inspect(node.regex.pattern.replaceAll('\\/', '/'), node.loc);
        else if (typeof node.value === 'string') inspect(node.value, node.loc);
      },
      TemplateElement(node) {
        inspect(node.value.cooked ?? node.value.raw, node.loc);
      },
      /** @param {import('estree').Node & { value?: unknown }} node */
      JSXText(node) {
        if (typeof node.value === 'string') inspect(node.value, node.loc);
      },
      'Program:exit'(node) {
        for (const entry of entries) {
          const actual = seen.get(entry.text) ?? 0;
          if (actual !== entry.count) {
            context.report({
              node, loc: { line: 1, column: 0 }, messageId: 'allowlistCount',
              data: { text: entry.text, expected: String(entry.count), actual: String(actual) },
            });
          }
        }
      },
    };
  },
};

/** eslint.config.js が並べる設定（1 つ）。 */
/** @type {import('eslint').Linter.Config} */
export const workerReferencesConfig = {
  files: WORKER_REFERENCE_FILES,
  plugins: { 'worker-references': { rules: { 'no-worker-references': noWorkerReferencesRule } } },
  rules: { 'worker-references/no-worker-references': 'error' },
};
