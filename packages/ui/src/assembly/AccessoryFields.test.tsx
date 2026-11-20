/**
 * 付属の組の欄(A2): 当てはまる組が無い時は何も出さない事、付けない時は組の欄だけ、組を選んだ時は端・長さの意味・行の欄と予告、
 * 全部の欄に説明(title)がある事。Node の検査なので描いた文字で見る(DimensionFigure.test.tsx と同じ考え)。
 */
import {
  addComponent, applyAccessorySet, createAssemblyDocument, createComponentFor, PIPE_END_FITTING_FAMILY_IDS, PRODUCT_CATALOG_REGISTRY,
} from '@pointercad/model';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { AccessoryFields, StandardAccessoryFields } from './AccessoryFields.js';
import { standardAccessoryOptionsFor, familyAccessoryProps, pickedAccessory, rememberAccessory } from './accessoryChoice.js';
import { commitStandardPartChoice } from './standardPartPicker.js';

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-s6', 't-slot-frame-cap']); });
afterEach(() => { rememberAccessory({ setId: null, ends: 'both', endReference: 'overall', itemKey: '' }); });

function options() {
  const family = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-frame-s6');
  return familyAccessoryProps(family, family?.rows.find((row) => row.key === 's6-20x20'), { length: '1000' }).options;
}

