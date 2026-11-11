import { expect, it } from 'vitest';
import type { createKernelApi } from '@pointercad/kernel';
import type { AnalysisBoundaryRequest, AnalysisBoundaryReply } from '../geometry/analysisMesh.js';

type ConcreteKernelApi = ReturnType<typeof createKernelApi>;
type KernelRequest = Parameters<ConcreteKernelApi['buildAnalysisSurfaceMesh']>[0];
type KernelMesh = Extract<Awaited<ReturnType<ConcreteKernelApi['buildAnalysisSurfaceMesh']>>, { kind: 'mesh' }>['mesh'];
type ModelMesh = Extract<AnalysisBoundaryReply, { kind: 'mesh' }>['mesh'];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const requestsIdentical: Equal<KernelRequest, AnalysisBoundaryRequest> = true;
const qualityEvidenceIdentical: Equal<KernelMesh['shellQuality'], ModelMesh['shellQuality']> = true;
it('keeps the complete optional request keys and cylindrical evidence identical across kernel/model', () => {
  expect(requestsIdentical).toBe(true);
  expect(qualityEvidenceIdentical).toBe(true);
});
