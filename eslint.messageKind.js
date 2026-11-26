// @ts-check
/**
 * 失敗の種類を、誤りの文(message)の一致で決めない決まり(failure-kind/no-message-text-match。0b、統括の決定 2026-11-22 10:05)。
 * 失敗の種類は、投げる所・返す所で符号(code・reason)に持たせ、符号で決める。文は利用者へそのまま見せる物で、直すと種類が黙って変わるため。
 * 断る書き方: 誤りの文(欄 X.message と、名前が message の変数・引数)を
 *   - 文字列・テンプレート・t(…)・大文字の定数と ===・!==・==・!= で比べる(空の文字列・null・undefined・別の文との比べは断らない)、
 *   - includes・startsWith・endsWith・indexOf・lastIndexOf・match・search を、同じ形の定数で呼ぶ、
 *   - 正規表現の test・exec に渡す、switch で振り分ける。
 * MESSAGE_KIND_BASELINE は、決まりを入れた時に今あった所だけを、ファイルごとの数・区分・理由・直す予定の束で留める。
 * 数は減る向きにだけ変えられる: 表に無い所が 1 つでも増えると、この決まりと packages/test-utils/src/messageKindPolicy.test.ts が落ちる。
 * 表の所を直して数が減った時も、表の数を下げる(0 なら行を消す)まで落ちる(toleranceBaseline と同じ見張り方)。
 */

/** @type {ReadonlyArray<{ readonly file: string, readonly count: number, readonly kind: 'external' | 'boundary' | 'internal', readonly reason: string, readonly plannedFix: string }>} */
export const MESSAGE_KIND_BASELINE = [
  { file: 'apps/desktop/src/main/occtHttpTransport.ts', count: 1, kind: 'external',
    reason: 'Chromium のネットの誤りは、種類を文(net::ERR_…)でしか渡さない', plannedFix: '直さない(外の仕組みの文)' },
  { file: 'apps/desktop/src/renderer/desktopFileGateway.ts', count: 2, kind: 'boundary',
    reason: 'Electron のプロセスの間の誤りは message しか運べない(目印の定数)', plannedFix: '直さない(プロセスの境目の目印)' },
  { file: 'packages/fem/src/femCodedError.ts', count: 7, kind: 'boundary',
    reason: '計算部(Pyodide・Python)は誤りを包み直し、種類を文(取得の拒否の印・solid-buckling-…: の頭)でしか渡さない。文を読むのは fem のこの 1 か所だけ',
    plannedFix: '直さない(計算部の境目の 1 か所)' },
  { file: 'packages/model/src/scripting/runtimeErrors.ts', count: 2, kind: 'external',
    reason: '式の実行の仕組みの記憶の不足・呼び出しの深さの超えは、種類を文でしか渡さない', plannedFix: '直さない(外の仕組みの文)' },
  { file: 'packages/ui/src/history/namedSavePointIntegrity.ts', count: 1, kind: 'boundary',
    reason: '自分で付けた [detail: …] の目印から診断の語を取り出す(種類は reason の符号で決まる)', plannedFix: '直さない(診断の語の取り出し)' },
  { file: 'packages/ui/src/shell/startupRecovery.ts', count: 2, kind: 'external',
    reason: 'ブラウザーの動的な読み込みの失敗は、種類を文でしか渡さない', plannedFix: '直さない(外の仕組みの文)' },
];

/** 誤りの文と見なす式: 欄 X.message(X?.message を含む)と、名前が message の変数・引数。 */
function isMessageText(node) {
  const value = node.type === 'ChainExpression' ? node.expression : node;
  if (value.type === 'Identifier') return value.name === 'message';
  return value.type === 'MemberExpression' && !value.computed && value.property.type === 'Identifier' && value.property.name === 'message';
}

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]{2,}$/u;