describe('付属の組の欄', () => {
  it('当てはまる組が無ければ何も出さない', () => {
    expect(renderToStaticMarkup(<AccessoryFields options={[]} lengthMm={1000} showEnds />)).toBe('');
  });

  it('付けない時は組の欄だけで、説明を持つ', () => {
    const html = renderToStaticMarkup(<AccessoryFields options={options()} lengthMm={1000} showEnds />);
    expect(html).toContain(`title="${t('assembly.accessory.setGuide')}"`);
    expect(html).toContain(t('assembly.accessory.setFrameEndCaps'));
    expect(html).not.toContain(t('assembly.accessory.ends'));
  });

  it('組を選ぶと、端・長さの意味・行の欄(候補 2 つ)と、本体 994 mm の予告が出る', () => {
    rememberAccessory({ setId: 'frame-end-caps', ends: 'both', endReference: 'overall', itemKey: '' });
    const html = renderToStaticMarkup(<AccessoryFields options={options()} lengthMm={1000} showEnds />);
    for (const key of ['assembly.accessory.endsGuide', 'assembly.accessory.referenceGuide', 'assembly.accessory.itemGuide'] as const) {
      expect(html).toContain(`title="${t(key)}"`);
    }
    expect(html).toContain(t('assembly.accessory.preview').replace('{length}', '994').replace('{name}', '端のキャップ 溝幅 6 20×20')
      .replace('{count}', '2').replace('{thickness}', '3'));
  });

  it('ボルトの組を選ぶと、締め付ける厚さ(既定を薄く出す)とばね座金の欄と予告が出て、全部に説明がある(A4)', () => {
    const bolt = standardAccessoryOptionsFor('hexBolt', 'hexBolt:JIS-B-1180:2014:M8:P1.25:annexJA', '40', 'annexJA', 'coarse');
    rememberAccessory({ setId: 'bolt-washer-nut', ends: 'both', endReference: 'overall', itemKey: '', springWasher: true });
    const html = renderToStaticMarkup(<AccessoryFields options={bolt} lengthMm={null} showEnds />);
    for (const key of ['assembly.accessory.gripGuide', 'assembly.accessory.springGuide'] as const) expect(html).toContain(`title="${t(key)}"`);
    expect(html).toContain(t('assembly.accessory.previewBoltSpring').replace('{grip}', String(bolt[0]?.defaultGripMm?.spring)));
    expect(html).not.toContain(`title="${t('assembly.accessory.endsGuide')}"`);
  });

  it('一括配置では端の欄を出さず、端の決め方を予告に書く', () => {
    rememberAccessory({ setId: 'frame-end-caps', ends: 'start', endReference: 'overall', itemKey: '' });
    const html = renderToStaticMarkup(<AccessoryFields options={options()} lengthMm={null} showEnds={false} />);
    expect(html).not.toContain(`title="${t('assembly.accessory.endsGuide')}"`);
    expect(html).toContain(t('assembly.accessory.previewLayout').replace('{name}', '端のキャップ 溝幅 6 20×20').replace('{thickness}', '3'));
  });

  it('軸受の止め輪の組を選ぶと、端の欄と予告(2 個・厚さ 1.2)が出て、長さの意味の欄は出さない(A6)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['c-ring-shaft', 'c-ring-bore']);
    const rings = standardAccessoryOptionsFor('deepGrooveBallBearing', 'deepGrooveBallBearing:JIS-B-1521:2012:6204', '', 'annexJA', 'coarse');
    rememberAccessory({ setId: 'bearing-shaft-rings', ends: 'both', endReference: 'overall', itemKey: '' });
    const html = renderToStaticMarkup(<AccessoryFields options={rings} lengthMm={null} showEnds />);
    expect(html).toContain(t('assembly.accessory.setBearingShaftRings'));
    expect(html).toContain(`title="${t('assembly.accessory.endsGuide')}"`);
    expect(html).not.toContain(`title="${t('assembly.accessory.referenceGuide')}"`);
    expect(html).toContain(t('assembly.accessory.previewNoLength').replace('{name}', '軸用 C 形止め輪 20').replace('{count}', '2')
      .replace('{thickness}', '1.2'));
  });

  it('鋼管の端の継手の組でエルボを選ぶと、長さの意味・継手の種類・枝の向きの欄と管 944.78 mm の予告が出る。ソケットには枝の向きを出さない(K-28 束 3)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(PIPE_END_FITTING_FAMILY_IDS);
    const pipe = standardAccessoryOptionsFor('structuralSection', 'steel:SGP:steelPipe:25A', '1000', 'annexJA', 'coarse');
    rememberAccessory({ setId: 'pipe-end-fittings', ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', turn: 1 });
    const html = renderToStaticMarkup(<AccessoryFields options={pipe} lengthMm={1000} showEnds />);
    expect(html).toContain(t('assembly.accessory.setPipeEndFittings'));
    for (const key of ['assembly.accessory.pipeReferenceGuide', 'assembly.accessory.pipeItemGuide', 'assembly.accessory.turnGuide'] as const) {
      expect(html).toContain(`title="${t(key)}"`);
    }
    expect(html).toContain(t('assembly.accessory.pipeReferenceOverall'));
    expect(html).toContain('<option value="1" selected="">90°</option>');
    expect(html).toContain(t('assembly.accessory.pipePreview').replace('{length}', '944.78').replace('{name}', 'エルボ 25A (Rc1)').replace('{count}', '2'));
    rememberAccessory({ setId: 'pipe-end-fittings', ends: 'both', endReference: 'overall', itemKey: 'socket-25A' });
    expect(renderToStaticMarkup(<AccessoryFields options={pipe} lengthMm={1000} showEnds />)).not.toContain(`title="${t('assembly.accessory.turnGuide')}"`);
  });

  it('8 分類の窓の鋼管は長さの欄の値から管 944.78 mm を予告し、置いた時の管の長さも同じ値になる。長さが範囲外なら組の欄を出さない(K-28 束 3)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(PIPE_END_FITTING_FAMILY_IDS);
    const choice = { category: 'structuralSection', key: 'steel:SGP:steelPipe:25A', lengthSource: '1000', dimensionSeries: 'annexJA',
      threadSeries: 'coarse' } as const;
    rememberAccessory({ setId: 'pipe-end-fittings', ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', turn: 1 });
    expect(renderToStaticMarkup(<StandardAccessoryFields choice={choice} />))
      .toContain(t('assembly.accessory.pipePreview').replace('{length}', '944.78').replace('{name}', 'エルボ 25A (Rc1)').replace('{count}', '2'));
    // 予告(accessoryPreview)と置く時(applyAccessorySet)は別の関数で管の長さを出すので、窓と同じ指定で置いた管の長さと突き合わせる。
    const committed = commitStandardPartChoice(choice.category, choice.key, choice.lengthSource, choice.dimensionSeries, choice.threadSeries);
    const picked = pickedAccessory(standardAccessoryOptionsFor(choice.category, choice.key, choice.lengthSource, choice.dimensionSeries,
      choice.threadSeries));
    if (!committed.ok || picked === undefined) throw new Error('pipe choice missing');
    const empty = createAssemblyDocument('pipe-preview');
    const host = createComponentFor(empty, committed.value.source);
    const applied = applyAccessorySet(addComponent(empty, host), host.id, picked.setId, picked.choices, PRODUCT_CATALOG_REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const placed = applied.value.document.components.find((component) => component.id === host.id)?.source;
    expect(placed?.kind === 'standardPart' ? placed.options.length : undefined).toBe('944.78');
    expect(renderToStaticMarkup(<StandardAccessoryFields choice={{ ...choice, lengthSource: '20000' }} />)).toBe('');
  });

  it('8 分類の窓の深溝玉軸受には長さの欄の値を渡さず、今までどおり長さの無い予告を出す(A6)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['c-ring-shaft', 'c-ring-bore']);
    rememberAccessory({ setId: 'bearing-shaft-rings', ends: 'both', endReference: 'overall', itemKey: '' });
    const html = renderToStaticMarkup(<StandardAccessoryFields choice={{ category: 'deepGrooveBallBearing',
      key: 'deepGrooveBallBearing:JIS-B-1521:2012:6204', lengthSource: '1000', dimensionSeries: 'annexJA', threadSeries: 'coarse' }} />);
    expect(html).toContain(t('assembly.accessory.previewNoLength').replace('{name}', '軸用 C 形止め輪 20').replace('{count}', '2')
      .replace('{thickness}', '1.2'));
  });
});
