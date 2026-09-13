import type { FunctionSurfacePlan } from './functionSurfaceFeature.js';
import { decodeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkRequest } from '@pointercad/expression/math/contracts';

export function functionSurfaceInputSignature(request: FunctionSurfaceWorkRequest): string {
  // Validation owns the snapshot. Include future validated request fields automatically;
  // only the recipient identity is excluded from the mathematical input.
  return JSON.stringify({ algorithm: 'function-surface/3', ...decodeFunctionSurfaceWorkRequest(request), identity: undefined });
}

/** Derived samples only. Full-precision evaluated inputs identify a plan; document IDs never do. */
export class FunctionSurfacePlanCache {
  private readonly entries = new Map<string, { readonly plan: FunctionSurfacePlan; readonly numbers: number }>();
  private numbers = 0;

  constructor(private readonly maximumEntries = 8, private readonly maximumNumbers = 1_000_000) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || !Number.isSafeInteger(maximumNumbers) || maximumNumbers < 1) {
      throw new RangeError('Invalid function surface cache capacity');
    }
  }

  get(inputSignature: string): FunctionSurfacePlan | undefined {
    const entry = this.entries.get(inputSignature);
    if (entry === undefined) return undefined;
    this.entries.delete(inputSignature);
    this.entries.set(inputSignature, entry);
    return entry.plan;
  }

  set(plan: FunctionSurfacePlan): void {
    const geometry = plan.geometry;
    if (!('vertices' in geometry)) return;
    const numbers = 3 * (geometry.vertices.length + geometry.triangles.length) + 6;
    // A large valid surface is still calculated and displayed; only retaining it is declined.
    if (numbers > this.maximumNumbers || plan.inputSignature.length > 262_144) return;
    const previous = this.entries.get(plan.inputSignature);
    if (previous !== undefined) { this.entries.delete(plan.inputSignature); this.numbers -= previous.numbers; }
    const triple = (value: readonly [number, number, number]) => Object.freeze([value[0], value[1], value[2]] as const);
    const saved: FunctionSurfacePlan = Object.freeze({ ...plan, geometry: Object.freeze({
      vertices: Object.freeze(geometry.vertices.map(triple)), triangles: Object.freeze(geometry.triangles.map(triple)),
      bounds: Object.freeze({ minimum: triple(geometry.bounds.minimum), maximum: triple(geometry.bounds.maximum) }),
    }) });
    this.entries.set(plan.inputSignature, { plan: saved, numbers });
    this.numbers += numbers;
    while (this.entries.size > this.maximumEntries || this.numbers > this.maximumNumbers) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry !== undefined) this.numbers -= entry.numbers;
    }
  }

  clear(): void { this.entries.clear(); this.numbers = 0; }
  get retainedNumbers(): number { return this.numbers; }
  get size(): number { return this.entries.size; }
}
