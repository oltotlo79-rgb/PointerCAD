/**
 * 計画 `docs/plans/追加-数学入力.md` §1（分野別の網羅表、L134〜L165の32行・256記号。幾何9件〔L165〕を除く）と、
 * 公開目録（`mathPaletteExamples.ts` の `MATH_INPUT_PALETTE`）の機械照合（MC-04、`mathCatalogCoverage.test.ts`）。
 *
 * 各記号は次のどちらか一方だけを持つ。
 * - `catalogIds`（{@link MathCoverageAccepted}）: 公開目録（`MATH_INPUT_PALETTE`）の項目ID。1個以上。
 *   1つの記号が複数の目録項目にまたがる場合（例: L152「SVD」→ svd-u/svd-s/svd-v/singular-values）は全て列挙する。
 * - `reason`（{@link MathCoveragePending}）: 未実装・範囲外の理由。計画の利用者回答・後続タスク名（MC-02d・MC-19b・
 *   MC-19c・MC-12・MC-20 等）・設計上パレット化しない理由のいずれかを明記する（空文字列は不可）。
 *   後続タスクが目録へ項目を追加したら、対応する `reason` を `catalogIds` へ書き換えるだけで済む。
 *
 * 幾何9記号（L165）は図形参照（CAD参照）として `packages/model/src/measure/mathGeometry.ts` の評価へ対応する。
 *
 * このファイルは対応表を保持し、計画ファイルとの整合を検査する純粋関数（`node:fs` 等の入出力は行わない。
 * 実ファイルの読み取りは `mathCatalogCoverage.test.ts` が行い、文字列として渡す）を提供するだけで、
 * `mathPalette*.ts`・`mathExtendedOperations.ts` など他ファイルは一切変更しない。
 */

/** 公開目録に実在する記号（1個以上の目録ID）。 */
export interface MathCoverageAccepted {
  readonly symbol: string;
  /** 公開目録（`MATH_INPUT_PALETTE`）の項目ID。重複無し、1個以上。 */
  readonly catalogIds: readonly string[];
}

/** まだ「受入済み」にできない記号。 */
export interface MathCoveragePending {
  readonly symbol: string;
  /** 未実装・範囲外の理由。空文字列は不可。 */
  readonly reason: string;
}

export type MathCoverageSymbol = MathCoverageAccepted | MathCoveragePending;

/** `catalogIds` を持つ（受入済みの）記号かどうか。 */
export function isMathCoverageAccepted(entry: MathCoverageSymbol): entry is MathCoverageAccepted {
  return 'catalogIds' in entry;
}

interface MathCoverageRow {
  /** 計画 `追加-数学入力.md` の行番号（§1 の表の1行、L134〜L165）。 */
  readonly line: number;
  /** 計画の「分野」列。 */
  readonly domain: string;
  /** 計画の「記法・演算」列の原文（読み違い検出用。計画側の行が変わればここと食い違い、検査が落ちる）。 */
  readonly planNotation: string;
  readonly symbols: readonly MathCoverageSymbol[];
}

/** 計画 §1 の1行分（分野・記法列の原文だけ。境界の受入列は対応表に使わないため含まない）。 */
export interface MathPlanCoverageRow {
  readonly domain: string;
  readonly notation: string;
}

const PLAN_TABLE_HEADER = /^\|\s*分野\s*\|\s*記法・演算\s*\|\s*利用と境界の受入\s*\|$/u;
const PLAN_TABLE_SEPARATOR = /^\|[-: |]+\|$/u;
/** 1セル分: エスケープした `\|`（セル内の縦棒）を1単位として消費し、素の `|`（区切り）の手前で止まる。 */
const PLAN_TABLE_ROW = /^\|\s*((?:[^|\\]|\\.)+?)\s*\|\s*((?:[^|\\]|\\.)+?)\s*\|\s*(?:[^|\\]|\\.)*\|\s*$/u;

function unescapePlanCell(cell: string): string {
  // Markdown表のセル内の縦棒は「\|」と書く（例: "P(A\|B)"）。素のテキストへ戻す。
  return cell.replace(/\\(.)/gu, '$1');
}

/**
 * 計画 §1（分野別の網羅表）を実ファイルのテキストから読む。表の見出し行に続く32行を、
 * 分野・記法列（原文）だけ取り出す。読み取れない行・表が見つからない場合は投げる。
 * 副作用（ファイル読み取り）は持たない。呼び出し側（テスト）が `readFileSync` 等で渡す。
 */