/** 種類を決める相手と見なす式: 空でない文字列・正規表現・テンプレート・t(…)・大文字の定数(X.CONSTANT を含む)。 */
function isKindText(node) {
  if (node.type === 'Literal') return (typeof node.value === 'string' && node.value !== '') || 'regex' in node;
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && node.callee.name === 't';
  if (node.type === 'Identifier') return CONSTANT_NAME.test(node.name);
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && CONSTANT_NAME.test(node.property.name);
}

const SEARCH_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'search']);

/** @type {import('eslint').Rule.RuleModule} */
export const messageKindRule = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { allowed: { type: 'integer', minimum: 0 } }, additionalProperties: false }],
    messages: {
      match: '失敗の種類を、誤りの文(message)と文字列・定数・訳した文の一致で決めないでください。投げる所・返す所で符号(code・reason)を持たせ、'
        + '符号で決めてください(文は利用者へそのまま見せる物です)。今ある所は eslint.messageKind.js の表が数で留めています(このファイル: 表 {{allowed}}・今 {{count}})。',
      stale: '誤りの文の一致で種類を決める所が {{count}} か所に減りました。eslint.messageKind.js の表の数({{allowed}})を {{count}} に下げてください(0 なら行を消す)。',
    },
  },
  create(context) {
    const allowed = context.options[0]?.allowed ?? 0;
    /** @type {import('estree').Node[]} */
    const hits = [];
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        if ((isMessageText(node.left) && isKindText(node.right)) || (isMessageText(node.right) && isKindText(node.left))) hits.push(node);
      },
      CallExpression(node) {
        const callee = node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        const [first] = node.arguments;
        if (first === undefined) return;
        const method = callee.property.name;
        if ((SEARCH_METHODS.has(method) && isMessageText(callee.object) && isKindText(first))
          || ((method === 'test' || method === 'exec') && isKindText(callee.object) && isMessageText(first))) hits.push(node);
      },
      SwitchStatement(node) {
        if (isMessageText(node.discriminant)) hits.push(node);
      },
      'Program:exit'(program) {
        const data = { allowed: String(allowed), count: String(hits.length) };
        if (hits.length > allowed) for (const node of hits) context.report({ node, messageId: 'match', data });
        else if (hits.length < allowed) context.report({ node: program, messageId: 'stale', data });
      },
    };
  },
};

/**
 * 失敗の文(欄 text の FailureText)の鍵を、画面の側の一覧(failureMessage・partErrorMessage)を通さずに文として持ち出す書き方を断る決まり
 * (failure-text/no-key-as-text。統括の決定 2026-11-22。0b-3a の README §6 の G・H)。型を使わず、形で断る。製品だけに効く(検査のファイルは見ない)。
 *   G: 欄 text の鍵を読む(X.text.key・X.text?.key・X.text['key']・const { key } = X.text)。
 *   H: 欄 text から始まる式を JSON.stringify に渡す。ただし X.text の後に .parameters・.key が続く時と、X の名前が失敗を持つ物と読める時
 *      (error・failure・issue・rejection を含む)だけ。型を見ないので、文字の欄 text: string の物(注記・文字の形・DXF の文字・状態の文)には当てない。
 *      型つきの決まりにしないのは、見張りの検査(packages/test-utils/src/messageKindPolicy.test.ts)が型なしで流す形で、型つきにすると
 *      そこでは型の情報が無く、決まりが黙って弱くなるため(読み合わせ 2026-11-22 の直し。束の README)。
 * 鍵と値から文を作る ui の failureMessage と model の plainTextValue は、引数の名前 text で読む(X.text の形ではない)ので当たらない。
 * 止めない物(覚え書き wip/b0-design/leak-guard-memo.md の 3): 欄の名前が text でない所・別名に入れてから読む所・FailureText を中に持つ物まるごとの JSON.stringify。
 */
/** ChainExpression・TSNonNullExpression・型の注釈を外した中身。 */
function unwrap(node) {
  let value = node;
  while (value && (value.type === 'ChainExpression' || value.type === 'TSNonNullExpression' || value.type === 'TSAsExpression'
    || value.type === 'TSSatisfiesExpression')) value = value.expression;
  return value;
}

