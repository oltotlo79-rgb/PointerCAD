/**
 * 環境マップの持ち主(`createEnvironment.ts` の `createEnvironmentStore`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク9、§2.6、§0.a-0.9)。
 *
 * `createEnvironmentTarget` そのもの(`RoomEnvironment` を `PMREMGenerator` で焼く)は
 * WebGL のレンダラを要するので Node では動かせない。**作る条件・使い回し・捨てる時機**という
 * 筋道だけを純粋な形(差し替えられる `create`)で切り出し、ここで固定する。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createEnvironmentStore, type EnvironmentTarget } from './createEnvironment.js';

interface FakeEnvironmentFactory {
  create(): EnvironmentTarget;
  createCount(): number;
  disposeCount(): number;
}

/** 偽の環境マップ工場(WebGL を使わない)。 */
function createFakeFactory(): FakeEnvironmentFactory {
  let createCount = 0;
  let disposeCount = 0;
  return {
    create() {
      createCount += 1;
      const texture = new THREE.Texture();
      return {
        texture,
        dispose: () => {
          disposeCount += 1;
          texture.dispose();
        },
      };
    },
    createCount: () => createCount,
    disposeCount: () => disposeCount,
  };
}

describe('createEnvironmentStore(FR-1107、§0.a-0.9)', () => {
  it('作りたてでは環境マップを持たない(鏡・ガラスが無い文書では作らない)', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());

    expect(store.texture).toBeNull();
    expect(factory.createCount()).toBe(0);
  });

  it('ensureEnvironment で 1 枚作り、scene.environment へ入れる', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();

    const texture = store.ensureEnvironment(scene);

    expect(factory.createCount()).toBe(1);
    expect(store.texture).toBe(texture);
    expect(scene.environment).toBe(texture);
  });

  it('2 回目の ensureEnvironment では作り直さない(毎フレーム作らない。NFR-PF-1)', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();

    const first = store.ensureEnvironment(scene);
    const second = store.ensureEnvironment(scene);

    expect(second).toBe(first);
    expect(factory.createCount()).toBe(1);
  });

  it('releaseEnvironment で捨て、scene.environment を戻す', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();
    store.ensureEnvironment(scene);

    store.releaseEnvironment(scene);

    expect(factory.disposeCount()).toBe(1);
    expect(store.texture).toBeNull();
    expect(scene.environment).toBeNull();
  });

  it('捨てた後に ensureEnvironment を呼ぶと作り直す', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();
    const first = store.ensureEnvironment(scene);
    store.releaseEnvironment(scene);

    const second = store.ensureEnvironment(scene);

    expect(second).not.toBe(first);
    expect(factory.createCount()).toBe(2);
  });

  it('持っていないときの releaseEnvironment と dispose は何も壊さない', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();

    store.releaseEnvironment(scene);
    store.dispose();
    store.dispose();

    expect(factory.disposeCount()).toBe(0);
    expect(scene.environment).toBeNull();
  });

  it('dispose はシーンに触れずに環境マップだけを捨てる', () => {
    const factory = createFakeFactory();
    const store = createEnvironmentStore(() => factory.create());
    const scene = new THREE.Scene();
    store.ensureEnvironment(scene);

    store.dispose();

    expect(factory.disposeCount()).toBe(1);
    expect(store.texture).toBeNull();
    // シーンには触れないので、参照は残ったまま(捨てるのは releaseEnvironment の役目)。
    expect(scene.environment).not.toBeNull();
  });
});