export function parseMathPlanCoverageTable(markdown: string): readonly MathPlanCoverageRow[] {
  const rows: MathPlanCoverageRow[] = [];
  let inTable = false;
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!inTable) { if (PLAN_TABLE_HEADER.test(line)) inTable = true; continue; }
    if (PLAN_TABLE_SEPARATOR.test(line)) continue;
    if (line === '' || !line.startsWith('|')) break;
    const match = PLAN_TABLE_ROW.exec(line);
    if (match === null) throw new Error(`計画 §1 の行を読み取れません: ${line}`);
    const [, domain, notation] = match;
    rows.push({ domain: unescapePlanCell(domain), notation: unescapePlanCell(notation) });
  }
  if (rows.length === 0) throw new Error('計画 §1（分野別の網羅表）が見つかりません。');
  return Object.freeze(rows);
}

/**
 * 対応表（`rows`）の行数・分野・記法列が、計画から読み取った行（`planRows`）と1行ずつ一致することを確かめる。
 * 計画の行が増減・改名・並べ替え・文言変更されると、ここで具体的な行を示して投げる
 * （§1 の32行のどれかが変われば、この照合が失敗する）。
 */
export function assertMathPlanRowsMatch(rows: readonly MathCoverageRow[], planRows: readonly MathPlanCoverageRow[]): void {
  if (rows.length !== planRows.length) {
    throw new Error(`計画 §1 の行数(${String(planRows.length)})と対応表の行数(${String(rows.length)})が一致しません。`);
  }
  planRows.forEach((planRow, index) => {
    const row = rows[index];
    if (row === undefined) throw new Error(`対応表に${String(index)}番目の行がありません。`);
    if (row.domain !== planRow.domain) {
      throw new Error(`L${String(row.line)}: 分野が計画と一致しません（対応表「${row.domain}」/計画「${planRow.domain}」）。`);
    }
    if (row.planNotation !== planRow.notation) {
      throw new Error(`L${String(row.line)}「${row.domain}」: 記法・演算が計画と一致しません。対応表の planNotation を計画に合わせて更新してください`
        + `（対応表「${row.planNotation}」/計画「${planRow.notation}」）。`);
    }
  });
}

export interface MathCatalogValidationInput {
  readonly rows: readonly MathCoverageRow[];
  /** 公開目録（`MATH_INPUT_PALETTE`）に実在する項目ID。 */
  readonly catalogIds: ReadonlySet<string>;
  /** 演算が implemented である（未実装・pending の演算を要求しない）目録項目ID。 */
  readonly implementedCatalogIds: ReadonlySet<string>;
}

/**
 * 対応表の一貫性を検査する。違反を見つけ次第、具体的な記号・行を示す Error を投げる。
 * 実データ（公開目録から作った `catalogIds`・`implementedCatalogIds`）とモック入力（自己検査）の両方に使う。
 * 検査する内容:
 * - 記号が空（行に1つも無い）・記号名が空文字列・記号名の重複（対応表全体で一意）
 * - 受入済み（`catalogIds`）は1個以上、重複無し、公開目録に実在し、演算が implemented である
 * - 未実装・範囲外（`reason`）は空文字列でない
 */
export function validateMathCatalogCoverage(input: MathCatalogValidationInput): void {
  const { rows, catalogIds, implementedCatalogIds } = input;
  if (rows.length === 0) throw new Error('対応表が空です。');
  const seenSymbols = new Set<string>();
  for (const row of rows) {
    if (row.symbols.length === 0) throw new Error(`L${String(row.line)}「${row.domain}」: 記号がありません。`);
    for (const entry of row.symbols) {
      if (entry.symbol.trim() === '') throw new Error(`L${String(row.line)}「${row.domain}」: 空の記号名があります。`);
      if (seenSymbols.has(entry.symbol)) throw new Error(`記号「${entry.symbol}」が対応表内で重複しています。`);
      seenSymbols.add(entry.symbol);
      if (isMathCoverageAccepted(entry)) {
        if (entry.catalogIds.length === 0) {
          throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: catalogIds が空です。`);
        }
        const seenIds = new Set<string>();
        for (const id of entry.catalogIds) {
          if (seenIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」が重複しています。`);
          }
          seenIds.add(id);
          if (!catalogIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」は公開目録にありません。`);
          }
          if (!implementedCatalogIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」の演算は未実装(pending)です。`);
          }
        }
      } else if (entry.reason.trim() === '') {
        throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 理由が空です。`);
      }
    }
  }
}
