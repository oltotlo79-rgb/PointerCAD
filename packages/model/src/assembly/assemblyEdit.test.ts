import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { DEFAULT_APPEARANCE } from '../appearance/materialPresets.js';
import { createUndoStack, pushUndo } from '../history/undoStack.js';

import {
  addComponent,
  createComponentFor,
  DEFAULT_COMPONENT_LABEL,
  findComponent,
  moveComponent,
  nextComponentName,
  removeComponent,
  renameComponent,
  replaceComponent,
  setComponentAppearance,
  setFixed,
  setVisible,
} from './assemblyEdit.js';
import {
  createAssemblyDocument,
  DEFAULT_ASSEMBLY_NAME,
  DEFAULT_COMPONENT_PLACEMENT,
} from './createAssemblyDocument.js';
import type { AssemblyDocument, Joint, Mate, Placement, PresentationStep } from './types.js';

const BRACKET = 'ブラケット';

/** 部品を 1 つ置いた新しい文書(本番と同じ道筋: 作る → 足す)。 */
function place(document: AssemblyDocument, partName: string = BRACKET): AssemblyDocument {
  return addComponent(
    document,
    createComponentFor(document, { kind: 'part', partRef: 'part-1' }, { partName }),
  );
}

/** 部品を `count` 個置いた文書。 */
function assemblyWith(count: number): AssemblyDocument {
  let document = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
  for (let index = 0; index < count; index += 1) {
    document = place(document);
  }
  return document;
}

function mateBetween(id: string, first: string, second: string): Mate {
  return {
    id,
    name: id,
    kind: 'coincident',
    a: { kind: 'origin', componentId: first, element: 'xy' },
    b: { kind: 'origin', componentId: second, element: 'xy' },
    flipped: false,
    suppressed: false,
  };
}

function jointBetween(id: string, first: string, second: string): Joint {
  return {
    id,
    name: id,
    kind: 'revolute',
    a: { kind: 'origin', componentId: first, element: 'z' },
    b: { kind: 'origin', componentId: second, element: 'z' },
    minValue: null,
    maxValue: null,
    suppressed: false,
  };
}

function explodeStep(id: string, componentIds: readonly string[]): PresentationStep {
  return {
    id,
    name: id,
    start: 0,
    end: 1,
    body: {
      kind: 'explode',
      componentIds,
      direction: { kind: 'world', axis: 'z' },
      distance: expressionValueFromNumber(50),
    },
  };
}

function jointStep(id: string, jointId: string): PresentationStep {
  return {
    id,
    name: id,
    start: 0,
    end: 1,
    body: {
      kind: 'joint',
      jointId,
      from: expressionValueFromNumber(0),
      to: expressionValueFromNumber(90),
    },
  };
}

/** 位置を数で書いた配置(向きは指定できる)。 */
function placementAt(
  x: number,
  y: number,
  z: number,
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
): Placement {
  return {
    position: [
      expressionValueFromNumber(x),
      expressionValueFromNumber(y),
      expressionValueFromNumber(z),
    ],
    rotation,
  };
}

