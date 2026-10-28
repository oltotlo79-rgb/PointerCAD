/**
 * 環境マップの持ち主(`createEnvironment.ts` の `createEnvironmentStore`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク9、§2.6、§0.a-0.9)。
 *
 * 工場の差し替えで予約・所有遷移を検査し、GPU を確保しない公開レンダラ境界で
 * 実際の RoomEnvironment / PMREMGenerator の生成・失敗・解放も検査する。
 */

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvironmentStore, createEnvironmentTarget, EnvironmentCreationFailure, type EnvironmentTarget } from './createEnvironment.js';
import { createGpuMeshBudget } from './solidMeshAdmission.js';

const rendering = vi.hoisted(() => ({ beforeRender: null as ((object: THREE.Object3D) => void) | null,
  bound: [] as THREE.WebGLRenderTarget[] }));

// Execute the real PMREM/Room code and public renderer calls with no GL context.
// These tests verify ownership and metadata, never pretend to measure GPU storage.
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    xr = { enabled: true };
    autoClear = true;
    toneMapping = actual.ACESFilmicToneMapping;
    state = { buffers: { depth: { getReversed: () => false } } };
    private target: THREE.WebGLRenderTarget | null = null;
    private face = 0;
    private mip = 0;
    getRenderTarget() { return this.target; }
    getActiveCubeFace() { return this.face; }
    getActiveMipmapLevel() { return this.mip; }
    getClearColor(color: THREE.Color) { return color.set(0x123456); }
    setRenderTarget(target: THREE.WebGLRenderTarget | null, face = 0, mip = 0) {
      this.target = target; this.face = face; this.mip = mip;
      if (target !== null && !rendering.bound.includes(target)) rendering.bound.push(target);
    }
    render(object: THREE.Object3D) { rendering.beforeRender?.(object); }
  } };
});

afterEach(() => { rendering.beforeRender = null; rendering.bound = []; vi.restoreAllMocks(); });

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

describe('environment reservation and transactional ownership', () => {
  it.each([15740015, 15740016])('reserves the peak before invoking the factory at limit %i', limit => {
    const pool = createGpuMeshBudget(limit), factory = createFakeFactory(), scene = new THREE.Scene();
    let observed = 0;
    const store = createEnvironmentStore(() => { observed = pool.environmentReservedBytes(); return factory.create(); }, pool);
    if (limit === 15740015) {
      expect(() => store.ensureEnvironment(scene)).toThrow(/shared GPU budget/);
      expect(factory.createCount()).toBe(0); expect(pool.totalReservedBytes()).toBe(0);
    } else {
      store.ensureEnvironment(scene);
      expect(observed).toBe(15740016);
      expect(store.reservedBytes).toBe(9437184); expect(pool.reservedBytes()).toBe(0);
      store.ensureEnvironment(scene); expect(factory.createCount()).toBe(1);
    }
    store.dispose(); store.dispose(); expect(pool.totalReservedBytes()).toBe(0);
  });

  it('counts another environment and mesh owner during the full transient peak', () => {
    const pool = createGpuMeshBudget(25177200 + 20), mesh = Symbol('assembly');
    pool.reserve(mesh, 20);
    const first = createEnvironmentStore(() => createFakeFactory().create(), pool);
    first.ensureEnvironment(new THREE.Scene());
    const second = createEnvironmentStore(() => createFakeFactory().create(), pool);
    second.ensureEnvironment(new THREE.Scene());
    expect(pool.environmentReservedBytes()).toBe(2 * 9437184);
    second.dispose(); expect(pool.environmentReservedBytes()).toBe(9437184);
    expect(pool.reservedBytes(mesh)).toBe(20);
    first.dispose(); expect(pool.totalReservedBytes()).toBe(20);
  });

  it('keeps the old scene until publication and disposes an unpublished candidate exactly once', () => {
    const factory = createFakeFactory(), store = createEnvironmentStore(() => factory.create()), scene = new THREE.Scene();
    const draft = store.prepareEnvironment(true);
    expect(scene.environment).toBeNull(); expect(store.texture).toBeNull();
    draft.rollback(); draft.rollback(); expect(factory.disposeCount()).toBe(1);
    const old = store.ensureEnvironment(scene);
    const removal = store.prepareEnvironment(false);
    expect(scene.environment).toBe(old); expect(factory.disposeCount()).toBe(1);
    removal.rollback(); expect(store.texture).toBe(old);
    store.prepareEnvironment(false).commit(scene);
    expect(scene.environment).toBeNull(); expect(factory.disposeCount()).toBe(2);
    expect(store.reservedBytes).toBe(0); store.dispose();
  });

  it('rejects unknown profiles and returns reservations after ordinary creation failure', () => {
    const pool = createGpuMeshBudget(20000000), factory = createFakeFactory();
    const unknown = createEnvironmentStore(() => factory.create(), pool, null);
    expect(() => unknown.ensureEnvironment(new THREE.Scene())).toThrow(/reservation is unknown/);
    expect(factory.createCount()).toBe(0);
    const failed = createEnvironmentStore(() => { throw new Error('generation failure'); }, pool);
    expect(() => failed.ensureEnvironment(new THREE.Scene())).toThrow('generation failure');
    expect(pool.totalReservedBytes()).toBe(0); failed.dispose(); unknown.dispose();
  });

  it('holds peak bytes for failed temporary cleanup and retries without touching other owners', () => {
    const pool = createGpuMeshBudget(20000000), mesh = Symbol('other'); pool.reserve(mesh, 42);
    let fails = true, returns = 0;
    const store = createEnvironmentStore(() => {
      throw new EnvironmentCreationFailure(new Error('fromScene failed'), () => {
        if (fails) throw new Error('temporary cleanup failed'); returns++;
      });
    }, pool);
    expect(() => store.ensureEnvironment(new THREE.Scene())).toThrow(EnvironmentCreationFailure);
    expect(store.reservedBytes).toBe(15740016); expect(store.cleanupPending).toBe(true);
    expect(() => store.dispose()).toThrow(/pending/);
    expect(pool.reservedBytes(mesh)).toBe(42); expect(returns).toBe(0);
    fails = false; store.dispose(); store.dispose();
    expect(returns).toBe(1); expect(pool.totalReservedBytes()).toBe(42);
  });

  it('retains output cleanup failure after removal and retries without double release', () => {
    const pool = createGpuMeshBudget(20000000); let fails = true, returns = 0;
    const texture = new THREE.Texture();
    const store = createEnvironmentStore(() => ({ texture, dispose: () => {
      if (fails) throw new Error('output cleanup'); returns++; texture.dispose();
    } }), pool);
    const scene = new THREE.Scene(); store.ensureEnvironment(scene);
    store.prepareEnvironment(false).commit(scene);
    expect(scene.environment).toBeNull(); expect(store.cleanupPending).toBe(true);
    expect(pool.environmentReservedBytes()).toBe(9437184);
    fails = false; store.dispose(); store.dispose();
    expect(returns).toBe(1); expect(pool.environmentReservedBytes()).toBe(0);
  });

  it('returns a candidate when disposal happens during its synchronous factory', () => {
    const pool = createGpuMeshBudget(20000000), factory = createFakeFactory();
    const store = createEnvironmentStore(() => { store.dispose(); return factory.create(); }, pool);
    expect(() => store.ensureEnvironment(new THREE.Scene())).toThrow(/owner changed/);
    expect(factory.disposeCount()).toBe(1); expect(pool.totalReservedBytes()).toBe(0);
    store.dispose(); expect(factory.disposeCount()).toBe(1);
  });
});

