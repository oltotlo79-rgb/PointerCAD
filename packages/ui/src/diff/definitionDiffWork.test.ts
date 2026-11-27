import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createPrimitiveFeature } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { PCAD_TEMPLATE_KIND, writePcadFile } from '@pointercad/io';
import { executeDefinitionDiffWork } from './definitionDiffWork.js';
import { DEFINITION_DIFF_MAX_FILE_BYTES, isDefinitionDiffReply } from './definitionDiffProtocol.js';

describe('実ファイルを別々に読んだ比較結果を画面へ返す', () => {
  it('保存ファイル2個の差を求め、元の圧縮バイト列を更新しない', async () => {
    const empty = createEmptyPartDocument(), original = { ...empty, solids: [createPrimitiveFeature(empty, 'box')] };
    const before = writePcadFile(original), after = writePcadFile({ ...original, solids: [{ ...original.solids[0],
      shape: { kind: 'box', sizeX: expressionValueFromNumber(30), sizeY: expressionValueFromNumber(20), sizeZ: expressionValueFromNumber(20) } }] });
    const originals = [[...before], [...after]];
    const result = await executeDefinitionDiffWork({ kind: 'compare', before, after, relationship: 'versions' });
    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') { expect(result.result.geometryCompared).toBe(false); expect(result.result.changes.some(change => change.group === 'solid')).toBe(true); }
    expect([[...before], [...after]]).toEqual(originals);
  });
  it('片側の破損、不正な関係、ひな形を完成した比較に読み替えない', async () => {
    const bytes = writePcadFile(createEmptyPartDocument());
    expect(await executeDefinitionDiffWork({ kind: 'compare', before: bytes, after: new Uint8Array([1]), relationship: 'versions' }))
      .toEqual({ kind: 'failed', failure: { code: 'documentRead', reason: 'notZip' } });
    for (const request of [{ kind: 'compare', before: bytes, after: bytes, relationship: 'guess' },
      { kind: 'inspect', bytes: 'not bytes' }]) {
      expect(await executeDefinitionDiffWork(request)).toEqual({ kind: 'failed', failure: { code: 'invalidRequest' } });
    }
    const template = writePcadFile(createEmptyPartDocument(), { kind: PCAD_TEMPLATE_KIND });
    expect(await executeDefinitionDiffWork({ kind: 'inspect', bytes: template }))
      .toEqual({ kind: 'failed', failure: { code: 'partRequired' } });
  });
});

describe('比較Workerの失敗返信', () => {
  it('既知の読込理由と追加診断を受理し、生の例外文を拒否する', () => {
    expect(isDefinitionDiffReply({ kind: 'failed',
      failure: { code: 'documentRead', reason: 'invalidField', diagnostic: 'partAttachmentDigestMismatch' } })).toBe(true);
    for (const bad of [
      { kind: 'failed', message: 'raw' },
      { kind: 'failed', failure: { code: 'documentRead', reason: 'other' } },
      { kind: 'failed', failure: { code: 'documentRead', reason: 'invalidField', diagnostic: 'other' } },
      { kind: 'failed', failure: { code: 'internal', message: 'raw' } },
    ]) expect(isDefinitionDiffReply(bad)).toBe(false);
  });
});

describe('文書の種類の指定', () => {
  it('保存点から渡す比較入力でも、圧縮ファイルの上限を読込み前に報告する', async () => {
    const before = new Uint8Array(DEFINITION_DIFF_MAX_FILE_BYTES + 1);
    const after = new Uint8Array();
    expect(await executeDefinitionDiffWork({ kind: 'compare', before, after, relationship: 'versions', documentKind: 'assembly' }))
      .toEqual({ kind: 'failed', failure: { code: 'fileLimit' } });
  });
  it('不明な種類は失敗にし、種類の違うファイルを組立・図面として読まない', async () => {
    const bytes = writePcadFile(createEmptyPartDocument());
    for (const documentKind of ['sheet', 'assembly', 'drawing']) {
      expect((await executeDefinitionDiffWork({ kind: 'compare', before: bytes, after: bytes, relationship: 'versions', documentKind })).kind).toBe('failed');
    }
  });
});
