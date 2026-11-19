/**
 * 付属の組の定義の表(G2 の段 1。設計 wip/k28-bundle3-g2-design.md §1-2)。組ごとに「候補の引き方」と「付け方」を 1 行に持つ。
 * 組を足す時は、この表と、付け直しの表(accessorySync.ts の SYNC_BY_SET)に 1 行ずつ足す。表は組の id の全部を持つ(型が確かめる)。
 * 段 1 では、今の 4 つの組(端のキャップ・ボルトの座金とナット・軸受の軸用と穴用の止め輪)の計算をそのまま移しただけで、動きは変えていない。
 */
import type { CatalogRegistry } from '../catalog/registry.js';
import type { AssemblyDocument, ComponentSource } from '../types.js';
import { accessoryHostOf, type AccessoryHost } from './accessoryHost.js';
import type { AccessorySetId } from './accessoryRecord.js';
import type { AccessoryCandidate, AccessoryChoices, AccessoryRefusal } from './accessorySets.js';
import { applyBearingRingSet, bearingRingCandidates } from './bearingRingSet.js';
import { applyBoltAccessorySet } from './boltAccessorySet.js';
import { applyFrameEndCaps, frameCapCandidates } from './frameEndCaps.js';

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AccessoryRefusal };
const refuse = <T>(reason: AccessoryRefusal): Result<T> => ({ ok: false, reason });

interface AccessorySetDefinition {
  /** 本体(引けない時は null)と、その保存の形の候補。 */
  readonly candidates: (host: AccessoryHost | null, source: ComponentSource, registry: CatalogRegistry) => Result<readonly AccessoryCandidate[]>;
  /** 置いた本体に付けた次の文書。 */
  readonly apply: (document: AssemblyDocument, hostComponentId: string, choices: AccessoryChoices, registry: CatalogRegistry) =>
    Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }>;
}

/** 端のキャップ: 族の部品の本体だけ(本体が引けない・族の部品でない時は noHost)。 */
const FRAME_END_CAPS: AccessorySetDefinition = {
  candidates: (host, _source, registry) => (host?.kind === 'catalogItem' ? frameCapCandidates(host, registry) : refuse('noHost')),
  apply: (document, hostComponentId, choices, registry) => {
    const component = document.components.find((candidate) => candidate.id === hostComponentId);
    const host = component === undefined ? null : accessoryHostOf(component.source, registry);
    const candidates = component === undefined ? refuse<readonly AccessoryCandidate[]>('noHost')
      : FRAME_END_CAPS.candidates(host, component.source, registry);
    if (component === undefined || host?.kind !== 'catalogItem') return refuse('noHost');
    if (!candidates.ok) return refuse(candidates.reason);
    return applyFrameEndCaps(document, component, host, candidates.value, choices, registry);
  },
};

/** 軸受の止め輪(A6): 本体の保存の形から引く(8 分類の深溝玉軸受と族の軸受)。 */
function bearingRings(setId: 'bearing-shaft-rings' | 'bearing-bore-rings'): AccessorySetDefinition {
  return {
    candidates: (_host, source, registry) => bearingRingCandidates(source, setId, registry),
    apply: (document, hostComponentId, choices, registry) => applyBearingRingSet(document, hostComponentId, setId, choices, registry),
  };
}

export const ACCESSORY_SET_DEFINITIONS: Readonly<Record<AccessorySetId, AccessorySetDefinition>> = {
  'frame-end-caps': FRAME_END_CAPS,
  // ボルトの座金とナット(A4)は、選ぶ窓が六角ボルトの保存の形から直に組を出す(族の部品の候補の口では setNotAvailable のまま)。
  'bolt-washer-nut': {
    candidates: (host) => refuse(host?.kind === 'catalogItem' ? 'setNotAvailable' : 'noHost'),
    apply: (document, hostComponentId, choices) => {
      const bolt = applyBoltAccessorySet(document, hostComponentId, choices);
      return bolt.ok ? bolt : refuse('setNotAvailable');
    },
  },
  'bearing-shaft-rings': bearingRings('bearing-shaft-rings'),
  'bearing-bore-rings': bearingRings('bearing-bore-rings'),
};
