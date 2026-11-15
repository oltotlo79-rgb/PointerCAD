/**
 * 図面の組図（画面で開いていない事がある）を組む前に、規格部品の族の表を登録口から読み込んで待つ（K1、設計 §5.4）。
 */
import {
  addComponent, createAssemblyDocument, createComponentFor, PRODUCT_CATALOG_REGISTRY, type AssemblyKernelBridge,
  type ComponentSource,
} from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { prepareAssemblyDrawingSource } from './prepareAssemblyDrawingSource.js';

const catalogItem: ComponentSource = {
  kind: 'standardPart', catalog: 'catalogItem', size: '3',
  options: { family: 'drawing-test-family', item: 'drawing-test-family:3', length: '10' },
  catalogRevision: 'drawing-test-r1', generatorRevision: 'drawing-test-1',
};

function assemblyWith(source: ComponentSource) {
  const document = createAssemblyDocument('図面の組図');
  return { sourceKind: 'assembly' as const, document: addComponent(document, createComponentFor(document, source)) };
}

const unusedBridge = {} as AssemblyKernelBridge;

afterEach(() => { vi.restoreAllMocks(); });

describe('図面の組図の族の部品', () => {
  it('組む前に族の表を読み込んで待ち、断られた時は 150 字以内の文で止め、部品を計算しない', async () => {
    const ensure = vi.spyOn(PRODUCT_CATALOG_REGISTRY, 'ensure').mockRejectedValue(new Error('network'));
    const recompute = vi.fn();
    const input = assemblyWith(catalogItem);
    await expect(prepareAssemblyDrawingSource(input, 'source-1', 'drawing-1', unusedBridge, recompute,
      () => false, () => undefined)).rejects.toThrow(t('catalog.loading.documentFailed'));
    expect(ensure).toHaveBeenCalledTimes(1);
    expect([...ensure.mock.calls[0][0]]).toEqual(['drawing-test-family']);
    expect(recompute).not.toHaveBeenCalled();
    expect(t('catalog.loading.documentFailed').length).toBeLessThanOrEqual(150);
    // 図面の文書の組図は変えない。
    expect(input.document.components[0].source).toEqual(catalogItem);
  });

  it('読み込めた後は今までどおり組む（登録されていない族は、今までどおり「部品を選べない」で止まる）', async () => {
    const ensure = vi.spyOn(PRODUCT_CATALOG_REGISTRY, 'ensure').mockResolvedValue();
    const recompute = vi.fn();
    await expect(prepareAssemblyDrawingSource(assemblyWith(catalogItem), 'source-1', 'drawing-1', unusedBridge, recompute,
      () => false, () => undefined)).rejects.toThrow(t('drawing.error.selectSource'));
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(recompute).not.toHaveBeenCalled();
  });

  it('族の部品が無い組図では登録口を呼ばない', async () => {
    const ensure = vi.spyOn(PRODUCT_CATALOG_REGISTRY, 'ensure');
    const part: ComponentSource = { kind: 'part', partRef: 'missing-part' };
    await expect(prepareAssemblyDrawingSource(assemblyWith(part), 'source-1', 'drawing-1', unusedBridge, vi.fn(),
      () => false, () => undefined)).rejects.toThrow(t('drawing.error.selectSource'));
    expect(ensure).not.toHaveBeenCalled();
  });
});
