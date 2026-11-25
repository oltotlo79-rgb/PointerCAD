import process from 'node:process';
import { expect, it, vi } from 'vitest';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { hasIgesBindings, IGES_UNAVAILABLE } from './igesBindings.js';
import { isLegacyIgesKernel } from './igesKernelArtifact.testSupport.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { readIges } from './readIges.js';
import { readStep } from './readStep.js';
import type { RgbTuple } from './xcafDocument.js';
import { writeStep } from './writeStep.js';
import { withVirtualFile } from './virtualFile.js';
import { writeIges } from './writeIges.js';
import { buildXcafDocument } from './xcafDocument.js';

function boundsOf(oc: OpenCascadeInstance, shape: TopoDS_Shape) {
  const { keep, release } = createAllocations();
  try {
    const bounds = keep(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, bounds, false, false);
    const low = keep(bounds.CornerMin());
    const high = keep(bounds.CornerMax());
    return [low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()];
  } finally { release(); }
}

it('uses real IGES bindings when installed and reports their absence on the older kernel', async () => {
  const oc = await loadOcctForNode();
  if (!hasIgesBindings(oc)) {
    expect(process.env.PCAD_REQUIRE_IGES).not.toBe('1');
    expect(isLegacyIgesKernel(), 'Only the exact legacy OCCT package may omit the IGES bindings').toBe(true);
    expect(() => readIges(oc, new Uint8Array())).toThrow(IGES_UNAVAILABLE);
    expect(() => writeIges(oc, [])).toThrow(IGES_UNAVAILABLE);
    return;
  }

  const { keep, release } = createAllocations();
  try {
    const origin = keep(new oc.gp_Pnt_3(50, 60, 70));
    const box = keep(keep(new oc.BRepPrimAPI_MakeBox_3(origin, 25.4, 12.7, 6.35)).Shape());
    const plane = keep(new oc.gp_Pln_1());
    const face = keep(keep(new oc.BRepBuilderAPI_MakeFace_9(plane, 0, 25.4, 0, 12.7)).Face());
    const color: readonly [number, number, number] = [0.25, 0.5, 0.75];
    const settings = oc.IGESControl_Writer;
    const originalUnit = settings.WriteUnit();
    const originalMode = settings.WriteBRepMode();
    const prior = [originalUnit, originalMode];
    const units: readonly ('mm' | 'inch')[] = ['mm', 'inch'];
    for (const unit of units) {
      const output = writeIges(oc, [{ shape: box, name: 'BOX25', color }, { shape: face, name: 'FACE25', color }], { unit });
      expect(output.colorWritten).toBe(true);
      expect([settings.WriteUnit(), settings.WriteBRepMode()]).toEqual(prior);
      const records = new TextDecoder().decode(output.bytes).split(/\r?\n/u);
      const entities = records.filter(record => record[72] === 'D').map(record => record.slice(0, 8).trim());
      expect(entities).toContain('144');
      expect(entities).not.toContain('186');

      const read = readIges(oc, output.bytes);
      try {
        expect(read.unit).toBe(unit);
        expect(read.bodies).toHaveLength(2);
        const boxBody = read.bodies.find(body => body.name === 'BOX25');
        const faceBody = read.bodies.find(body => body.name === 'FACE25');
        if (boxBody === undefined || faceBody === undefined) throw new Error('Missing named IGES roots');
        expect(faceBody.kind).toBe('shell');
        expect(boxBody.color).not.toBeNull();
        expect(faceBody.color).not.toBeNull();
        for (const [index, value] of color.entries()) {
          expect(boxBody.color?.[index]).toBeCloseTo(value, 2);
          expect(faceBody.color?.[index]).toBeCloseTo(value, 2);
        }
        const boxBounds = boundsOf(oc, boxBody.shape);
        const faceBounds = boundsOf(oc, faceBody.shape);
        [50, 60, 70, 75.4, 72.7, 76.35].forEach((value, index) => expect(boxBounds[index]).toBeCloseTo(value, 4));
        [0, 0, 0, 25.4, 12.7, 0].forEach((value, index) => expect(faceBounds[index]).toBeCloseTo(value, 4));
      } finally { read.delete(); }
    }
    expect(() => readIges(oc, new Uint8Array())).toThrow('このファイルには形が入っていません。');
    expect(() => readIges(oc, new TextEncoder().encode('broken IGES'))).toThrow('このファイルを読めませんでした。');

    // The regular product writer uses trimmed surfaces. Make the 186 input
    // independently with the native writer in B-rep mode.
    const document = buildXcafDocument(oc, [{ shape: box, name: 'BOX186', color }], { bodyLabelColor: true });
    try {
      expect(settings.SetWriteUnit('INCH')).toBe(true);
      expect(settings.SetWriteBRepMode(1)).toBe(true);
      const native = keep(new oc.IGESCAFControl_Writer_1());
      native.SetNameMode(true);
      native.SetColorMode(true);
      native.SetLayerMode(false);
      const progress = keep(new oc.Message_ProgressRange_1());
      const files = withVirtualFile(oc, 'iges', path => {
        const name = keep(new oc.TCollection_AsciiString_2(path));
        expect(native.Perform_1(document.handle, name, progress)).toBe(true);
      });
      expect(files).toHaveLength(1);
      const manifold = files[0]?.bytes;
      if (manifold === undefined) throw new Error('Missing native IGES output');
      const records = new TextDecoder().decode(manifold).split(/\r?\n/u);
      expect(records.some(record => record[72] === 'D' && record.slice(0, 8).trim() === '186')).toBe(true);
      const loaded = readIges(oc, manifold);
      try {
        expect(loaded.unit).toBe('inch');
        expect(loaded.bodies).toHaveLength(1);
        const body = loaded.bodies[0];
        if (body === undefined) throw new Error('Missing manifold solid');
        expect(body).toMatchObject({ name: 'BOX186', kind: 'solid' });
        const boxBounds = boundsOf(oc, body.shape);
        [50, 60, 70, 75.4, 72.7, 76.35].forEach((value, index) => {
          expect(boxBounds[index]).toBeCloseTo(value, 4);
        });
      } finally { loaded.delete(); }

      const prototype = Object.getPrototypeOf(native) as Pick<typeof native, 'Perform_1'>;
      const transfer = vi.spyOn(prototype, 'Perform_1').mockImplementationOnce(() => {
        expect([settings.WriteUnit(), settings.WriteBRepMode()]).toEqual(['MM', 0]);
        return false;
      });
      try {
        expect(() => writeIges(oc, [{ shape: box, name: 'BOX186', color }], { unit: 'mm' }))
          .toThrow('IGES ファイルを書き出せませんでした。');
        expect(transfer).toHaveBeenCalledTimes(1);
        expect([settings.WriteUnit(), settings.WriteBRepMode()]).toEqual(['INCH', 1]);
      } finally { transfer.mockRestore(); }
    } finally {
      try {
        const restoredUnit = settings.SetWriteUnit(originalUnit);
        const restoredMode = settings.SetWriteBRepMode(originalMode);
        expect([restoredUnit, restoredMode]).toEqual([true, true]);
      } finally { document.delete(); }
    }
  } finally { release(); }
});