describe('createComponentFor / addComponent', () => {
  it('1 つ目に置いた部品は自動で固定される(§0.a-0.7)', () => {
    const document = place(createAssemblyDocument(DEFAULT_ASSEMBLY_NAME));

    expect(document.components).toHaveLength(1);
    expect(document.components[0].fixed).toBe(true);
  });

  it('2 つ目以降は固定されない', () => {
    const document = assemblyWith(2);

    expect(document.components[0].fixed).toBe(true);
    expect(document.components[1].fixed).toBe(false);
  });

  it('固定を外してから 3 つ目を置いても、自動で固定されるのは 1 つ目だけ', () => {
    const two = assemblyWith(2);
    const released = setFixed(two, 'component-1', false);
    const three = place(released);

    expect(three.components.map((component) => component.fixed)).toEqual([false, false, false]);
  });

  it('名前の既定は `<部品名>:<n>`(§0.a-0.8)', () => {
    const document = assemblyWith(2);

    expect(document.components.map((component) => component.name)).toEqual([
      'ブラケット:1',
      'ブラケット:2',
    ]);
  });

  it('部品の名前を渡さなければ既定の名前の元を使う', () => {
    const empty = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
    const document = addComponent(
      empty,
      createComponentFor(empty, {
        kind: 'standardPart',
        catalog: 'hexBolt',
        size: 'M8',
        options: {},
      }),
    );

    expect(document.components[0].name).toBe(`${DEFAULT_COMPONENT_LABEL}:1`);
  });

  it('名前を明示すればそれを使い、次の既定はその番号を避ける', () => {
    const empty = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
    const first = addComponent(
      empty,
      createComponentFor(empty, { kind: 'part', partRef: 'part-1' }, { name: 'ブラケット:7' }),
    );

    expect(first.components[0].name).toBe('ブラケット:7');
    expect(nextComponentName(first, BRACKET)).toBe('ブラケット:8');
  });

  it('id は `component-<n>` で、途中を消しても番号を再利用しない', () => {
    const two = assemblyWith(2);
    const removed = removeComponent(two, 'component-1');
    const three = place(removed);

    expect(two.components.map((component) => component.id)).toEqual([
      'component-1',
      'component-2',
    ]);
    expect(three.components.map((component) => component.id)).toEqual([
      'component-2',
      'component-3',
    ]);
  });

  it('置くと末尾へ並び、元の文書は変わらない(不変性)', () => {
    const empty = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
    const one = place(empty);
    const two = place(one);

    expect(empty.components).toEqual([]);
    expect(one.components).toHaveLength(1);
    expect(two.components.map((component) => component.id)).toEqual([
      'component-1',
      'component-2',
    ]);
  });

  it('同じ id を 2 回足しても増えない', () => {
    const one = assemblyWith(1);
    const again = addComponent(one, one.components[0]);

    expect(again).toBe(one);
  });

  it('配置を省くと原点に、回さずに置かれる。表示は入・抑制は切', () => {
    const document = assemblyWith(1);
    const component = document.components[0];

    expect(component.placement).toEqual(DEFAULT_COMPONENT_PLACEMENT);
    expect(component.visible).toBe(true);
    expect(component.suppressed).toBe(false);
    expect(component.appearance).toBeUndefined();
  });

  it('向きは `w >= 0` へ揃えて保存される(§0.a-0.54)', () => {
    const empty = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
    const document = addComponent(
      empty,
      createComponentFor(
        empty,
        { kind: 'part', partRef: 'part-1' },
        // 90° 回転を符号を反転して(w < 0)渡す。同じ回転なので符号だけが揃うこと。
        { placement: placementAt(0, 0, 0, [-Math.SQRT1_2, 0, 0, -Math.SQRT1_2]) },
      ),
    );

    const [x, y, z, w] = document.components[0].placement.rotation;
    expect(w).toBeGreaterThan(0);
    expect(x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(y).toBe(0);
    expect(z).toBe(0);
  });
});

describe('removeComponent', () => {
  /** 部品 3 つ・合致 2 本・ジョイント 1 つ・ステップ 3 つを置いた文書。 */
  function scene(): AssemblyDocument {
    return {
      ...assemblyWith(3),
      mates: [mateBetween('mate-1', 'component-1', 'component-2'), mateBetween('mate-2', 'component-2', 'component-3')],
      joints: [jointBetween('joint-1', 'component-1', 'component-3')],
      presentation: [
        explodeStep('step-1', ['component-1', 'component-2']),
        explodeStep('step-2', ['component-1']),
        jointStep('step-3', 'joint-1'),
      ],
    };
  }

  it('置いた部品が 1 つ消える', () => {
    const document = removeComponent(scene(), 'component-1');

    expect(document.components.map((component) => component.id)).toEqual([
      'component-2',
      'component-3',
    ]);
    expect(findComponent(document, 'component-1')).toBeUndefined();
  });

  it('その部品を指していた合致も一緒に消える', () => {
    const before = scene();
    const after = removeComponent(before, 'component-1');

    expect(before.mates).toHaveLength(2);
    expect(after.mates).toHaveLength(1);
  });

  it('その部品を指していない合致は残る', () => {
    const after = removeComponent(scene(), 'component-1');

    expect(after.mates.map((mate) => mate.id)).toEqual(['mate-2']);
  });

  it('その部品を指していたジョイントも一緒に消える', () => {
    const after = removeComponent(scene(), 'component-3');

    expect(after.joints).toEqual([]);
  });

  it('消えたジョイントを駆動していたステップも消える', () => {
    const after = removeComponent(scene(), 'component-3');

    expect(after.presentation.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('分解のステップからは、その部品だけが抜けて他は残る', () => {
    const after = removeComponent(scene(), 'component-1');
    const step = after.presentation[0];

    expect(step.id).toBe('step-1');
    expect(step.body.kind === 'explode' ? step.body.componentIds : []).toEqual(['component-2']);
  });

  it('中身が空になった分解のステップは消える', () => {
    // component-1 を消すと step-2(その 1 つだけを動かす)は動かす相手が無くなる。
    // step-3 は component-1 を指す joint-1 が消えるので、それに連れて消える。
    const after = removeComponent(scene(), 'component-1');

    expect(after.presentation.map((step) => step.id)).toEqual(['step-1']);
  });

  it('知らない id では元の文書をそのまま返す', () => {
    const before = scene();

    expect(removeComponent(before, 'component-9')).toBe(before);
  });

  it('元の文書は変わらない(不変性)', () => {
    const before = scene();
    removeComponent(before, 'component-1');

    expect(before.components).toHaveLength(3);
    expect(before.mates).toHaveLength(2);
    expect(before.joints).toHaveLength(1);
    expect(before.presentation).toHaveLength(3);
    expect(before.presentation[0].body.kind === 'explode' ? before.presentation[0].body.componentIds : []).toEqual([
      'component-1',
      'component-2',
    ]);
  });
});

describe('setFixed / setVisible', () => {
  it('固定を外して付け直せる(FR-602)', () => {
    const one = assemblyWith(1);
    const released = setFixed(one, 'component-1', false);
    const again = setFixed(released, 'component-1', true);

    expect(released.components[0].fixed).toBe(false);
    expect(again.components[0].fixed).toBe(true);
    expect(one.components[0].fixed).toBe(true);
  });

  it('同じ値なら元の文書をそのまま返す(Undo に空の段を作らない)', () => {
    const one = assemblyWith(1);

    expect(setFixed(one, 'component-1', true)).toBe(one);
    expect(setVisible(one, 'component-1', true)).toBe(one);
  });

  it('知らない id では元の文書をそのまま返す', () => {
    const one = assemblyWith(1);

    expect(setFixed(one, 'component-9', false)).toBe(one);
    expect(setVisible(one, 'component-9', false)).toBe(one);
  });

  it('表示を切り替えても、固定と配置は変わらない(FR-605)', () => {
    const one = assemblyWith(1);
    const hidden = setVisible(one, 'component-1', false);

    expect(hidden.components[0].visible).toBe(false);
    expect(hidden.components[0].fixed).toBe(true);
    expect(hidden.components[0].placement).toEqual(one.components[0].placement);
  });
});

describe('renameComponent', () => {
  it('名前を変えられる', () => {
    const one = assemblyWith(1);
    const renamed = renameComponent(one, 'component-1', '土台');

    expect(renamed.components[0].name).toBe('土台');
    expect(one.components[0].name).toBe('ブラケット:1');
  });

  it('空の名前は受け付けない', () => {
    const one = assemblyWith(1);

    expect(renameComponent(one, 'component-1', '')).toBe(one);
  });

  it('改名した名前とも次の既定の名前は重ならない', () => {
    const two = assemblyWith(2);
    const renamed = renameComponent(two, 'component-1', 'ブラケット:5');

    expect(nextComponentName(renamed, BRACKET)).toBe('ブラケット:6');
  });
});

describe('setComponentAppearance', () => {
  it('組図での色分けを付けられる(FR-605)', () => {
    const one = assemblyWith(1);
    const painted = setComponentAppearance(one, 'component-1', DEFAULT_APPEARANCE);

    expect(painted.components[0].appearance).toEqual(DEFAULT_APPEARANCE);
    expect(one.components[0].appearance).toBeUndefined();
  });

  it('`undefined` を渡すと指定が外れ、保存の JSON からも消える', () => {
    const painted = setComponentAppearance(assemblyWith(1), 'component-1', DEFAULT_APPEARANCE);
    const cleared = setComponentAppearance(painted, 'component-1', undefined);

    expect(cleared.components[0].appearance).toBeUndefined();
    expect(JSON.stringify(cleared.components[0])).not.toContain('appearance');
  });
});

describe('moveComponent / replaceComponent', () => {
  it('置いた場所を書き換えられる', () => {
    const one = assemblyWith(1);
    const moved = moveComponent(one, 'component-1', placementAt(10, 20, 30));

    expect(moved.components[0].placement.position.map((value) => value.value)).toEqual([
      10, 20, 30,
    ]);
    expect(one.components[0].placement).toEqual(DEFAULT_COMPONENT_PLACEMENT);
  });

  it('向きは `w >= 0` へ揃えて保存される(§0.a-0.54)', () => {
    const moved = moveComponent(
      assemblyWith(1),
      'component-1',
      placementAt(0, 0, 0, [0, 0, -Math.SQRT1_2, -Math.SQRT1_2]),
    );

    expect(moved.components[0].placement.rotation[3]).toBeGreaterThan(0);
    expect(moved.components[0].placement.rotation[2]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('知らない id では元の文書をそのまま返す', () => {
    const one = assemblyWith(1);

    expect(moveComponent(one, 'component-9', placementAt(1, 2, 3))).toBe(one);
    expect(replaceComponent(one, 'component-9', one.components[0])).toBe(one);
  });
});

describe('Undo の単位', () => {
  it('操作 1 回で 1 段積まれ、何も変わらない操作では積まれない', () => {
    const one = assemblyWith(1);
    const stack = pushUndo(createUndoStack(one), setVisible(one, 'component-1', false));
    // 同じ値を書く操作は元の文書をそのまま返すので、`pushUndo` が段を作らない。
    const unchanged = pushUndo(stack, setFixed(stack.present, 'component-1', true));

    expect(stack.past).toHaveLength(1);
    expect(unchanged.past).toHaveLength(1);
    expect(unchanged.present.components[0].visible).toBe(false);
  });
});
