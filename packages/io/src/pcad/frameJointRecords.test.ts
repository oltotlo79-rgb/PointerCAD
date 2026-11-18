/**
 * フレームどうしの接続の記録(E-07)の保存と読み込み: 記録を使った文書は保存形式の版 23 で書いて読み戻せる事、記録を使わない文書は今までと同じ形
 * (欄を書かず版も変えない)である事、版 23 より前の版に記録を持たせると保存の境界で断る事、版 23 より前のファイルに欄があると読まずに断る事。
 */
import { addComponent, createAssemblyDocument, createComponentFor, type AssemblyDocument, type FrameJointRecord } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readFrameJointRecords } from './codecs/frameJointRecords.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

function threeParts(): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  for (const partRef of ['part-1', 'part-2', 'part-3']) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }, {}));
  }
  return document;
}

const RECORD: FrameJointRecord = { id: 'frame-joint-1', kind: 'L',
  members: [{ componentId: 'component-1', part: 'end' }, { componentId: 'component-2', part: 'start' }],
  bracket: { componentId: 'component-3', orientation: 'aOnBase',
    faces: [{ componentId: 'component-1', face: 'right' }, { componentId: 'component-2', face: 'top' }] },
  fastenerIds: [], choices: { nominal: 'M5', nutEntry: '後入れ', nutMaterial: 'steel' } };

describe('フレームどうしの接続の記録の保存', () => {
  it('記録を使った文書は版 23 で書いて読み戻せる', () => {
    const document: AssemblyDocument = { ...threeParts(), schemaVersion: 23, frameJoints: [RECORD] };
    const read = readAssemblyDocument(writeAssemblyDocument(document));
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect([read.document.schemaVersion, read.document.frameJoints]).toEqual([23, [RECORD]]);
  });

  it('記録を使わない文書は欄を書かず、版も今までのまま', () => {
    const text = writeAssemblyDocument(threeParts());
    expect(text.includes('frameJoints')).toBe(false);
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect([read.document.schemaVersion, read.document.frameJoints]).toEqual([PCAD_SCHEMA_VERSION, undefined]);
  });

  it('版 23 より前の版の文書に記録を持たせると、保存の境界で断る', () => {
    expect(() => writeAssemblyDocument({ ...threeParts(), frameJoints: [RECORD] })).toThrow(/版23/u);
  });

  it('版 23 より前のファイルに記録の欄があると、読まずに断る(古い形のまま記録を捨てない)', () => {
    const text = writeAssemblyDocument(threeParts()).replace('"components":', '"frameJoints": [], "components":');
    const read = readAssemblyDocument(text);
    expect(read.ok ? 'ok' : read.error.message).toMatch(/版23/u);
  });

  it('記録の型が違う(形の名前・重なる id・部材が 1 本)時は読まない。部品の id が文書に無い記録は読む(作り直しの一覧が扱う)', () => {
    expect(readFrameJointRecords([{ ...RECORD, kind: 'X' }], 'frameJoints').ok).toBe(false);
    expect(readFrameJointRecords([RECORD, RECORD], 'frameJoints').ok).toBe(false);
    expect(readFrameJointRecords([{ ...RECORD, members: [{ componentId: 'component-1', part: 'end' }] }], 'frameJoints').ok).toBe(false);
    expect(readFrameJointRecords([{ ...RECORD, bracket: { ...RECORD.bracket, componentId: 'missing' } }], 'frameJoints').ok).toBe(true);
  });
});
