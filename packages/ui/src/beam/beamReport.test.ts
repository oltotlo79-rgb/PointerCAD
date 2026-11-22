import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFontStore, DRAWING_FONT_ASSET, toPdf, type RenderDocument, type RenderPath, type RenderText } from '@pointercad/drawing';
import type { BeamAnalysisResult, BeamMember, PropertySource, Vector3 } from '@pointercad/model/beam-analysis';
import { beforeAll, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { buildBeamReport, type BeamReportInput } from './beamReport.js';

const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(
  new URL('../../../../apps/web/public/' + DRAWING_FONT_ASSET.url, import.meta.url))).buffer) });
const zero: Vector3 = [0, 0, 0];
const evidence: PropertySource = { kind: 'measured', reference: '記録 A', condition: '室温' };

function fixture(count: number): BeamReportInput {
  const source = { documentId: 'frame', documentRevision: 2, geometryRevision: 'g7' };
  const nodes = Array.from({ length: count + 1 }, (_, i) => ({ id: 'N' + i, position: [1000 * i, 0, 0] as const }));
  const members: BeamMember[] = Array.from({ length: count }, (_, i) => ({
    id: 'B' + i, componentId: 'C' + i, occurrencePath: ['C' + i], startNodeId: nodes[i].id, endNodeId: nodes[i + 1].id,
    materialId: '鋼 A', sectionId: '角 A', localYHint: [0, 1, 0],
  }));
  const middle = count / 2;
  // Layout fixture: node/element order, signed components and non-round values are deliberate.
  const result: BeamAnalysisResult = { kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic',
    analysisId: 'S1', analysisRevision: 3, source, inputSha256: 'a'.repeat(64), structuralCertification: false,
    nodes: nodes.map((node, i) => ({ nodeId: node.id, solverNode: i + 1, constrained: i === 0 || i === count,
      displacementM: i === middle ? [0, 0, -0.00123456789] : zero, rotationRad: i === middle ? [0, 0.000123456789, 0] : zero,
      reactionN: i === 0 || i === count ? [0, 0, 5.12345678] : zero, reactionNm: i === 0 ? [0, -0.0123456789, 0] : zero })),
    elements: members.map((member, i) => ({ memberId: member.id, componentId: member.componentId, occurrencePath: member.occurrencePath,
      solverElement: i + 1, nodeIds: [member.startNodeId, member.endNodeId], frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 1 },
      start: [1, -2, 3, 0.00456789123, 0, -0.006], end: [-1, 2, -3, 0, 0.005, 0.006] })),
    balance: { referenceM: [0.1, 0, 0], forceN: [0, 0, -1e-9], momentNm: [0, 1e-10, 0], maximumFreeResidual: 1.234569e-17 } };
  return { documentName: '架台', analysisName: '中央荷重', exportedAt: '2026-11-19 12:00 UTC', appVersion: '1.0.4',
    members: members.map(member => ({ id: member.id, occurrence: { label: '部材 ' + member.id } })),
    conditions: { id: result.analysisId, revision: result.analysisRevision, units: 'N-mm', source, nodes, members,
      materials: [{ id: '鋼 A', youngModulus: 200000, shearModulus: 80000, densityKgM3: 7850, source: evidence }],
      sections: [{ id: '角 A', area: 100, iy: 200, iz: 300, torsionConstant: 400, shearFactor: 0.85, source: evidence }],
      constraints: [nodes[0], nodes[count]].map((node, i) => ({ id: 'S' + i, kind: 'fixed', nodeId: node.id })),
      loads: [{ id: 'L1', kind: 'nodal', nodeId: nodes[middle].id, force: [0, 0, -10.24691356], moment: [0, 12.3456789, 0] }] },
    result };
}

