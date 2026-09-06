import { expressionValueFromNumber } from '@pointercad/expression';
import { PCAD_TEMPLATE_KIND, readPcadFile, writePcadFile } from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createPointFeature,
  DEFAULT_TOOL_DEFAULTS,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { FileGateway, PickedTypedFile } from './fileGateway.js';
import {
  createMemoryTemplateStorage,
  MAX_STORED_TEMPLATES,
  newFromTemplate,
  readTemplateBytes,
  saveTemplate,
  sortTemplates,
  templateIdOf,
  templateIdsToDrop,
  withTemplateExtension,
  type StoredTemplateSummary,
  type TemplateDeps,
} from './templateFile.js';

/** 検査で使う固定の時刻(保存のたびに値が変わらないようにする)。 */
const NOW = '2026-09-06T12:00:00.000Z';

/**
 * 書き出し・読み込みの偽の口。**窓は出さない。** 何を書こうとしたか(名前・種類・
 * バイト列)を控えておき、読むときは控えた最後のバイト列を返す。
 */
interface FakeGateway extends FileGateway {
  readonly written: { fileName: string; kind: string; bytes: Uint8Array }[];
}

function createFakeGateway(options: { readonly cancelSave?: boolean; readonly open?: Uint8Array | null } = {}): FakeGateway {
  const written: { fileName: string; kind: string; bytes: Uint8Array }[] = [];
  return {
    written,
    openPcad: () => Promise.resolve(null),
    savePcad: () => Promise.resolve(null),
    hasSaveTarget: () => false,
    saveFileAs(fileName, kind, bytes) {
      if (options.cancelSave === true) {
        return Promise.resolve(false);
      }
      written.push({ fileName, kind, bytes });
      return Promise.resolve(true);
    },
    openFile(): Promise<PickedTypedFile | null> {
      const bytes = options.open ?? null;
      return Promise.resolve(
        bytes === null ? null : { kind: 'pcadt', fileName: 'ひな形.pcadt', bytes },
      );
    },
  };
}

function createDeps(gateway: FakeGateway = createFakeGateway()): TemplateDeps {
  return { gateway, storage: createMemoryTemplateStorage(), now: () => NOW };
}

/** 検査で使うパラメータ 1 件(FR-207)。 */
const THICKNESS_PARAMETER = {
  name: '板厚',
  value: expressionValueFromNumber(3),
  unit: 'mm',
  description: '',
} as const;

/** パラメータ表と、履歴に線 1 本(スケッチの点)を持つ部品。 */
function documentWithParametersAndHistory(): PartDocument {
  const base = createEmptyPartDocument();
  const sketch = base.sketches[0];
  const withPoint = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(0, 0, 0)));
  return {
    ...replaceSketch(base, withPoint),
    name: '受け皿',
    parameters: [THICKNESS_PARAMETER],
  };
}

/** 見出しだけの 1 件(並べ替えと間引きの検査用)。 */
function summary(id: string, savedAt: string): StoredTemplateSummary {
  return { id, name: id, savedAt };
}

describe('ひな形のファイル名と鍵', () => {
  it('拡張子が無ければ .pcadt を足す', () => {
    expect(withTemplateExtension('受け皿')).toBe('受け皿.pcadt');
  });

  it('すでに .pcadt で終わっていれば足さない(大文字小文字は問わない)', () => {
    expect(withTemplateExtension('受け皿.pcadt')).toBe('受け皿.pcadt');
    expect(withTemplateExtension(' 受け皿.PCADT ')).toBe('受け皿.PCADT');
  });

  it('置き場の鍵は名前そのもの(拡張子と前後の空白は落とす)', () => {
    expect(templateIdOf(' 受け皿.pcadt ')).toBe('受け皿');
    expect(templateIdOf('受け皿')).toBe('受け皿');
  });

  it('同じ名前で保存し直すと同じ鍵になる(一覧に 2 行並ばない)', () => {
    expect(templateIdOf('受け皿.pcadt')).toBe(templateIdOf('受け皿'));
  });
});

