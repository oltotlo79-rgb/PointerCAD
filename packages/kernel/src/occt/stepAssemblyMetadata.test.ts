import { describe, expect, it } from 'vitest';

import {
  ASSEMBLY_METADATA_WRITE_MESSAGE,
  decodeStepAssemblyOccurrenceName,
  normalizeStepAssemblyMetadata,
  stepAssemblyOccurrenceName,
} from './stepAssemblyMetadata.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('STEPアセンブリの配置名と決定的id', () => {
  it('名前の引数位置に依存せず、引用符を保って通算idを置き換える', () => {
    const occurrence = stepAssemblyOccurrenceName(1, "子組立 O'Brien");
    const source = encode(
      `#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('87','別欄','${occurrence.token}',#1,#2,$);`,
    );
    const text = decode(normalizeStepAssemblyMetadata(source, [occurrence]));
    expect(text).toContain("'子組立 O''Brien'");
    expect(text).not.toContain(occurrence.token);
    const id = /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']+)'/.exec(text)?.[1] ?? null;
    expect(id).toMatch(/^__PCAD_NAUO_ID_000001_/);
    expect(decodeStepAssemblyOccurrenceName(id)).toBe("子組立 O'Brien");
  });

  it('null名をidへ可逆に埋め込み、印が無い出力は安全側で断る', () => {
    const occurrence = stepAssemblyOccurrenceName(2, null);
    const source = encode(
      `#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('99','${occurrence.token}','',#1,#2,$);`,
    );
    const text = decode(normalizeStepAssemblyMetadata(source, [occurrence]));
    const id = /NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']+)'/.exec(text)?.[1] ?? null;
    expect(id).not.toBeNull();
    expect(decodeStepAssemblyOccurrenceName(id)).toBeNull();
    expect(() => normalizeStepAssemblyMetadata(
      encode("#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('99','missing','',#1,#2,$);"),
      [occurrence],
    ))
      .toThrow(ASSEMBLY_METADATA_WRITE_MESSAGE);
  });

  it('OCCTの通算idが違っても同じ配置から同じバイト列を作る', () => {
    const occurrence = stepAssemblyOccurrenceName(1, '配置A');
    const first = normalizeStepAssemblyMetadata(encode(
      `#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('12','${occurrence.token}','',#1,#2,$);`,
    ), [occurrence]);
    const second = normalizeStepAssemblyMetadata(encode(
      `#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('987','${occurrence.token}','',#1,#2,$);`,
    ), [occurrence]);
    expect(second).toEqual(first);
  });
});
