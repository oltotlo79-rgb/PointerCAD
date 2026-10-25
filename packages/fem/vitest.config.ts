import { defineConfig } from 'vitest/config';
import { PerformanceFirstSequencer } from '@pointercad/test-utils/performance-sequencer';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../test-utils/src/releasePerformance.js';

export default defineConfig({
  test: {
    environment: 'node',
    // Plastic product contracts and the unchanged plan/native readers use this same finite collection.
    include: ['src/solidPlastic.test.ts', 'src/solidPlasticTranslation.test.ts', 'src/solidPlasticResults.test.ts', 'src/solidPlasticIntegration.test.ts', 'src/cadSolidAnalysis.test.ts', 'src/cadSolidPlastic.test.ts', 'src/solidAnalysisTranslation.test.ts', 'src/solidAnalysisResults.test.ts', 'src/cadAssemblyTetraMesh.test.ts', 'src/assemblyTetraMesh.test.ts', 'src/tetraMeshQuality.test.ts', 'src/cadShellSurfaceMesh.test.ts', 'src/tetraMesh.test.ts', 'src/cadTetraMesh.test.ts', 'src/curvedPlcBound.test.ts', 'src/cadCurvedTetraMesh.test.ts', 'src/workspace.test.ts', 'src/modal.test.ts', 'src/client.contract.test.ts', 'src/offlineBrowser.contract.test.ts', 'src/buckling.test.ts', 'src/buckling.package.test.ts', 'src/cadBuckling.test.ts', 'src/transient.test.ts', 'src/transientAxial.test.ts', 'src/transientDamping.test.ts', 'src/plasticBar.test.ts', 'src/plasticBarIntegration.test.ts', 'src/contactModel.test.ts', 'src/contactIntegration.test.ts', 'src/beamBoltContact.test.ts', 'src/beamBoltClient.test.ts', 'src/beamWeldContact.test.ts', 'src/beamWeldClient.test.ts', 'src/beamJointContact.test.ts', 'src/beamJointClient.test.ts', 'src/beamJointInitialStrain.test.ts', 'src/beamInitialStrainClient.test.ts', 'src/cadBeamJointInitialStrain.test.ts', 'src/cadBeamJointContact.test.ts', 'src/fatigue.test.ts', 'src/fatiguePiecewise.test.ts', 'src/fatigueTensor.test.ts', 'src/fatigueAxial.test.ts', 'src/beamImpact.test.ts', 'src/beamImpactBoundary.test.ts', 'src/beamImpactClient.test.ts', 'src/beamImpactNativeFixture.test.ts', 'src/beamFibreStress.test.ts', 'src/beamImpactNativeInterior.test.ts', 'src/beamImpactNativeCurrent.test.ts', 'src/beamImpactInterior.test.ts', 'src/beamImpactMemberResponse.test.ts', 'src/fatigueStrainHistory.test.ts', 'src/fatigueStrainLife.test.ts', 'src/fatigueStrainPersistence.test.ts', 'src/fatigueLocalCycle.test.ts', 'src/fatigueLocalCyclePersistence.test.ts', 'src/solidModalResults.test.ts', 'src/solidModalRuntime.test.ts', 'src/solidModalNative.test.ts', 'src/solidBuckling.test.ts', 'src/solidBucklingRuntime.test.ts', 'src/solidBucklingNative.test.ts', 'src/solidPlasticNative.test.ts', 'src/fatigueStrainStressHistory.test.ts', 'src/fatigueStrainStressPersistence.test.ts', 'src/fatigueSolid.test.ts', 'src/solidFatigueClient.test.ts',
      'src/shellCapability.test.ts',
      'src/solidMeshConvergence.test.ts',
      'src/analysisMassConsistency.test.ts',
      'src/cadAnalysisBoundaryIdentity.test.ts',
      'src/pythonTests.test.ts'],
    testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS,
    fileParallelism: false,
    sequence: { sequencer: PerformanceFirstSequencer },
  },
});