function texts(pages: readonly RenderDocument[]): RenderText[] {
  return pages.flatMap(page => page.primitives.filter((p): p is RenderText => p.kind === 'text'));
}
const cells = (items: readonly RenderText[], id: string): string[] => items.filter(p => p.ownerId === id).map(p => p.text);
function pdfHash(page: RenderDocument): string {
  const pdf = toPdf(page);
  if (!pdf.ok) throw new Error(pdf.reason);
  return createHash('sha256').update(pdf.bytes).digest('hex');
}
function ends(path: RenderPath) {
  return path.subpaths.flatMap(s => s.commands.flatMap(c => c.kind === 'M' || c.kind === 'L' ? [c.to] : []));
}
function withinMargins(pages: readonly RenderDocument[]): void {
  const bounds = texts(pages).map(p => {
    const ink = p.metrics.inkBounds;
    return [p.position[0] + ink.left, p.position[1] - (ink.top - ink.bottom), p.position[0] + ink.right, p.position[1]];
  });
  expect(Math.min(...bounds.map(box => box[0]))).toBeGreaterThanOrEqual(15);
  expect(Math.min(...bounds.map(box => box[1]))).toBeGreaterThanOrEqual(15);
  expect(Math.max(...bounds.map(box => box[2]))).toBeLessThanOrEqual(195);
  expect(Math.max(...bounds.map(box => box[3]))).toBeLessThanOrEqual(282);
}