/** 欄 text を読む式(X.text・X?.text)。 */
function isTextField(node) {
  const value = unwrap(node);
  return value?.type === 'MemberExpression' && !value.computed && value.property.type === 'Identifier' && value.property.name === 'text';
}

/** 欄 text から始まる式(X.text・X.text.parameters・X.text?.parameters.y …)なら、その X.text の式。違えば null。 */
function textFieldOf(node) {
  let value = unwrap(node);
  while (value?.type === 'MemberExpression') {
    if (isTextField(value)) return unwrap(value);
    value = unwrap(value.object);
  }
  return null;
}

/** 失敗を持つ物と読める名前(error・errors・failure・issue・rejection を含む。大文字小文字は見ない)。 */
const FAILURE_NAME = /error|failure|issue|rejection/iu;

/** X の一番近い名前(error → error、result.errors[0] → errors、this.failure → failure)。 */
function nearestName(node) {
  let value = unwrap(node);
  while (value) {
    if (value.type === 'Identifier') return value.name;
    if (value.type !== 'MemberExpression') return null;
    if (!value.computed && value.property.type === 'Identifier') return value.property.name;
    value = unwrap(value.object);
  }
  return null;
}

/**
 * H を失敗の文に絞る(型を見ないので、文字の欄 text: string の物〔注記・文字の形・DXF の文字〕に当てない)。
 * X.text の後に .parameters・.key が続くか、X の名前が失敗を持つ物と読める時だけ。
 */
function isFailureTextStringify(argument) {
  const field = textFieldOf(argument);
  if (field === null) return false;
  // X.text のすぐ後の欄(X.text.parameters・X.text?.key …)。
  let value = unwrap(argument);
  let next = null;
  while (value?.type === 'MemberExpression' && value !== field) {
    next = value;
    value = unwrap(value.object);
  }
  const after = next === null ? null : next.computed
    ? (next.property.type === 'Literal' ? String(next.property.value) : null)
    : (next.property.type === 'Identifier' ? next.property.name : null);
  if (after === 'parameters' || after === 'key') return true;
  return FAILURE_NAME.test(nearestName(field.object) ?? '');
}

/** 欄の名前が key の読み(.key と ['key'])。 */
function isKeyProperty(member) {
  if (!member.computed) return member.property.type === 'Identifier' && member.property.name === 'key';
  return member.property.type === 'Literal' && member.property.value === 'key';
}

/** @type {import('eslint').Rule.RuleModule} */
export const failureTextKeyRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      key: '失敗の文(欄 text)の鍵を、画面の一覧を通さずに読まないでください。'
        + '見せる文は ui の failureMessage(packages/ui/src/i18n/failureMessage.ts)・partErrorMessage(packages/ui/src/solid/solidHistoryState.ts)で作ります。'
        + 'model・io では文にせず FailureText のまま返し、種類を見分けるなら code・reason で見ます(rules/04)。',
      stringify: '失敗の文(欄 text)を JSON.stringify で文にしないでください。鍵と値がそのまま利用者に見えます。'
        + '見せる文は ui の failureMessage(packages/ui/src/i18n/failureMessage.ts)で作ります。model・io では FailureText のまま返します。',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isKeyProperty(node) && isTextField(node.object)) context.report({ node, messageId: 'key' });
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || !node.init || !isTextField(node.init)) return;
        for (const property of node.id.properties) {
          if (property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'key') {
            context.report({ node: property, messageId: 'key' });
          }
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.object.name !== 'JSON'
          || callee.property.type !== 'Identifier' || callee.property.name !== 'stringify') return;
        const [first] = node.arguments;
        if (first && first.type !== 'SpreadElement' && isFailureTextStringify(first)) context.report({ node, messageId: 'stringify' });
      },
    };
  },
};
