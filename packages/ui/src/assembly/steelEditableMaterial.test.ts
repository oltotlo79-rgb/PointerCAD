/**
 * K-06 の残り: 「編集できる鋼材」(鋼材の部品文書を保存してから置く道)と、鋼材の部品文書のファイルを置く時も、部品文書の元の鋼材(steelStockSource)の
 * 鋼種から、鋼材の規格部品と同じ表で質量の材料を部品に付ける。部品ファイルの形は変えない(材質は部品〔component〕の欄に付ける)。
 * 元の鋼材を持たない部品文書は付けない(前と同じ形)。
 */
import {
  ALL_STEEL_PRODUCTS, createAssemblyDocument, createEmptyPartDocument, emptyEmbeddedPartAttachments, type AssemblyComponent,
  type PartDocument, type SteelMaterialGrade,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitPlaceComponent } from './placeComponentActions.js';
import { buildEditableSteelPart } from './steelEditablePart.js';

function steelDocument(grade: SteelMaterialGrade): PartDocument {
  const product = ALL_STEEL_PRODUCTS.find((candidate) => candidate.materialGrade === grade);
  if (product === undefined) throw new Error(`no rows for ${grade}`);
  const built = buildEditableSteelPart(`steel:${product.key}`, '1000', () => `lineage-${grade}`);
  if (!built.ok) throw new Error(`editable ${grade} refused: ${built.reason}`);
  return built.document;
}

async function place(document: PartDocument): Promise<void> {
  const state = useAppStore.getState();
  useAppStore.setState({ assemblyPlacement: { kind: 'ready', requestId: `request-${document.id}`, documentId: state.activeDocumentId,
    fileName: `${document.name}.pcad`, document, attachments: emptyEmbeddedPartAttachments(), sources: ['0', '0', '0'] } });
  const outcome = await commitPlaceComponent();
  expect(outcome?.ok).toBe(true);
}

function lastPlaced(): AssemblyComponent {
  const component = useAppStore.getState().assembly?.components.at(-1);
  if (component === undefined) throw new Error('nothing placed');
  return component;
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openAssembly(createAssemblyDocument('編集できる鋼材の材質'));
});
afterEach(() => { resetTestStore(); });

describe('K-06 編集できる鋼材の部品の材質', () => {
  it.each([['SUS304TP', 'stainless'], ['SS400', 'steel'], ['STKR400', 'steel']] as const)(
    '%s の鋼材の部品文書を置くと、部品に材質 %s が付き、部品文書は変えない', async (grade, materialId) => {
      const document = steelDocument(grade);
      expect(document.steelStockSource?.options.materialGrade).toBe(grade);
      const before = structuredClone(document);
      await place(document);
      expect(lastPlaced().materialId).toBe(materialId);
      expect(document).toEqual(before);
    });

  it('元の鋼材を持たない部品文書は、材質を付けない(前と同じ形)', async () => {
    const document: PartDocument = { ...createEmptyPartDocument(), name: '箱' };
    expect(document.steelStockSource).toBeUndefined();
    await place(document);
    expect(Object.hasOwn(lastPlaced(), 'materialId')).toBe(false);
  });
});
