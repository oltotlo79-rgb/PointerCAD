import { describe, expect, it } from 'vitest';

import { addVec3, type Vec3 } from '../../sketch/vec3.js';
import { moveComponent, removeComponent, replaceComponent } from '../assemblyEdit.js';
import { rigidPlacementOf } from '../fastening/frames.js';
import { assemblyMassProperties, type AssemblyMassBody } from '../massProperties.js';
import { applyPlacementToPoint, rotateVector, type RigidPlacement } from '../placementMath.js';
import { buildStandardPartFromSource, standardPartNominalVolume } from '../standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { applyFilletWeld, removeFilletWeld, weldSegmentPlacement } from './applyFilletWeld.js';
import {
  BASE_BOX, plainTee, planeFace, TEE_BODIES, teeBodies, teeRequest, WELD_TEST_REVISIONS, weldTestBox, weldTestPlacement,
} from './filletWeld.testSupport.js';
import { filletWeldSegmentOptions } from './filletWeldPart.js';
import { nextWeldId, planFilletWeld, planFilletWeldEdit, weldSegmentsOf, type FilletWeldEditRequest } from './planFilletWeld.js';
import { FILLET_WELD_CATALOG_REVISION, FILLET_WELD_GENERATOR_REVISION, type FilletWeldPlan } from './types.js';

function expectVec(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 9));
}