it('retains mixed and partial native IGES face colors without inventing a body color', async () => {
  const oc = await loadOcctForNode();
  if (!hasIgesBindings(oc)) {
    expect(process.env.PCAD_REQUIRE_IGES).not.toBe('1');
    expect(isLegacyIgesKernel()).toBe(true);
    return;
  }

  const { keep, release } = createAllocations();
  try {
    const box = keep(keep(new oc.BRepPrimAPI_MakeBox_2(25.4, 12.7, 6.35)).Shape());
    const first: RgbTuple = [0.25, 0.5, 0.75];
    const second: RgbTuple = [0.8, 0.35, 0.63];
    const faceColors = new Map([[0, first], [1, second]]);
    const body = { shape: box, name: 'PATCHES', color: null, faceColors };
    const written = writeIges(oc, [body]);
    expect(written.colorWritten).toBe(true);
    const read = readIges(oc, written.bytes);
    try {
      expect(read.bodies).toHaveLength(1);
      const imported = read.bodies[0];
      expect(imported.name).toBe(body.name);
      expect(imported.color).toBeNull();
      expect(imported.faceColors.size).toBe(2);
      const colors = [...imported.faceColors.values()].sort((left, right) => left[0] - right[0]);
      [first, second].forEach((rgb, face) => {
        rgb.forEach((component, index) => expect(colors[face][index]).toBeCloseTo(component, 2));
      });
    } finally { read.delete(); }

    const ignored = readIges(oc, written.bytes, false);
    try {
      expect(ignored.bodies).toHaveLength(1);
      expect(ignored.bodies[0].color).toBeNull();
      expect(ignored.bodies[0].faceColors.size).toBe(0);
    } finally { ignored.delete(); }

    const suppressed = writeIges(oc, [{ ...body, color: first }], { withColors: false });
    expect(suppressed.colorWritten).toBe(false);
    const uncolored = readIges(oc, suppressed.bytes);
    try {
      expect(uncolored.bodies).toHaveLength(1);
      expect(uncolored.bodies[0].color).toBeNull();
      expect(uncolored.bodies[0].faceColors.size).toBe(0);
    } finally { uncolored.delete(); }
  } finally { release(); }
});

