import { readFileSync } from 'node:fs';
import { createFontStore, DRAWING_FONT_ASSET, toPdfPages, type RenderDocument, type RenderText } from '@pointercad/drawing';
import { readSolidCadSavedInput, type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPORT_FIGURE_SIZE, type ReportFigure } from '../analysisReport/reportLayout.js';
import { analyticalSolid } from '../fatigue/fatigueSolid.testSupport.js';
import { t } from '../i18n/t.js';
import { buildSolidReport, solidReportCaption, type SolidReportInput } from './solidReport.js';

/**
 * J-03c stage 2, the static solid report's layout with the real drawing font. The result is the independent one-tet
 * analytical solution (fatigueSolid.testSupport.ts: F = 1 N along X at node 2, u = 0.03 mm, sigma_xx = 6 MPa), so the
 * expected values come from that solution, not from the product's formulas: largest displacement 0.03 mm at node 2
 * (1, 0, 0), von Mises 6 MPa in element 1 with centroid (0.25, 0.25, 0.25), support reactions summing to -F, and strain
 * energy F u / 2 = 0.015 N·mm. The stress figure is a stand-in here (the field drawing has its own unit).
 */
const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(
  new URL('../../../../apps/web/public/' + DRAWING_FONT_ASSET.url, import.meta.url))).buffer) });

function definition(documentId: string): SolidCadSavedInput {
  return readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId },
    bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200, poisson: 0, tractionMPa: [1, 0, 0],
    supports: [{ face: 'side', fixed: [true, false, true], prescribedMm: [0, 0, -0.1] }],
    gravity: { accelerationMps2: [0, 0, -9.81], densityKgM3: 7850 },
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 0.1 });
}

async function fixture(): Promise<SolidReportInput> {
  const outcome = await analyticalSolid('part', 7);
  return { analysisName: t('solidAnalysis.title'), documentName: '部品 A', exportedAt: '2026-11-22 10:30', appVersion: '1.0.4',
    definition: definition('part'), outcome };
}

/** A stand-in figure that records the box the layout gives it and draws nothing. */
function recordingFigure(): { readonly figure: ReportFigure; readonly boxes: number[][] } {
  const boxes: number[][] = [];
  return { boxes, figure: { caption: solidReportCaption(0, 6, 0),
    paths: (left, bottom, width, height) => { boxes.push([left, bottom, width, height]); return []; } } };
}

function texts(pages: readonly RenderDocument[]): RenderText[] {
  return pages.flatMap(page => page.primitives.filter((p): p is RenderText => p.kind === 'text'));
}
const cells = (items: readonly RenderText[], id: string): string[] => items.filter(p => p.ownerId === id).map(p => p.text);
/** Paper x where the second column of the two-column tables starts: the 15 mm margin plus the 100 mm first column. */
const SECOND_COLUMN_MM = 115;
/** The value cell of the row whose label cell reads `label` (a long label may wrap over several lines of the same row). */
function row(items: readonly RenderText[], table: string, label: string): string | undefined {
  const rows = [...new Set(items.map(p => p.ownerId).filter(id => id.startsWith(table + '/') && /\/\d+$/u.test(id)))];
  const column = (id: string, second: boolean): string => items.filter(p => p.ownerId === id
    && (p.position[0] >= SECOND_COLUMN_MM) === second).map(p => p.text).join('');
  const found = rows.filter(id => column(id, false) === label);
  return found.length === 1 ? column(found[0], true) : undefined;
}

describe('ソリッドの静解析報告書', () => {
  beforeAll(async () => { expect(await font.load()).toBe('ready'); });

  it('見出し・注意書き・条件・結果の要約を、独立の解析解の値で実字体に組む', async () => {
    const input = await fixture(), { figure, boxes } = recordingFigure();
    const pages = buildSolidReport(input, figure, font.outline);
    expect(pages).toHaveLength(1);
    const items = texts(pages);
    const header = items.filter(p => p.ownerId.startsWith('header/')).map(p => p.text).join('');
    for (const text of [t('solidAnalysis.report.title'), t('analysisReport.page').replace('{page}', '1'), input.documentName,
      input.analysisName, input.exportedAt, input.appVersion]) expect(header).toContain(text);
    expect(cells(items, 'scope/0').join('')).toBe(t('solidAnalysis.resultLimit'));
    expect(cells(items, 'scope/1').join('')).toBe(t('solidAnalysis.report.units'));
    expect(cells(items, 'conditions/title')).toEqual([t('solidAnalysis.report.conditions')]);
    expect(row(items, 'conditions', t('solidAnalysis.young'))).toBe('200');
    expect(row(items, 'conditions', t('solidAnalysis.poisson'))).toBe('0');
    expect(row(items, 'conditions', t('solidAnalysis.report.fixedFaces'))).toBe('1');
    expect(row(items, 'conditions', t('solidAnalysis.report.supportFace').replace('{face}', '1'))).toBe('0  —  -0.1');
    expect(row(items, 'conditions', t('solidAnalysis.loadTraction'))).toBe('1  0  0 N/mm²');
    expect(row(items, 'conditions', t('solidAnalysis.report.loadedFaces'))).toBe('1');
    expect(row(items, 'conditions', t('solidAnalysis.force'))).toBe('1  0  0 N');
    expect(row(items, 'conditions', t('solidAnalysis.gravityTitle'))).toBe('0  0  -9.81 m/s²');
    expect(row(items, 'conditions', t('solidAnalysis.gravityDensity'))).toBe('7850');
    expect(row(items, 'conditions', t('solidAnalysis.report.mesh'))).toBe('4 / 1');
    expect(cells(items, 'summary/title')).toEqual([t('analysisReport.summary')]);
    expect(row(items, 'summary', t('solidAnalysis.report.peakDisplacement'))).toBe('0.03 mm  (2: 1  0  0)');
    expect(row(items, 'summary', t('solidAnalysis.report.peakStress'))).toBe('6 MPa  (1: 0.25  0.25  0.25)');
    expect(row(items, 'summary', t('solidAnalysis.reaction'))).toBe('-1  0  0 N');
    expect(row(items, 'summary', t('solidAnalysis.energy'))).toBe('0.015 ' + t('solidAnalysis.unitEnergy'));
    expect(cells(items, 'figure/title').join('')).toBe(t('solidAnalysis.report.figure').replace('{min}', '0').replace('{max}', '6'));
    expect(boxes).toHaveLength(1);
    expect(boxes[0].slice(2)).toEqual([REPORT_FIGURE_SIZE.width, REPORT_FIGURE_SIZE.height]);
    const pdf = toPdfPages(pages, { title: 'solid', creationDate: '2026-11-22T01:30:00.000Z' });
    expect(pdf.ok).toBe(true);
    expect(buildSolidReport(await fixture(), recordingFigure().figure, font.outline)).toEqual(pages);
  });

  it('図の見出しは色の範囲を出し、印刷で見えない三角形を間引いた時だけその数を足す', () => {
    const range = t('solidAnalysis.report.figure').replace('{min}', '-1.5').replace('{max}', '6');
    expect(solidReportCaption(-1.5, 6, 0)).toBe(range);
    expect(solidReportCaption(-1.5, 6, 3)).toBe(range + '  ' + t('solidAnalysis.report.figureDropped').replace('{count}', '3'));
  });

  it('保存した入力と別の文書の結果は書かない', async () => {
    const input = await fixture();
    expect(() => buildSolidReport({ ...input, definition: definition('other') }, recordingFigure().figure, font.outline))
      .toThrow(t('analysisReport.unavailable'));
  });
});