describe('real Three PMREM generation through public renderer calls', () => {
  it.each(['success', 'room', 'filter', 'bind'] as const)('restores the renderer and releases temporary resources on %s', stage => {
    const renderer = new THREE.WebGLRenderer(), old = new THREE.WebGLRenderTarget(8, 8);
    renderer.setRenderTarget(old, 2, 3);
    const original = renderer.setRenderTarget.bind(renderer);
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(THREE.WebGLRenderer.prototype, 'setRenderTarget');
    const disposeInstance = vi.spyOn(THREE.InstancedMesh.prototype, 'dispose');
    const disposeTarget = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    let result: EnvironmentTarget | null = null;
    if (stage === 'bind') {
      renderer.setRenderTarget = function (next, face, mip) {
        if (next !== old && next !== null) throw new Error('bind failure');
        original(next, face, mip);
      };
    }
    const expectedDescriptor = Object.getOwnPropertyDescriptor(renderer, 'setRenderTarget');
    rendering.beforeRender = object => {
      if (stage === 'room' && object instanceof THREE.Scene || stage === 'filter' && object instanceof THREE.Mesh
        && object.material instanceof THREE.ShaderMaterial) throw new Error('render failure');
    };
    if (stage === 'success') result = createEnvironmentTarget(renderer);
    else expect(() => createEnvironmentTarget(renderer)).toThrow(/failure/);
    expect(Object.getOwnPropertyDescriptor(renderer, 'setRenderTarget')).toEqual(expectedDescriptor);
    expect(Object.getOwnPropertyDescriptor(THREE.WebGLRenderer.prototype, 'setRenderTarget')).toEqual(prototypeDescriptor);
    expect(renderer.getRenderTarget()).toBe(old);
    expect(renderer.getActiveCubeFace()).toBe(2); expect(renderer.getActiveMipmapLevel()).toBe(3);
    expect(renderer.xr.enabled).toBe(true); expect(renderer.autoClear).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(disposeInstance).toHaveBeenCalledTimes(1);
    if (result !== null) {
      expect(result.texture.type).toBe(THREE.HalfFloatType);
      expect(disposeTarget).toHaveBeenCalledTimes(1); // ping-pong only; output is still owned.
      result.dispose(); result.dispose(); // The target's idempotent lifetime owns the actual release.
    }
    expect(disposeTarget).toHaveBeenCalledTimes(2); // output and ping-pong, also on every failure path.
    old.dispose();
  });

  it('retains generation output and peak reservation when real temporary cleanup throws', () => {
    const renderer = new THREE.WebGLRenderer(), pool = createGpuMeshBudget(20000000);
    let fails = true;
    const instances = new Set<object>();
    rendering.beforeRender = object => object.traverse(child => {
      if (child instanceof THREE.InstancedMesh && !instances.has(child)) {
        instances.add(child);
        child.addEventListener('dispose', () => { if (fails) throw new Error('instance cleanup failure'); });
      }
    });
    const store = createEnvironmentStore(() => createEnvironmentTarget(renderer), pool);
    expect(() => store.ensureEnvironment(new THREE.Scene())).toThrow(EnvironmentCreationFailure);
    expect(instances.size).toBe(1);
    expect(store.reservedBytes).toBe(15740016);
    expect(renderer.getRenderTarget()).toBeNull(); expect(renderer.xr.enabled).toBe(true);
    fails = false; store.dispose(); expect(store.reservedBytes).toBe(0);
  });
});