it('keeps STEP and IGES settings usable after a failed STEP import', async () => {
  const oc = await loadOcctForNode();
  if (!hasIgesBindings(oc)) {
    expect(process.env.PCAD_REQUIRE_IGES).not.toBe('1');
    expect(isLegacyIgesKernel()).toBe(true);
    return;
  }

  const { keep, release } = createAllocations();
  try {
    keep(new oc.STEPCAFControl_Writer_1());
    const step = oc.Interface_Static;
    const iges = oc.IGESControl_Writer;
    const originalStepUnit = step.CVal('write.step.unit');
    const originalCascadeUnit = step.CVal('xstep.cascade.unit');
    const originalIges = [iges.WriteUnit(), iges.WriteBRepMode()];
    try {
      expect(step.SetCVal('write.step.unit', 'INCH')).toBe(true);
      expect(() => readStep(oc, new TextEncoder().encode('broken STEP'))).toThrow('このファイルを読めませんでした。');
      expect(step.CVal('write.step.unit')).toBe('INCH');
      expect(step.CVal('xstep.cascade.unit')).toBe('MM');
      expect([iges.WriteUnit(), iges.WriteBRepMode()]).toEqual(originalIges);

      const box = keep(keep(new oc.BRepPrimAPI_MakeBox_2(25.4, 12.7, 6.35)).Shape());
      const shape = [{ shape: box, name: 'BOX25', color: null }];
      const written = writeStep(oc, shape);
      const stepRead = readStep(oc, written.bytes);
      try {
        expect(stepRead.unit).toBe('inch');
        expect(stepRead.bodies).toHaveLength(1);
        expect(boundsOf(oc, stepRead.bodies[0].shape)[3]).toBeCloseTo(25.4, 4);
      } finally { stepRead.delete(); }
      expect(writeIges(oc, shape, { unit: 'mm' }).bytes.byteLength).toBeGreaterThan(0);
      expect([iges.WriteUnit(), iges.WriteBRepMode()]).toEqual(originalIges);
      expect(step.CVal('write.step.unit')).toBe('INCH');
    } finally {
      step.SetCVal('write.step.unit', originalStepUnit);
      step.SetCVal('xstep.cascade.unit', originalCascadeUnit);
    }
  } finally { release(); }
});