describe('ひな形の一覧の並びと間引き', () => {
  it('新しいものが先頭に来る', () => {
    const sorted = sortTemplates([
      summary('古い', '2026-09-01T00:00:00.000Z'),
      summary('新しい', '2026-09-05T00:00:00.000Z'),
      summary('中くらい', '2026-09-03T00:00:00.000Z'),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['新しい', '中くらい', '古い']);
  });

  it('元の一覧は変わらない', () => {
    const list = [summary('a', '2026-09-01T00:00:00.000Z'), summary('b', '2026-09-05T00:00:00.000Z')];
    sortTemplates(list);
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('上限までなら 1 件も落とさない', () => {
    const list = Array.from({ length: MAX_STORED_TEMPLATES }, (_unused, index) =>
      summary(`t${String(index)}`, `2026-09-0${String((index % 9) + 1)}T00:00:00.000Z`),
    );
    expect(templateIdsToDrop(list)).toEqual([]);
  });

  it('上限を超えたぶんは古いほうから落ちる', () => {
    const list = [
      summary('古い', '2026-09-01T00:00:00.000Z'),
      summary('新しい', '2026-09-05T00:00:00.000Z'),
    ];
    expect(templateIdsToDrop(list, 1)).toEqual(['古い']);
  });
});

describe('記憶上の置き場', () => {
  it('入れて、一覧に出て、取り出せて、消せる', async () => {
    const storage = createMemoryTemplateStorage();
    expect(await storage.list()).toEqual([]);
    await storage.put({ id: '受け皿', name: '受け皿', savedAt: NOW, bytes: new Uint8Array([1, 2]) });
    expect((await storage.list()).map((entry) => entry.id)).toEqual(['受け皿']);
    expect((await storage.get('受け皿'))?.bytes).toEqual(new Uint8Array([1, 2]));
    await storage.remove('受け皿');
    expect(await storage.get('受け皿')).toBeNull();
    expect(await storage.list()).toEqual([]);
  });

  it('一覧は中身のバイト列を運ばない(見出しの 3 欄だけ)', async () => {
    const storage = createMemoryTemplateStorage();
    await storage.put({ id: 'a', name: 'a', savedAt: NOW, bytes: new Uint8Array([9]) });
    expect(await storage.list()).toEqual([{ id: 'a', name: 'a', savedAt: NOW }]);
  });

  it('無い鍵を消しても何も起きない', async () => {
    const storage = createMemoryTemplateStorage();
    await expect(storage.remove('無い')).resolves.toBeUndefined();
  });
});

describe('ひな形として保存(FR-814)', () => {
  it('置き場へ入り、ファイルにも .pcadt で書き出す', async () => {
    const gateway = createFakeGateway();
    const deps = createDeps(gateway);
    const outcome = await saveTemplate(deps, {
      document: documentWithParametersAndHistory(),
      lengthUnit: 'inch',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '受け皿',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.wroteFile).toBe(true);
    expect(gateway.written).toHaveLength(1);
    expect(gateway.written[0].fileName).toBe('受け皿.pcadt');
    expect(gateway.written[0].kind).toBe('pcadt');
    expect((await deps.storage.list()).map((entry) => entry.id)).toEqual(['受け皿']);
  });

  it('封筒の種別がひな形になる(拡張子ではなく中身で見分けられる)', async () => {
    const deps = createDeps();
    await saveTemplate(deps, {
      document: documentWithParametersAndHistory(),
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '受け皿',
    });
    const stored = await deps.storage.get('受け皿');
    expect(stored).not.toBeNull();
    const read = readPcadFile(stored?.bytes ?? new Uint8Array());
    expect(read.ok && read.kind).toBe(PCAD_TEMPLATE_KIND);
  });

  it('履歴は持ち越さず、パラメータ表と単位と道具の既定値は持ち運ぶ(§2.10)', async () => {
    const deps = createDeps();
    await saveTemplate(deps, {
      document: documentWithParametersAndHistory(),
      lengthUnit: 'inch',
      toolDefaults: { ...DEFAULT_TOOL_DEFAULTS, extrudeDistance: '25' },
      name: '受け皿',
    });
    const stored = await deps.storage.get('受け皿');
    const read = readPcadFile(stored?.bytes ?? new Uint8Array());
    // 履歴(スケッチの中身)は空になる。
    expect(read.ok && read.document.sketches[0].features).toEqual([]);
    expect(read.ok && read.document.parameters.map((entry) => entry.name)).toEqual(['板厚']);
    expect(read.ok && read.lengthUnit).toBe('inch');
    expect(read.ok && read.toolDefaults?.extrudeDistance).toBe('25');
  });

  it('ファイルの窓を取り消しても、置き場には残る', async () => {
    const gateway = createFakeGateway({ cancelSave: true });
    const deps = createDeps(gateway);
    const outcome = await saveTemplate(deps, {
      document: createEmptyPartDocument(),
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '受け皿',
    });
    expect(outcome.ok && outcome.wroteFile).toBe(false);
    expect(await deps.storage.get('受け皿')).not.toBeNull();
    expect(gateway.written).toHaveLength(0);
  });

  it('名前が空白だけなら部品の名前を使う', async () => {
    const deps = createDeps();
    const outcome = await saveTemplate(deps, {
      document: documentWithParametersAndHistory(),
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '   ',
    });
    expect(outcome.ok && outcome.saved.name).toBe('受け皿');
  });

  it('上限を超えると古いひな形が置き場から落ちる', async () => {
    const deps = createDeps();
    for (let index = 0; index <= MAX_STORED_TEMPLATES; index += 1) {
      await saveTemplate(
        { ...deps, now: () => `2026-09-06T12:00:${String(index).padStart(2, '0')}.000Z` },
        {
          document: createEmptyPartDocument(),
          lengthUnit: 'mm',
          toolDefaults: DEFAULT_TOOL_DEFAULTS,
          name: `ひな形${String(index)}`,
        },
      );
    }
    const list = await deps.storage.list();
    expect(list).toHaveLength(MAX_STORED_TEMPLATES);
    expect(list.some((entry) => entry.id === 'ひな形0')).toBe(false);
  });
});

describe('ひな形から新規(FR-814、§2.10)', () => {
  /** 保存済みのひな形 1 つを持つ置き場と口。 */
  async function withSavedTemplate(): Promise<TemplateDeps> {
    const deps = createDeps();
    await saveTemplate(deps, {
      document: documentWithParametersAndHistory(),
      lengthUnit: 'inch',
      toolDefaults: { ...DEFAULT_TOOL_DEFAULTS, holeDiameter: '8' },
      name: '受け皿',
    });
    return deps;
  }

  it('置き場の 1 件から、パラメータ表と単位と道具の既定値が入った新しい部品を起こす', async () => {
    const deps = await withSavedTemplate();
    const outcome = await newFromTemplate(deps, { from: 'stored', id: '受け皿' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.parameters.map((entry) => entry.name)).toEqual(['板厚']);
    expect(outcome.lengthUnit).toBe('inch');
    expect(outcome.toolDefaults.holeDiameter).toBe('8');
    // 履歴は空(ひな形に形が入っていても引き継がない)。
    expect(outcome.document.solids).toEqual([]);
    expect(outcome.document.sketches[0].features).toEqual([]);
    // ひな形とは別の id を採る(取り違えを起こさない)。
    expect(outcome.document.id).not.toBe(createEmptyPartDocument().id);
  });

  it('形の入っていないひな形では知らせを出さない', async () => {
    const deps = createDeps();
    await saveTemplate(deps, {
      document: createEmptyPartDocument(),
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '空',
    });
    const outcome = await newFromTemplate(deps, { from: 'stored', id: '空' });
    expect(outcome.ok && outcome.notice).toBeNull();
  });

  it('一覧から消えていたひな形を選んだら missing で断る', async () => {
    const deps = createDeps();
    const outcome = await newFromTemplate(deps, { from: 'stored', id: '無い' });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && 'missing' in outcome && outcome.missing).toBe(true);
  });

  it('ファイルから開ける', async () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {
      kind: PCAD_TEMPLATE_KIND,
      lengthUnit: 'inch',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      savedAt: NOW,
    });
    const deps = createDeps(createFakeGateway({ open: bytes }));
    const outcome = await newFromTemplate(deps, { from: 'file' });
    expect(outcome.ok && outcome.lengthUnit).toBe('inch');
  });

  it('ファイルの窓を取り消したら断りを出さない', async () => {
    const deps = createDeps(createFakeGateway({ open: null }));
    const outcome = await newFromTemplate(deps, { from: 'file' });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && 'cancelled' in outcome && outcome.cancelled).toBe(true);
  });

  it('形の入ったひな形は断らず、知らせを 1 つ返す(§2.10)', () => {
    const bytes = writePcadFile(documentWithParametersAndHistory(), {
      kind: PCAD_TEMPLATE_KIND,
      savedAt: NOW,
    });
    const outcome = readTemplateBytes(bytes);
    expect(outcome.ok && outcome.notice).toBe('templateHasHistory');
    // 断らずに開く。形は引き継がない。
    expect(outcome.ok && outcome.document.solids).toEqual([]);
  });

  it('単位と道具の既定値を持たないひな形は既定で埋まる(§2.10)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {
      kind: PCAD_TEMPLATE_KIND,
      savedAt: NOW,
    });
    const outcome = readTemplateBytes(bytes);
    expect(outcome.ok && outcome.lengthUnit).toBe('mm');
    expect(outcome.ok && outcome.toolDefaults).toEqual(DEFAULT_TOOL_DEFAULTS);
  });

  it('部品のファイル(.pcad)をひな形として開こうとしたら断る', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), { savedAt: NOW });
    const outcome = readTemplateBytes(bytes);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.messageKey).toBe('file.error.wrongKind');
  });

  it('壊れたファイルは理由つきで断る(今の部品は触らない)', () => {
    const outcome = readTemplateBytes(new Uint8Array([1, 2, 3]));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.messageKey).toBe('file.error.corrupted');
  });
});
