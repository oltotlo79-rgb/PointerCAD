import {
  createAssemblyDocument, createEmptyPartDocument, DEFAULT_COMPONENT_PLACEMENT,
  type AssemblyComponent, type AssemblyDocument, type ComponentSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const SAVED_AT = '2026-09-08T00:00:00.000Z';

function expressionValueFromNumber(value: number) {
  return { source: String(value), value, display: String(value) };
}

function component(id: string, source: ComponentSource): AssemblyComponent {
  return {
    id, name: id, source, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false,
  };
}

function assembly(components: readonly AssemblyComponent[] = []): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), components };
}

function sub(ref: string): AssemblyComponent {
  return component('component-1', { kind: 'subAssembly', assemblyRef: ref });
}

function documentWithMotion(): AssemblyDocument {
  const first = component('component-1', { kind: 'part', partRef: 'part-1' });
  const second = component('component-2', { kind: 'part', partRef: 'part-2' });
  return {
    ...assembly([first, second]),
    joints: [{
      id: 'joint-1', name: '回転', kind: 'revolute',
      a: { kind: 'origin', componentId: first.id, element: 'z' },
      b: { kind: 'origin', componentId: second.id, element: 'z' },
      minValue: null, maxValue: null, suppressed: false,
    }],
    presentation: [
      {
        id: 'step-1', name: '分解1', start: 0, end: 0.25,
        body: {
          kind: 'explode', componentIds: [second.id], direction: { kind: 'world', axis: 'z' },
          distance: expressionValueFromNumber(30),
        },
      },
      {
        id: 'step-2', name: '回転1', start: 0.25, end: 0.75,
        body: {
          kind: 'joint', jointId: 'joint-1', from: expressionValueFromNumber(0),
          to: expressionValueFromNumber(90), coordinate: 'angle', referenceAngle: 0,
        },
      },
      {
        id: 'step-3', name: '分解2', start: 0.75, end: 1,
        body: {
          kind: 'explode', componentIds: [first.id, second.id], direction: { kind: 'world', axis: 'x' },
          distance: expressionValueFromNumber(10),
        },
      },
    ],
    bom: { columns: ['name', 'quantity', 'mass'], sortBy: 'mass', expandSubAssemblies: true },
  };
}

function chain(length: number): {
  readonly root: AssemblyDocument;
  readonly documents: ReadonlyMap<string, AssemblyDocument>;
} {
  const documents = new Map<string, AssemblyDocument>();
  for (let index = 1; index <= length; index += 1) {
    documents.set(`assembly-${index}`, index === length
      ? assembly([])
      : assembly([sub(`assembly-${index + 1}`)]));
  }
  return { root: assembly([sub('assembly-1')]), documents };
}

function corrupt(text: string, from: string, to: string) {
  const changed = text.replace(from, to);
  if (changed === text) throw new Error(`検査用の置換対象が無い: ${from}`);
  return readAssemblyDocument(changed);
}

describe('アセンブリ文書の追加欄と意味検証', () => {
  it('ジョイントとnullの可動範囲を往復する', () => {
    const source = documentWithMotion();
    const result = readAssemblyDocument(writeAssemblyDocument(source, { savedAt: SAVED_AT }));
    expect(result.ok && result.document.joints).toEqual(source.joints);
  });

  it('分解と駆動の3ステップを区間ごと往復する', () => {
    const source = documentWithMotion();
    const result = readAssemblyDocument(writeAssemblyDocument(source, { savedAt: SAVED_AT }));
    expect(result.ok && result.document.presentation).toEqual(source.presentation);
  });

  it('部品表の設定を往復する', () => {
    const source = documentWithMotion();
    const result = readAssemblyDocument(writeAssemblyDocument(source, { savedAt: SAVED_AT }));
    expect(result.ok && result.document.bom).toEqual(source.bom);
  });

  it('版は8のまま', () => {
    expect(documentWithMotion().schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('startとendが同じステップを断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"end": 0.25', '"end": 0');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });

  it('範囲が1を超えるステップを断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"end": 1', '"end": 1.1');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });

  it('知らないジョイント種類を断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"kind": "revolute"', '"kind": "unknown"');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });

  it('存在しない部品を指すジョイントを断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"componentId": "component-1"', '"componentId": "component-9"');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });

  it('存在しないジョイントを指すステップを断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"jointId": "joint-1"', '"jointId": "joint-9"');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });

  it('分解ステップ内の部品id重複を断る', () => {
    const text = writeAssemblyDocument(documentWithMotion(), { savedAt: SAVED_AT });
    const result = corrupt(text, '"component-1",\n            "component-2"', '"component-1",\n            "component-1"');
    expect(result.ok ? null : result.error.code).toBe('invalidField');
  });
});