describe('梁の静解析報告書', () => {
  beforeAll(async () => { expect(await font.load()).toBe('ready'); });

  it('固定入力の条件・結果・単位と図を実字体で組み、同じ各頁を PDF にできる', () => {
    const input = fixture(2);
    const pages = buildBeamReport(input, font.outline);
    expect(pages).toHaveLength(1);
    const items = texts(pages);
    pages.forEach((p, index) => {
      expect([p.widthMm, p.heightMm]).toEqual([210, 297]);
      const header = texts([p]).filter(x => x.ownerId.startsWith('header/')).map(x => x.text).join('');
      for (const text of [input.analysisName, input.documentName, input.exportedAt, input.appVersion,
        t('beam.report.title'), t('analysisReport.page').replace('{page}', String(index + 1))]) expect(header).toContain(text);
    });
    expect(cells(items, 'scope/0').join('')).toBe(t('beam.scope'));
    expect(cells(items, 'scope/1').join('')).toBe(t('beam.resultScope'));
    for (const [table, rows] of [['materials', 1], ['sections', 1], ['members', 2], ['supports', 2], ['loads', 1],
      ['nodes', 3], ['ends', 2]] as const) {
      const rowIds = new Set(items.map(p => p.ownerId).filter(id => id.startsWith(table + '/') && /\/\d+$/u.test(id)));
      expect([...rowIds]).toEqual(Array.from({ length: rows }, (_, i) => table + '/' + i));
    }
    expect(cells(items, 'materials/0')).toEqual(['鋼 A', '200000', '80000', '0.25', '7850', '測定値 / 記録 A / 室温']);
    expect(cells(items, 'sections/0').slice(0, 6)).toEqual(['角 A', '100', '200', '300', '400', '0.85']);
    expect(cells(items, 'members/1')).toEqual(['B1', '部材 B1', 'N1', 'N2', '鋼 A', '角 A']);
    expect(cells(items, 'supports/0')).toEqual(['S0', 'N0']);
    expect(cells(items, 'supports/1')).toEqual(['S1', 'N2']);
    expect(cells(items, 'loads/0')).toEqual(['L1', 'N1', '0  0  -10.2469', '0  12.3457  0']);
    expect(cells(items, 'summary/0')[1]).toBe('1.23457 mm  (N1)');
    expect(cells(items, 'summary/1')[1]).toBe('0  0  -1e-9');
    expect(cells(items, 'summary/2')[1]).toBe('0  1e-7  0');
    expect(cells(items, 'summary/3')[1]).toBe('100  0  0');
    expect(cells(items, 'summary/4')[1]).toBe('1.23457e-17');
    expect(cells(items, 'nodes/0').slice(3)).toEqual(['0  0  5.12346', '0  -12.3457  0']);
    expect(cells(items, 'nodes/1')).toEqual(['N1', '0  0  -1.23457', '0  0.000123457  0', '—', '—']);
    expect(cells(items, 'ends/0')).toEqual(['B0', '1  -2  3', '4.56789  0  -6', '-1  2  -3', '0  5  6']);
    const paths = pages.flatMap(page => page.primitives.filter((p): p is RenderPath => p.kind === 'path'));
    expect(paths.map(p => [p.ownerId, p.layerId, p.fill])).toEqual([
      ['B0', 'members', null], ['B1', 'members', null], ['B0', 'deformed', null], ['B1', 'deformed', null],
    ]);
    expect(cells(items, 'figure/title').join('')).toBe(t('beam.report.figure').replace('{factor}', '10'));
    const [a, b] = ends(paths[0]), [da, db] = ends(paths[2]);
    expect(da).toEqual(a);
    expect(db[0]).toBe(b[0]);
    expect((b[1] - a[1]) / (b[0] - a[0])).toBeCloseTo(-1 / Math.sqrt(3), 10);
    expect((db[1] - b[1]) / (b[0] - a[0])).toBeCloseTo(-0.00123456789 * 10 * 2 / Math.sqrt(3), 10);
    withinMargins(pages);
    const again = buildBeamReport(input, font.outline);
    expect(again).toEqual(pages);
    expect(again.map(pdfHash)).toEqual(pages.map(pdfHash));
  });

  it('60部材の端力表を2頁に割り、同じ見出しの下に各行を順に一度ずつ置く', () => {
    const input = fixture(60);
    const pages = buildBeamReport(input, font.outline);
    expect(pages).toHaveLength(5);
    pages.forEach((p, i) => {
      const header = texts([p]).filter(item => item.ownerId.startsWith('header/')).map(item => item.text).join('');
      for (const value of [input.documentName, input.analysisName, input.appVersion, input.exportedAt,
        t('analysisReport.page').replace('{page}', String(i + 1))]) expect(header).toContain(value);
    });
    const endPages = pages.map(page => texts([page])).filter(items => cells(items, 'ends/title').length > 0);
    expect(endPages).toHaveLength(2);
    const rowIds: string[] = [];
    for (const items of endPages) {
      expect(cells(items, 'ends/title')).toEqual([t('beam.report.endForces')]);
      expect(cells(items, 'ends/head')).toEqual(cells(endPages[0], 'ends/head'));
      const head = items.findIndex(p => p.ownerId === 'ends/head');
      const data = items.findIndex(p => /^ends\/\d+$/u.test(p.ownerId));
      expect(head).toBeGreaterThan(-1);
      expect(data).toBeGreaterThan(head);
      rowIds.push(...new Set(items.slice(data).filter(p => /^ends\/\d+$/u.test(p.ownerId)).map(p => p.ownerId)));
    }
    expect(rowIds).toEqual(Array.from({ length: 60 }, (_, i) => 'ends/' + i));
    withinMargins(pages);
    for (const page of pages) expect(pdfHash(page)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('同じ条件を N・m で受けても mm、MPa、N·mm の表と図が一致する', () => {
    const input = fixture(2);
    const original = input.conditions;
    const metres = (v: Vector3): Vector3 => [v[0] / 1000, v[1] / 1000, v[2] / 1000];
    const other: BeamReportInput = { ...input, conditions: { ...original, units: 'N-m',
      nodes: original.nodes.map(n => ({ ...n, position: metres(n.position) })),
      loads: original.loads.map(l => ({ ...l, moment: metres(l.moment) })),
      materials: original.materials.map(m => ({ ...m, youngModulus: m.youngModulus * 1e6, shearModulus: m.shearModulus * 1e6 })),
      sections: original.sections.map(s => ({ ...s, area: s.area / 1e6, iy: s.iy / 1e12, iz: s.iz / 1e12,
        torsionConstant: s.torsionConstant / 1e12 })) } };
    expect(buildBeamReport(other, font.outline).map(pdfHash)).toEqual(buildBeamReport(input, font.outline).map(pdfHash));
  });

  it('長い材料出典を改頁しても全字を順に保存し、欠字は報告書生成時に知らせる', () => {
    const input = fixture(2);
    const original = input.conditions.materials[0];
    const reference = '測定記録'.repeat(500);
    const material = { ...original, source: { ...original.source, reference } };
    const pages = buildBeamReport({ ...input, conditions: { ...input.conditions, materials: [material] } }, font.outline);
    expect(pages.filter(p => cells(texts([p]), 'materials/head').length > 0).length).toBeGreaterThan(1);
    expect(cells(texts(pages), 'materials/0').join('')).toContain(reference);
    withinMargins(pages);
    expect(() => buildBeamReport({ ...input, documentName: String.fromCodePoint(0x10ffff) }, font.outline))
      .toThrow(t('drawing.error.fontFailed'));
  });
});
