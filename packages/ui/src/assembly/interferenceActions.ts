/** 干渉解析と、配置済み部品どうしの正確な隙間測定(P7 タスク26)。 */
import type {
  AssemblyInterferenceInput, AssemblyInterferenceOptions, AssemblyInterferenceResult,
  InterferenceKernelBridge, LengthUnit,
} from '@pointercad/model';
import { measurementFromDistance } from '../solid/measureCommands.js';
import type { MeasurementState } from '../viewport/createMeasureLayer.js';

export interface AssemblyInterferenceRunner {
  check(
    input: AssemblyInterferenceInput,
    options?: AssemblyInterferenceOptions,
  ): Promise<AssemblyInterferenceResult>;
  measureGap(
    input: AssemblyInterferenceInput,
    aComponentId: string,
    bComponentId: string,
    unit: LengthUnit,
  ): Promise<MeasurementState | null>;
}

type GapBridge = Pick<InterferenceKernelBridge, 'measure'>;

interface GapBody {
  readonly featureId: string;
  readonly bodyKey: string;
}

function componentBodies(
  input: AssemblyInterferenceInput,
  componentId: string,
): readonly GapBody[] | null {
  const partKey = input.resolved.partKeys.get(componentId);
  const part = partKey === undefined ? undefined : input.resolved.parts.get(partKey);
  if (part === undefined) return null;
  const bodies: GapBody[] = [];
  for (const featureId of part.liveBodyIds) {
    const step = part.steps.find((candidate) => candidate.featureId === featureId && candidate.visible);
    if (step === undefined) return null;
    bodies.push({ featureId, bodyKey: step.key });
  }
  return bodies.length === 0 ? null : bodies;
}

/**
 * 保存配置や境界箱ではなく、表示中の世界配置を OCCT の既存 distance 測定へ渡す。
 * 複数ボディなら全組の最小値を採り、1 組でも測定に失敗した場合は過大な隙間を出さない。
 */
export async function measureAssemblyGap(
  bridge: GapBridge,
  input: AssemblyInterferenceInput,
  aComponentId: string,
  bComponentId: string,
  unit: LengthUnit,
): Promise<MeasurementState | null> {
  if (aComponentId === bComponentId) return null;
  const bodiesA = componentBodies(input, aComponentId);
  const bodiesB = componentBodies(input, bComponentId);
  const placementA = input.placements.get(aComponentId);
  const placementB = input.placements.get(bComponentId);
  if (bodiesA === null || bodiesB === null || placementA === undefined || placementB === undefined) return null;

  let closest: { readonly distance: number; readonly pointA: readonly [number, number, number];
    readonly pointB: readonly [number, number, number] } | null = null;
  for (const bodyA of bodiesA) {
    for (const bodyB of bodiesB) {
      const outcome = await bridge.measure([], [
        { bodyFeatureId: bodyA.featureId, bodyKey: bodyA.bodyKey, subShape: null, placement: placementA },
        { bodyFeatureId: bodyB.featureId, bodyKey: bodyB.bodyKey, subShape: null, placement: placementB },
      ], 'distance');
      if (outcome.kind !== 'distance' || !Number.isFinite(outcome.distance) || outcome.distance < 0) return null;
      if (closest === null || outcome.distance < closest.distance) {
        closest = { distance: outcome.distance, pointA: outcome.pointA, pointB: outcome.pointB };
      }
      if (outcome.distance === 0) {
        return measurementFromDistance('bodyDistance', 0, outcome.pointA, outcome.pointB, unit);
      }
    }
  }
  return closest === null ? null
    : measurementFromDistance('bodyDistance', closest.distance, closest.pointA, closest.pointB, unit);
}

export function createAssemblyInterferenceRunner(
  bridge: InterferenceKernelBridge,
): AssemblyInterferenceRunner {
  return {
    check: (input, options) => bridge.checkInterference(input, options),
    measureGap: (input, a, b, unit) => measureAssemblyGap(bridge, input, a, b, unit),
  };
}
