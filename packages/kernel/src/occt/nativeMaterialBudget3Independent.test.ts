import { beforeAll, expect, it } from 'vitest';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations, type OcctDeletable } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { admitNativeMaterialDomain } from './nativeMaterialDomain.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

it('budget three retains only the iterator and two compound children before refusal', () => {
  const fixture = createAllocations();
  const retained = createAllocations();
  let keepCount = 0;
  let releaseCount = 0;
  const owner: Allocations = {
    keep<T extends OcctDeletable>(item: T): T {
      keepCount += 1;
      return retained.keep(item);
    },
    release(): void { releaseCount += 1; retained.release(); },
  };
  let observed: unknown;
  let checkpoints = 0;
  try {
    const builder = fixture.keep(new oc.BRep_Builder());
    const compound = fixture.keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (let index = 0; index < 8; index += 1) {
      const point = fixture.keep(new oc.gp_Pnt_3(index * 3, 0, 0));
      const maker = fixture.keep(new oc.BRepPrimAPI_MakeBox_3(point, 1, 1, 1));
      const shape: TopoDS_Shape = fixture.keep(maker.Shape());
      builder.Add(compound, shape);
    }
    try {
      admitNativeMaterialDomain(oc, compound, owner, 3, () => {
        checkpoints += 1;
        // No cancellation: this independently exercises capacity exhaustion.
      });
    } catch (error: unknown) { observed = error; }
    finally { owner.release(); }
    expect(observed).toBeInstanceOf(Error);
    expect(observed).toMatchObject({ name: 'NativeMaterialCapacityError' });
    expect(checkpoints).toBeGreaterThan(0);
    // Root reserves one unit without keep; two children each reserve before Value/keep.
    // The iterator is retained too: exactly three handles, independent of eight available children.
    expect(keepCount).toBe(3);
    expect(releaseCount).toBe(1);
  } finally { fixture.release(); }
});