function plan(document: AssemblyDocument): FilletWeldPlan {
  const result = planFilletWeld(document, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function welded(): { readonly before: AssemblyDocument; readonly after: AssemblyDocument; readonly beads: readonly string[] } {
  const before = plainTee();
  const result = applyFilletWeld(before, plan(before), WELD_TEST_REVISIONS);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return { before, after: result.document, beads: result.componentIds };
}

function component(document: AssemblyDocument, id: string): AssemblyComponent {
  const found = document.components.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

const EDIT: FilletWeldEditRequest = { weldId: 'weld-1', legOnSecond: 5, legOnFirst: 5, segments: [{ start: 0, length: 100 }], materialId: 'steel' };

describe('すみ肉溶接を文書へ足す', () => {
  it('ビードの区間ごとに溶接の台本・明示した材質・溶接線上の配置を持つ部品を、1回の新しい文書として足す', () => {
    const { before, after, beads } = welded();
    expect(JSON.stringify(before)).toBe(JSON.stringify(plainTee()));
    expect(beads).toEqual(['component-3', 'component-4', 'component-5']);
    const expected = [[10, 20], [40, 15], [70, 25]] as const;
    beads.forEach((id, index) => {
      const bead = component(after, id);
      const [station, length] = expected[index] ?? [Number.NaN, Number.NaN];
      expect(bead.source).toEqual({
        kind: 'standardPart', catalog: 'filletWeld', size: '6x8',
        options: { length: String(length), weldId: 'weld-1', weldSegment: String(index), weldStation: String(station),
          contactLength: '100', weldParts: 'component-1,component-2' },
        catalogRevision: FILLET_WELD_CATALOG_REVISION, generatorRevision: FILLET_WELD_GENERATOR_REVISION,
      });
      expect([bead.materialId, bead.fixed, bead.suppressed]).toEqual(['aluminum', false, false]);
      // 始点 = 溶接線の原点 (0,34,10) + 区間の始点 × (+X)。
      expect(bead.placement.position.map((value) => value.value)).toEqual([station, 34, 10]);
    });
    expect(component(after, 'component-3').name).toBe('すみ肉溶接 6×8 長さ20:1');
  });

  it('ビードの局所 X・Y・Z は、底板の上・立板の側面・溶接線へ向く(手で求めた 120° 回転と一致)', () => {
    const { after } = welded();
    const rotation = component(after, 'component-3').placement.rotation;
    expectVec(rotateVector(rotation, [1, 0, 0]), [0, 1, 0]);
    expectVec(rotateVector(rotation, [0, 1, 0]), [0, 0, 1]);
    expectVec(rotateVector(rotation, [0, 0, 1]), [1, 0, 0]);
    // 列が (0,1,0)・(0,0,1)・(1,0,0) の回転は (1,1,1) まわりの 120°: q = (½,½,½,½)。
    rotation.forEach((value) => expect(Math.abs(value)).toBeCloseTo(0.5, 12));
  });

  it('断面の3頂点と終わりの面は、組立の座標で底板の上面・立板の側面に載る', () => {
    const { after } = welded();
    const placement = rigidPlacementOf(component(after, 'component-3').placement);
    const corner = applyPlacementToPoint(placement, [0, 0, 0]);
    const onBase = applyPlacementToPoint(placement, [6, 0, 0]);
    const onStanding = applyPlacementToPoint(placement, [0, 8, 0]);
    const end = applyPlacementToPoint(placement, [0, 0, 20]);
    expectVec(corner, [10, 34, 10]);
    // 底板の上面 z=10 の上で立板から 6 mm 離れ、立板の側面 y=34 の上で底板から 8 mm 上がる。
    expectVec(onBase, [10, 40, 10]);
    expectVec(onStanding, [10, 34, 18]);
    expectVec(end, [30, 34, 10]);
  });

  it('台本から作る部品は直角三角形の断面をビードの長さだけ押し出し、公称体積は脚長の積の半分×長さ', () => {
    const { after } = welded();
    const bead = component(after, 'component-4');
    if (bead.source.kind !== 'standardPart') throw new Error('not standard');
    const part = buildStandardPartFromSource(bead.source);
    expect(part?.name).toBe('すみ肉溶接 6×8 長さ15');
    const extrude = part?.solids[0];
    expect(part?.solids).toHaveLength(1);
    expect(extrude?.kind === 'extrude' ? [extrude.distance.value, extrude.reversed, extrude.symmetric] : null).toEqual([15, false, false]);
    const points = part?.sketches.flatMap((sketch) => sketch.features)
      .flatMap((feature) => (feature.kind === 'point' && feature.at.mode === 'absolute'
        ? [[feature.at.x.value, feature.at.y.value, feature.at.z.value]] : []));
    expect(points).toEqual([[0, 0, 0], [6, 0, 0], [0, 8, 0]]);
    // 6 × 8 / 2 × 15 = 360 mm³。
    expect(standardPartNominalVolume('filletWeld', bead.source.size, bead.source.options)).toBe(360);
  });

  it('知らない版・壊れた寸法の台本からは何も作らない(別の形で代えない)', () => {
    const { after } = welded();
    const bead = component(after, 'component-3');
    if (bead.source.kind !== 'standardPart') throw new Error('not standard');
    expect(buildStandardPartFromSource({ ...bead.source, generatorRevision: 'fillet-weld-0' })).toBeNull();
    expect(buildStandardPartFromSource({ ...bead.source, size: '6' })).toBeNull();
    expect(buildStandardPartFromSource({ ...bead.source, size: '6x-8' })).toBeNull();
    expect(buildStandardPartFromSource({ ...bead.source, options: { ...bead.source.options, length: '0' } })).toBeNull();
    expect(buildStandardPartFromSource({ ...bead.source, options: { ...bead.source.options, weldParts: 'component-1' } })).toBeNull();
    expect(standardPartNominalVolume('filletWeld', '6x8', {})).toBeNull();
  });

  it('溶接した2部品とビードを1つの互いに固定した組にし、どれも新しく固定しない', () => {
    const { after, beads } = welded();
    const groups = new Set(['component-1', 'component-2', ...beads].map((id) => component(after, id).rigidGroupId));
    expect([...groups]).toEqual(['fastening-1']);
    expect(beads.map((id) => component(after, id).fixed)).toEqual([false, false, false]);
  });

  it('ビードの質量は利用者が選んだ材質の密度で数える(溶加材の密度を仮定しない)', () => {
    const { after, beads } = welded();
    const partKeys = new Map<string, string>();
    const bodies = new Map<string, readonly AssemblyMassBody[]>();
    const placements = new Map<string, RigidPlacement>();
    // 立板 100×8×50、底板 100×60×10 は材質の指定なし(鋼 7.85)。ビードは公称体積(断面 24 mm² × 区間の長さ)。
    const volumes: Readonly<Record<string, number>> = {
      'component-1': 40000, 'component-2': 60000, [beads[0] ?? '']: 480, [beads[1] ?? '']: 360, [beads[2] ?? '']: 600,
    };
    for (const item of after.components) {
      partKeys.set(item.id, item.id);
      bodies.set(item.id, [{ volume: volumes[item.id] ?? Number.NaN, centroid: [0, 0, 0] }]);
      placements.set(item.id, rigidPlacementOf(item.placement));
    }
    const mass = assemblyMassProperties(after, { partKeys, bodies }, placements);
    expect(mass.partial).toBe(false);
    expect(mass.volume).toBe(101440);
    // 100000 mm³ × 7.85e-3 + 1440 mm³ × 2.68e-3(アルミニウム) = 785 + 3.8592 g。
    expect(mass.mass).toBeCloseTo(788.8592, 9);
  });

  it('計画の後に部品が動いた・版が変わった時は足さずに元の文書を返す', () => {
    const document = plainTee();
    const planned = plan(document);
    const moved = moveComponent(document, 'component-2', weldTestPlacement([0, 0, 1]));
    const afterMove = applyFilletWeld(moved, planned, WELD_TEST_REVISIONS);
    expect(afterMove.ok ? [] : afterMove.rejections.map((rejection) => rejection.code)).toEqual(['staleSource']);
    expect(afterMove.document).toBe(moved);
    const revised = applyFilletWeld(document, planned, new Map([['standing', 'rev-s2'], ['base', 'rev-b']]));
    expect(revised.ok ? [] : revised.rejections.map((rejection) => rejection.code)).toEqual(['staleSource']);
    expect(revised.document).toBe(document);
  });

  it('同じ計画を同じ文書へ足し直すと同じ文書になる(Undo は前の文書、Redo は同じ結果)', () => {
    const first = welded();
    const again = applyFilletWeld(first.before, plan(first.before), WELD_TEST_REVISIONS);
    expect(again.ok ? again.document : null).toEqual(first.after);
    expect(first.after).not.toBe(first.before);
  });
});

describe('すみ肉溶接を直す・消す', () => {
  it('保存した配置から溶接線を戻し、脚長・区間・材質を直すと古いビードを置き換えた1つの文書になる', () => {
    const { after, beads } = welded();
    const result = planFilletWeldEdit(after, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    const edit = result.plan;
    expectVec(edit.frame.origin, [0, 34, 10]);
    expectVec(edit.frame.xAxis, [0, 1, 0]);
    expectVec(edit.frame.zAxis, [1, 0, 0]);
    expect([edit.weldId, edit.firstComponentId, edit.secondComponentId, edit.contactLength]).toEqual(['weld-1', 'component-1', 'component-2', 100]);
    expect(edit.replacedComponentIds).toEqual(beads);
    // 5 × 5 / 2 × 100 = 1250 mm³。
    expect(edit.nominalVolume).toBe(1250);
    const applied = applyFilletWeld(after, edit, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const segments = weldSegmentsOf(applied.document).get('weld-1') ?? [];
    expect(segments).toHaveLength(1);
    expect(applied.document.components).toHaveLength(3);
    const bead = segments[0];
    expect(bead?.source.kind === 'standardPart' ? [bead.source.size, bead.source.options.length] : null).toEqual(['5x5', '100']);
    expect([bead?.materialId, bead?.rigidGroupId, component(applied.document, 'component-1').rigidGroupId])
      .toEqual(['steel', 'fastening-1', 'fastening-1']);
    expect(bead?.placement.position.map((value) => value.value)).toEqual([0, 34, 10]);
  });

  it('直した計画は、計画の後にビードが変わっていれば足さない', () => {
    const { after } = welded();
    const result = planFilletWeldEdit(after, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!result.ok) throw new Error('edit plan failed');
    const changed = removeComponent(after, 'component-4');
    const applied = applyFilletWeld(changed, result.plan, WELD_TEST_REVISIONS);
    expect(applied.ok ? [] : applied.rejections.map((rejection) => rejection.code)).toEqual(['componentMissing']);
    expect(applied.document).toBe(changed);
  });

  it('直す計画の後に溶接した部品が動いた・抑制された・消された・版が変わった時は、ビードが同じでも足さずに元の文書を返す', () => {
    const { after } = welded();
    const result = planFilletWeldEdit(after, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!result.ok) throw new Error('edit plan failed');
    expect(Object.keys(result.plan.sourceIdentities).sort())
      .toEqual(['component-1', 'component-2', 'component-3', 'component-4', 'component-5']);
    const base = component(after, 'component-2');
    const cases: readonly (readonly [string, AssemblyDocument, ReadonlyMap<string, string>, readonly string[]])[] = [
      // 組ごと動かすとビードも動くが、溶接した部品の配置の照合だけでも断れることを、部品だけを置き換えて確かめる。
      ['moved', replaceComponent(after, 'component-2', { ...base, placement: weldTestPlacement([0, 0, 1]) }), WELD_TEST_REVISIONS, ['staleSource']],
      ['suppressed', replaceComponent(after, 'component-2', { ...base, suppressed: true }), WELD_TEST_REVISIONS, ['componentSuppressed']],
      ['removed', removeComponent(after, 'component-2'), WELD_TEST_REVISIONS, ['componentMissing']],
      ['revised', after, new Map([['standing', 'rev-s'], ['base', 'rev-b2']]), ['staleSource']],
    ];
    for (const [label, document, revisions, expected] of cases) {
      const applied = applyFilletWeld(document, result.plan, revisions);
      expect(applied.ok ? [] : applied.rejections.map((rejection) => rejection.code), label).toEqual(expected);
      expect(applied.document, label).toBe(document);
    }
  });

  it('直す時も新しい脚長・区間の足元を部品のいまの面で確かめ直す(底板の端を越える脚は断る)', () => {
    const { after } = welded();
    const wide = planFilletWeldEdit(after, { ...EDIT, legOnSecond: 30 }, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(wide.ok ? [] : wide.rejections.map((rejection) => [rejection.code, rejection.detail.segment, rejection.detail.side]))
      .toEqual([['contactBoundaryCrossed', 0, 'second']]);
  });

  it('溶接の後に部品の形と版が変わった時、当たりが無くなっていれば直す計画を作らず、当たりが残っていれば確かめ直して作る', () => {
    const { after } = welded();
    const revised = new Map([['standing', 'rev-s'], ['base', 'rev-b2']]);
    // 底板が y 37 までに削られた: 保存した位置のまま置き直さず、足元を横切る端で断る。
    const narrowed = planFilletWeldEdit(after, EDIT, revised, teeBodies({ base: [weldTestBox([0, 0, 0], [100, 37, 10])] }));
    expect(narrowed.ok ? [] : narrowed.rejections.map((rejection) => rejection.code)).toEqual(['contactBoundaryCrossed']);
    // 版は変わったが当たりの所の形は同じ: いまの形で確かめ直した計画になり、確定の照合は新しい版で行う。
    const same = planFilletWeldEdit(after, EDIT, revised, teeBodies({ base: [BASE_BOX] }));
    if (!same.ok) throw new Error(JSON.stringify(same.rejections));
    expect(applyFilletWeld(after, same.plan, revised).ok).toBe(true);
    expect(applyFilletWeld(after, same.plan, WELD_TEST_REVISIONS).ok).toBe(false);
  });

  it('版の分からない溶接した部品の溶接は、直す計画を作らない', () => {
    const { after } = welded();
    const result = planFilletWeldEdit(after, EDIT, new Map([['standing', 'rev-s']]), TEE_BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => [rejection.code, rejection.detail.componentId]))
      .toEqual([['missingSourceRevision', 'component-2']]);
  });

  it('1区間だけ動いた・溶接した部品が無い・知らない溶接・区間の誤りは理由付きで断る', () => {
    const { after } = welded();
    const bead = component(after, 'component-4');
    const shifted = replaceComponent(after, 'component-4', {
      ...bead, placement: weldTestPlacement(addVec3([40, 34, 10], [0, 1, 0]), bead.placement.rotation),
    });
    const damaged = planFilletWeldEdit(shifted, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(damaged.ok ? [] : damaged.rejections.map((rejection) => rejection.code)).toEqual(['weldDamaged']);
    const missingPart = planFilletWeldEdit(removeComponent(after, 'component-2'), EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(missingPart.ok ? [] : missingPart.rejections.map((rejection) => rejection.code)).toEqual(['componentMissing']);
    const unknown = planFilletWeldEdit(after, { ...EDIT, weldId: 'weld-7' }, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(unknown.ok ? [] : unknown.rejections.map((rejection) => rejection.code)).toEqual(['weldMissing']);
    const outside = planFilletWeldEdit(after, { ...EDIT, segments: [{ start: 90, length: 20 }] }, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(outside.ok ? [] : outside.rejections.map((rejection) => rejection.code)).toEqual(['segmentOutsideContact']);
    const noMaterial = planFilletWeldEdit(after, { ...EDIT, materialId: '' }, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(noMaterial.ok ? [] : noMaterial.rejections.map((rejection) => rejection.code)).toEqual(['materialRequired']);
  });

  it('組の外へ出された溶接は直さずに断る', () => {
    const { after } = welded();
    const released = replaceComponent(after, 'component-1', { ...component(after, 'component-1'), rigidGroupId: undefined });
    const result = planFilletWeldEdit(released, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => [rejection.code, rejection.detail.componentId]))
      .toEqual([['weldDamaged', 'component-1']]);
  });

  it('溶接を消すとビードだけが消え、溶接した部品の組は残る。次の溶接の番号は残っている番号の次', () => {
    const { after, beads } = welded();
    expect(nextWeldId(after)).toBe('weld-2');
    const removed = removeFilletWeld(after, beads);
    expect(removed.components.map((item) => item.id)).toEqual(['component-1', 'component-2']);
    expect(removed.components.map((item) => item.rigidGroupId)).toEqual(['fastening-1', 'fastening-1']);
    expect(weldSegmentsOf(removed).size).toBe(0);
    expect(removeFilletWeld(after, [])).toBe(after);
  });

  it('溶接線の座標系が壊れていれば配置を作らない', () => {
    const frame = plan(plainTee()).frame;
    expect(weldSegmentPlacement({ ...frame, zAxis: [-1, 0, 0] }, 0)).toBeNull();
    expect(weldSegmentPlacement({ ...frame, xAxis: [0, 2, 0] }, 0)).toBeNull();
    expect(weldSegmentPlacement(frame, Number.NaN)).toBeNull();
  });
});

/** 2部品の id を利用者の名付け(読点・印の頭・`%`・`:` を含む)に替えた T 継手。 */
function namedTee(first: string, second: string): AssemblyDocument {
  const document = plainTee();
  return { ...document, components: document.components.map((item) => ({ ...item, id: item.id === 'component-1' ? first : second })) };
}

function namedRequestPlan(document: AssemblyDocument, first: string, second: string): FilletWeldPlan {
  const result = planFilletWeld(document, teeRequest({
    first: planeFace(first, 'standing', [50, 8, 25], [0, 1, 0]), second: planeFace(second, 'base', [50, 30, 10], [0, 0, 1]),
  }), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

function weldPartsOf(document: AssemblyDocument, ids: readonly string[]): readonly (string | undefined)[] {
  return ids.map((id) => {
    const source = component(document, id).source;
    return source.kind === 'standardPart' ? source.options.weldParts : undefined;
  });
}

describe('読点を含む部品の id の溶接', () => {
  // 期待する欄は手で書いた: 読点を含む時は `v2:` の後に2つの id を `:` でつなぎ、id の中の `%`・`,`・`:` を `%25`・`%2C`・`%3A` にする。
  const NAMED = [
    ['立板,左', 'v2:底板%2C:1', 'v2:立板%2C左:v2%3A底板%252C%3A1'],
    ['plate', 'base,A,B', 'v2:plate:base%2CA%2CB'],
  ] as const;

  it.each(NAMED)('確定・直す・Undo/Redo で2部品の id (%s / %s) を失わない', (first, second, stored) => {
    const before = namedTee(first, second);
    const applied = applyFilletWeld(before, namedRequestPlan(before, first, second), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    expect(weldPartsOf(applied.document, applied.componentIds)).toEqual([stored, stored, stored]);
    for (const id of applied.componentIds) {
      const source = component(applied.document, id).source;
      if (source.kind !== 'standardPart') throw new Error('not standard');
      expect(filletWeldSegmentOptions(source.options)?.parts).toEqual([first, second]);
      expect(buildStandardPartFromSource(source)).not.toBeNull();
    }
    expect(new Set([first, second, ...applied.componentIds].map((id) => component(applied.document, id).rigidGroupId)).size).toBe(1);
    // Undo は前の文書(溶接した2部品は id も含めて元のまま)、Redo は同じ計画を足し直した同じ文書。
    expect(JSON.stringify(before)).toBe(JSON.stringify(namedTee(first, second)));
    const redone = applyFilletWeld(before, namedRequestPlan(before, first, second), WELD_TEST_REVISIONS);
    expect(redone.ok ? redone.document : null).toEqual(applied.document);

    const edit = planFilletWeldEdit(applied.document, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    expect([edit.plan.firstComponentId, edit.plan.secondComponentId]).toEqual([first, second]);
    expect(edit.plan.replacedComponentIds).toEqual(applied.componentIds);
    const edited = applyFilletWeld(applied.document, edit.plan, WELD_TEST_REVISIONS);
    if (!edited.ok) throw new Error(JSON.stringify(edited.rejections));
    expect(weldPartsOf(edited.document, edited.componentIds)).toEqual([stored]);
    expect(edited.document.components.map((item) => item.id).slice(0, 2)).toEqual([first, second]);
    // 直しの Undo で戻る文書は、前のビード3つの欄をそのまま持ち、直し直せる。
    expect(weldPartsOf(applied.document, applied.componentIds)).toEqual([stored, stored, stored]);
    expect(planFilletWeldEdit(applied.document, EDIT, WELD_TEST_REVISIONS, TEE_BODIES).ok).toBe(true);
  });

  it('読点を含まない id は印の頭で始まっても従来どおり `<1つ目>,<2つ目>` で書き、同じに読む', () => {
    const before = namedTee('v2:a', 'b%2C');
    const applied = applyFilletWeld(before, namedRequestPlan(before, 'v2:a', 'b%2C'), WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    expect(weldPartsOf(applied.document, applied.componentIds)).toEqual(['v2:a,b%2C', 'v2:a,b%2C', 'v2:a,b%2C']);
    const edit = planFilletWeldEdit(applied.document, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(edit.ok ? [edit.plan.firstComponentId, edit.plan.secondComponentId] : edit.rejections).toEqual(['v2:a', 'b%2C']);
  });

  it('保存した欄は、古い値をそのまま読み、印付きの版は1通りだけ読み、壊れた・曖昧な値は断る', () => {
    const { after } = welded();
    const bead = component(after, 'component-3');
    if (bead.source.kind !== 'standardPart') throw new Error('not standard');
    const source = bead.source;
    const parts = (weldParts: string): unknown => filletWeldSegmentOptions({ ...source.options, weldParts })?.parts ?? null;
    expect(parts('component-1,component-2')).toEqual(['component-1', 'component-2']);
    expect(parts('v2:a,b')).toEqual(['v2:a', 'b']);
    expect(parts('a%2Cb,c')).toEqual(['a%2Cb', 'c']);
    expect(parts('v2:a%2Cb:c')).toEqual(['a,b', 'c']);
    expect(parts('v2:%25%3A%2C:x')).toEqual(['%:,', 'x']);
    expect(parts('v2:c:a%2Cb')).toEqual(['c', 'a,b']);
    const refused = [
      '', ',', 'a,', ',b', 'a,a', 'a,b,c', 'component-1', 'a%2Cb:c', 'v3:a%2Cb:c', 'v2:', 'v2:a%2Cb', 'v2:a%2Cb:',
      'v2::a%2Cb', 'v2:a%2Cb:a%2Cb', 'v2:a%2Cb:c:d', 'v2:a:b', 'v2:a%2cb:c', 'v2:a%2Cb:c%41', 'v2:a%2Cb:c%', 'v2:a%2Cb:c%2',
    ];
    for (const weldParts of refused) {
      expect(parts(weldParts), weldParts).toBeNull();
      expect(buildStandardPartFromSource({ ...source, options: { ...source.options, weldParts } }), weldParts).toBeNull();
    }
  });
});
