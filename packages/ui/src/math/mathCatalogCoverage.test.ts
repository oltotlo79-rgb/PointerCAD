import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANDIDATE_MATH_BY_ID } from '@pointercad/expression/math/contracts';
import { MATH_PALETTE_DRAFT } from './mathPalette.js';
import { MATH_INPUT_PALETTE } from './mathPaletteExamples.js';
import {
  MATH_CATALOG_COVERAGE, MATH_CATALOG_COVERAGE_GEOMETRY_LINE,
  assertMathPlanRowsMatch, countMathCatalogSymbols, isMathCoverageAccepted, parseMathPlanCoverageTable,
  validateMathCatalogCoverage, type MathCoverageRow,
} from './mathCatalogCoverage.js';

/**
 * 計画 §1（分野別の網羅表）を実ファイルから読む。`node:fs` を使うのはこのテストだけで、
 * `mathCatalogCoverage.ts` 自体は純粋関数のみを持つ（読み取りはテストが担う）。
 */
const planMarkdown = readFileSync(new URL('../../../../docs/plans/追加-数学入力.md', import.meta.url), 'utf8');
const planRows = parseMathPlanCoverageTable(planMarkdown);

/** 実データでの「公開目録に実在」「演算が implemented」の判定に使う集合。 */
const registeredOperationIds = new Set(CANDIDATE_MATH_BY_ID.keys());
const catalogIds = new Set(MATH_INPUT_PALETTE.map(item => item.id));
const implementedCatalogIds = new Set(
  MATH_PALETTE_DRAFT.filter(item => item.requiredOperations.every(operationId => registeredOperationIds.has(operationId)))
    .map(item => item.id),
);

describe('計画§1の32行と公開目録の機械照合（MC-04）', () => {
  it('計画から読み取った行数が32で、対応表と分野・記法が一致する（計画の行が変われば失敗）', () => {
    expect(planRows.length).toBe(32);
    expect(MATH_CATALOG_COVERAGE.length).toBe(32);
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE, planRows)).not.toThrow();
  });

  it('記号の総数は265（幾何9件を含む）・256（幾何を除く）で欠落0', () => {
    const geometry = MATH_CATALOG_COVERAGE.find(row => row.line === MATH_CATALOG_COVERAGE_GEOMETRY_LINE);
    if (geometry === undefined) throw new Error(`幾何(L${String(MATH_CATALOG_COVERAGE_GEOMETRY_LINE)})の行がありません。`);
    expect(geometry.symbols.length).toBe(9);
    expect(countMathCatalogSymbols(MATH_CATALOG_COVERAGE)).toBe(265);
    expect(countMathCatalogSymbols(MATH_CATALOG_COVERAGE) - geometry.symbols.length).toBe(256);
    for (const row of MATH_CATALOG_COVERAGE) {
      for (const entry of row.symbols) {
        const hasReason = !isMathCoverageAccepted(entry) && entry.reason.trim() !== '';
        expect(isMathCoverageAccepted(entry) || hasReason, `L${String(row.line)} ${entry.symbol}`).toBe(true);
      }
    }
  });

  it('幾何9記号(L165)は目録IDを持たず、w1dの計画を参照する理由を持つ', () => {
    const geometry = MATH_CATALOG_COVERAGE.find(row => row.line === MATH_CATALOG_COVERAGE_GEOMETRY_LINE);
    if (geometry === undefined) throw new Error('幾何(L165)の行がありません。');
    for (const entry of geometry.symbols) {
      expect(isMathCoverageAccepted(entry), entry.symbol).toBe(false);
      if (!isMathCoverageAccepted(entry)) expect(entry.reason, entry.symbol).toContain('w1d');
    }
  });

  it('目録IDを持つ記号は公開目録に実在し、演算がimplementedである（実データ）', () => {
    expect(() => validateMathCatalogCoverage({ rows: MATH_CATALOG_COVERAGE, catalogIds, implementedCatalogIds })).not.toThrow();
  });

  it('後続タスク待ちの記号数が想定どおり（MC-02dはMC-04bで、MC-20はMC-04cで全件catalogIds化。MC-19cは残る。書き換え対象の集計）', () => {
    const pendingReasons: string[] = [];
    for (const row of MATH_CATALOG_COVERAGE) {
      for (const entry of row.symbols) {
        if (!isMathCoverageAccepted(entry)) pendingReasons.push(entry.reason);
      }
    }
    const countByTask = (task: string) => pendingReasons.filter(reason => reason.includes(task)).length;
    expect(countByTask('MC-02d')).toBe(0);
    expect(countByTask('MC-19c')).toBe(3);
    expect(countByTask('MC-20')).toBe(0);
    expect(pendingReasons.length).toBe(26);
  });
});

describe('対応表の自己検査（模擬入力で不正な変更を拒否する。5種以上）', () => {
  const acceptedEntry: MathCoverageRow['symbols'][number] = { symbol: 'x', catalogIds: ['x-op'] };
  const pendingEntry: MathCoverageRow['symbols'][number] = { symbol: 'y', reason: '未実装のためのテスト用の理由。' };
  const mockRow: MathCoverageRow = { line: 900, domain: 'テスト分野', planNotation: 'x、y', symbols: [acceptedEntry, pendingEntry] };
  const mockCatalogIds = new Set(['x-op']);
  const mockImplementedIds = new Set(['x-op']);

  it('1. 未実装(pending)の演算を受入済みにする変更を拒否する', () => {
    expect(() => validateMathCatalogCoverage({
      rows: [mockRow], catalogIds: mockCatalogIds, implementedCatalogIds: new Set(),
    })).toThrow(/未実装/u);
  });

  it('2. 存在しない目録IDを拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: ['no-such-id'] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/公開目録にありません/u);
  });

  it('3. 理由の空欄を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [acceptedEntry, { symbol: 'y', reason: '' }] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/理由が空/u);
  });

  it('4. 記号の重複を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [acceptedEntry, { symbol: 'x', reason: '重複したテスト用の理由。' }] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/重複/u);
  });

  it('5. 計画の行の削除・追加を拒否する（対応表と計画の行数が食い違う）', () => {
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE.slice(1), planRows)).toThrow();
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE, planRows.slice(1))).toThrow();
  });

  it('6. 空のcatalogIds配列を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: [] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/catalogIds が空/u);
  });

  it('7. 同一記号内での目録IDの重複を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: ['x-op', 'x-op'] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/目録ID.*重複/u);
  });

  it('8. 計画の行の文言変更（記法・演算列の書き換え）を拒否する', () => {
    const mutatedRows = MATH_CATALOG_COVERAGE.map((row, index) => (index === 0 ? { ...row, planNotation: '書き換えテスト' } : row));
    expect(() => assertMathPlanRowsMatch(mutatedRows, planRows)).toThrow();
  });

  it('9. 対応表が空の変更を拒否する', () => {
    expect(() => validateMathCatalogCoverage({ rows: [], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds }))
      .toThrow(/空です/u);
  });
});