describe('.pcadaのサブアセンブリ', () => {
  it('1段をparts/<ref>.jsonで往復する', async () => {
    const nested = assembly([]);
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), {
      savedAt: SAVED_AT, assemblies: new Map([['assembly-a', nested]]),
    }));
    expect(result.ok && result.assemblies.get('assembly-a')).toEqual(nested);
  });

  it('2段を同じ名前空間で往復する', async () => {
    const nested = assembly([sub('assembly-b')]);
    const leaf = assembly([]);
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), {
      savedAt: SAVED_AT, assemblies: new Map([['assembly-a', nested], ['assembly-b', leaf]]),
    }));
    expect(result.ok && [...result.assemblies.keys()]).toEqual(['assembly-a', 'assembly-b']);
  });

  it('サブアセンブリの中の部品も同じファイルから引ける', async () => {
    const nested = assembly([component('component-1', { kind: 'part', partRef: 'part-1' })]);
    const part = createEmptyPartDocument();
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), {
      savedAt: SAVED_AT, assemblies: new Map([['assembly-a', nested]]), parts: new Map([['part-1', part]]),
    }));
    expect(result.ok && result.parts.get('part-1')).toEqual(part);
  });

  it('参照するサブアセンブリが欠けていれば断る', async () => {
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), { savedAt: SAVED_AT }));
    expect(result.ok ? null : result.error.code).toBe('missingField');
  });

  it('サブアセンブリ内の部品が欠けていれば断る', async () => {
    const nested = assembly([component('component-1', { kind: 'part', partRef: 'part-1' })]);
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), {
      savedAt: SAVED_AT, assemblies: new Map([['assembly-a', nested]]),
    }));
    expect(result.ok ? null : result.error.code).toBe('missingField');
  });

  it('循環を利用者向け文言で断る', async () => {
    const nested = assembly([sub('assembly-a')]);
    const result = await readPcadaFile(await writePcadaFile(assembly([sub('assembly-a')]), {
      savedAt: SAVED_AT, assemblies: new Map([['assembly-a', nested]]),
    }));
    expect(result.ok ? '' : result.error.message).toContain('自分自身');
  });

  it('深さ8は読める', async () => {
    const fixture = chain(8);
    expect((await readPcadaFile(await writePcadaFile(fixture.root, {
      savedAt: SAVED_AT, assemblies: fixture.documents,
    }))).ok).toBe(true);
  });

  it('深さ9は断る', async () => {
    const fixture = chain(9);
    const result = await readPcadaFile(await writePcadaFile(fixture.root, {
      savedAt: SAVED_AT, assemblies: fixture.documents,
    }));
    expect(result.ok ? '' : result.error.message).toContain('8 段まで');
  });

  it('同じ入力を2回書くと同じバイト列になる', async () => {
    const fixture = chain(2);
    const options = { savedAt: SAVED_AT, assemblies: fixture.documents };
    expect(await writePcadaFile(fixture.root, options)).toEqual(await writePcadaFile(fixture.root, options));
  });
});
