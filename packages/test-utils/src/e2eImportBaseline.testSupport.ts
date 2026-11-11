// Exact existing e2e-to-product references. Review each reason before expanding this baseline.
export const e2eImportBaseline = [
  {
    "consumer": "e2e/tests/analysisResourcesFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Real PCAD assembly file writer."
  },
  {
    "consumer": "e2e/tests/analysisResourcesFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Real assembly document and bundle construction."
  },
  {
    "consumer": "e2e/tests/analysisResourcesFixture.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.testSupport.js",
    "target": "packages/model/src/analysis/beamInputs.testSupport.js",
    "count": 1,
    "reason": "Existing catalog flat-bar source and placement fixture."
  },
  {
    "consumer": "e2e/tests/analysisPlasticPersistenceFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Read the saved real PCAD file to check plastic input persistence after reopening."
  },
  {
    "consumer": "e2e/tests/plasticBarPlateauFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Read the real saved PCAD file to check the persisted plastic bar yield plateau strain (plateauPlasticStrain 0.01) after the UI flow."
  },
  {
    "consumer": "e2e/tests/analysisFatigueNativeFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Read the real saved PCAD file to verify fatigue and solid input persistence and absence of derived analysis results in the native fatigue UI flow."
  },
  {
    "consumer": "e2e/tests/analysisAdvancedFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Decode the saved real file to check advanced analysis inputs after reopening."
  },
  {
    "consumer": "e2e/tests/shellAnalysisPersistenceFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Decode the saved real file to compare persisted shell analysis inputs."
  },
  {
    "consumer": "e2e/tests/analysisBoltPersistenceFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Decode the saved real file to compare persisted bolt analysis inputs."
  },
  {
    "consumer": "e2e/tests/analysisBoltPersistenceFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Construct the standard fixture document and its part keys."
  },
  {
    "consumer": "e2e/tests/analysisBoltPersistenceFlow.ts",
    "specifier": "../../packages/model/src/analysis/axialBoltInput.js",
    "target": "packages/model/src/analysis/axialBoltInput.js",
    "count": 1,
    "reason": "Use the stored axial bolt input type for the persistence assertion."
  },
  {
    "consumer": "e2e/tests/analysisBoltPersistenceFlow.ts",
    "specifier": "../../packages/model/src/analysis/cadAxialBolt.testSupport.js",
    "target": "packages/model/src/analysis/cadAxialBolt.testSupport.js",
    "count": 1,
    "reason": "Reuse the independent two-spring axial bolt fixture input."
  },
  {
    "consumer": "e2e/fixtures/offlineNavigationClient.ts",
    "specifier": "../../packages/ui/src/help/offlineManualNavigation.js",
    "target": "packages/ui/src/help/offlineManualNavigation.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/help/offlineManualNavigation.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/fixtures/offlinePreparationClient.ts",
    "specifier": "../../apps/web/src/pwa/browserOfflineGateway.js",
    "target": "apps/web/src/pwa/browserOfflineGateway.js",
    "count": 1,
    "reason": "Existing e2e dependency on apps/web/src/pwa/browserOfflineGateway.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/fixtures/offlinePreparationClient.ts",
    "specifier": "../../apps/web/src/pwa/offlineRegistration.js",
    "target": "apps/web/src/pwa/offlineRegistration.js",
    "count": 1,
    "reason": "Existing e2e dependency on apps/web/src/pwa/offlineRegistration.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/release/packagedDesktop.spec.ts",
    "specifier": "../../packages/drawing/src/text/fontAsset.js",
    "target": "packages/drawing/src/text/fontAsset.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/drawing/src/text/fontAsset.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly.spec.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFixture.ts",
    "specifier": "../../packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js",
    "target": "packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFlow.ts",
    "specifier": "../../packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js",
    "target": "packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/pcad/assemblyDistinctPartsFixture.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFlow.ts",
    "specifier": "../../packages/test-utils/src/interferenceCompletion.js",
    "target": "packages/test-utils/src/interferenceCompletion.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/interferenceCompletion.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assembly1000HostFlow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyCoupledDragFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyCoupledDragFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyCoupledDragFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyFlexibleMotionFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyFlexibleMotionFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyFlexibleMotionFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyMechanismOracleFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyMechanismOracleFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyMechanismOracleFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyMechanismOracleFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyTestSupport.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyTestSupport.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyTestSupport.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/assemblyTestSupport.ts",
    "specifier": "../../packages/ui/src/file/fileGateway.js",
    "target": "packages/ui/src/file/fileGateway.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/file/fileGateway.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/autoSaveSettingsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/assets.js",
    "target": "packages/fem/src/assets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/assets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/bucklingNative.testSupport.js",
    "target": "packages/fem/src/bucklingNative.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/bucklingNative.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/transientBenchmark.testSupport.js",
    "target": "packages/fem/src/transientBenchmark.testSupport.js",
    "count": 1,
    "reason": "The real Worker bounded cost and accuracy benchmark uses exactly this existing FEM test helper; timing adds no release threshold."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/transientDampingNative.testSupport.js",
    "target": "packages/fem/src/transientDampingNative.testSupport.js",
    "count": 1,
    "reason": "Real Worker transient regression uses this existing FEM test support through its exact E2E consumer."
  },
  {
    "consumer": "e2e/tests/beam-buckling-native.spec.ts",
    "specifier": "../../packages/fem/src/transientNative.testSupport.js",
    "target": "packages/fem/src/transientNative.testSupport.js",
    "count": 1,
    "reason": "Real Worker transient regression uses this existing FEM test support through its exact E2E consumer."
  },
  {
    "consumer": "e2e/tests/boltedJointAcceptFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/boltedJointAcceptFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/boltPreloadFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/boltPreloadFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.js",
    "target": "packages/model/src/analysis/beamInputs.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/boltPreloadFlow.ts",
    "specifier": "../../packages/model/src/analysis/cadNativeBoltPreloadInput.testSupport.js",
    "target": "packages/model/src/analysis/cadNativeBoltPreloadInput.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/cadNativeBoltPreloadInput.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/boltPreloadFlow.ts",
    "specifier": "../../packages/ui/src/beam/attachBeamAnalysis.js",
    "target": "packages/ui/src/beam/attachBeamAnalysis.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/beam/attachBeamAnalysis.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/browserSaveAbortFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cameraControlsSettingsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/canvasAssetLifetimeFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/canvasAssetLifetimeFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/circularWeldFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/circularWeldFlow.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/circularWeldFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/combinedWeldStressFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/combinedWeldStressFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.js",
    "target": "packages/model/src/analysis/beamInputs.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/combinedWeldStressFlow.ts",
    "specifier": "../../packages/model/src/analysis/cadJointContact.testSupport.js",
    "target": "packages/model/src/analysis/cadJointContact.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/cadJointContact.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/combinedWeldStressFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/command-registry.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/connectPointsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/connectRefusalsFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/connectRefusalsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/connectRefusalsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-cycle-open.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-cycle-open.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-cycle-open.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 2,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-repair.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-repair.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-repair.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-route5.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-route5.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/context-reference-route5.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/contextReferenceCycleFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/contextReferenceCycleFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/contextReferenceCycleFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/coordinateToolDefaultsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/expression/src/math/publicContracts.js",
    "target": "packages/expression/src/math/publicContracts.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/publicContracts.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/expression/src/math/publicWorker.js",
    "target": "packages/expression/src/math/publicWorker.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/publicWorker.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cutPlaneMaterialsFlow.ts",
    "specifier": "../../packages/ui/src/viewport/createSolidLayer.js",
    "target": "packages/ui/src/viewport/createSolidLayer.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/viewport/createSolidLayer.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 3,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 2,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/kernel/src/worker/recomputeSolids.js",
    "target": "packages/kernel/src/worker/recomputeSolids.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/recomputeSolids.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/kernel/src/worker/shapeCache.js",
    "target": "packages/kernel/src/worker/shapeCache.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/shapeCache.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/assembly/partLibrary.js",
    "target": "packages/model/src/assembly/partLibrary.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/assembly/partLibrary.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/assembly/placementMath.js",
    "target": "packages/model/src/assembly/placementMath.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/assembly/placementMath.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/geometry/subShapeRef.js",
    "target": "packages/model/src/geometry/subShapeRef.js",
    "count": 2,
    "reason": "Existing e2e dependency on packages/model/src/geometry/subShapeRef.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/kernelBridge.js",
    "target": "packages/model/src/kernelBridge.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/kernelBridge/referenceResolution.js",
    "target": "packages/model/src/kernelBridge/referenceResolution.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/referenceResolution.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/cylinderSubshapeColdFlow.ts",
    "specifier": "../../packages/model/src/sketch/vec3.js",
    "target": "packages/model/src/sketch/vec3.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/sketch/vec3.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentDiffFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentDiffFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentDiffFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentMaterialDiffFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentMaterialDiffFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/documentMaterialDiffFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-performance.spec.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-recovery.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-sheet-expressions.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-source-refresh.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-source-refresh.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawing-source-refresh.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingDeleteElementsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingDeleteElementsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingNavigationFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingNavigationFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingPerformanceFixture.ts",
    "specifier": "../../packages/drawing/src/index.js",
    "target": "packages/drawing/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/drawing/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingPerformanceFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingPerformanceFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingPerformanceFixture.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingPerformanceFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingTestSupport.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingTestSupport.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingTestSupport.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/drawingToolDefaultsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electron-flows.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electron-sheet.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electronOcctTransportNegativeFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electronOcctTransportNegativeFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electronOcctTransportNegativeFlow.ts",
    "specifier": "../../packages/kernel/src/occt/desktopOcctTransportContract.js",
    "target": "packages/kernel/src/occt/desktopOcctTransportContract.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/desktopOcctTransportContract.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electronOcctTransportNegativeFlow.ts",
    "specifier": "../../packages/kernel/src/occt/occtAssetManifest.js",
    "target": "packages/kernel/src/occt/occtAssetManifest.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/occtAssetManifest.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/electronOcctTransportNegativeFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/model/src/part/ex18ShapeOracle.testSupport.js",
    "target": "packages/model/src/part/ex18ShapeOracle.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/ex18ShapeOracle.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18RoutesOracle.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18SurfaceSewSolidFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18SurfaceSewSolidFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18SurfaceSewSolidFlow.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/ex18SurfaceSewSolidFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/facePointsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/fatigueDetailFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/fatigueLocalCycleFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/fatigueStrainPairedFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/file-open-rejection.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/file-open-rejection.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/filletWeldAcceptFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/filletWeldAcceptFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/filletWeldFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/flows/extrudeOperationFlow.ts",
    "specifier": "../../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/frictionFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/frictionFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.js",
    "target": "packages/model/src/analysis/beamInputs.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/frictionFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.testSupport.js",
    "target": "packages/model/src/analysis/beamInputs.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/frictionFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/functionDirectionMessages.ts",
    "specifier": "../../packages/ui/src/i18n/ja/math.json",
    "target": "packages/ui/src/i18n/ja/math.json",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/i18n/ja/math.json; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/functionMessages.ts",
    "specifier": "../../packages/ui/src/i18n/ja/math.json",
    "target": "packages/ui/src/i18n/ja/math.json",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/i18n/ja/math.json; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/functionMessages.ts",
    "specifier": "../../packages/ui/src/i18n/ja/sketch.json",
    "target": "packages/ui/src/i18n/ja/sketch.json",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/i18n/ja/sketch.json; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/functionSplineSurfaceFlow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdt-all.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdt-all.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdt-all.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdt-position.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdtFullFixture.ts",
    "specifier": "../../packages/drawing/src/index.js",
    "target": "packages/drawing/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/drawing/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdtFullFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdtFullFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdtFullFixture.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/gdtFullFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/helpReaderFlow.ts",
    "specifier": "../../packages/help-content/src/topics.js",
    "target": "packages/help-content/src/topics.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/help-content/src/topics.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/impactFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/impactFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.js",
    "target": "packages/model/src/analysis/beamInputs.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/impactFlow.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.testSupport.js",
    "target": "packages/model/src/analysis/beamInputs.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/impactFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/intersectionsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/intersectionsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceFlow.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/expression/src/math/publicContracts.js",
    "target": "packages/expression/src/math/publicContracts.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/publicContracts.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/expression/src/math/publicWorker.js",
    "target": "packages/expression/src/math/publicWorker.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/publicWorker.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/brepBytes.js",
    "target": "packages/kernel/src/occt/brepBytes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/brepBytes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/extractEdges.js",
    "target": "packages/kernel/src/occt/extractEdges.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/extractEdges.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/holePlacementOracle.testSupport.js",
    "target": "packages/kernel/src/occt/holePlacementOracle.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/holePlacementOracle.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/makeHole.js",
    "target": "packages/kernel/src/occt/makeHole.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/makeHole.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/subShapes.js",
    "target": "packages/kernel/src/occt/subShapes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/subShapes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/occt/tessellate.js",
    "target": "packages/kernel/src/occt/tessellate.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/tessellate.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/kernel/src/types.js",
    "target": "packages/kernel/src/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/kernelBridge/solidContracts.js",
    "target": "packages/model/src/kernelBridge/solidContracts.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/solidContracts.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/kernelBridge/solidRequests.js",
    "target": "packages/model/src/kernelBridge/solidRequests.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/solidRequests.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/part/evaluateDocumentMath.js",
    "target": "packages/model/src/part/evaluateDocumentMath.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/evaluateDocumentMath.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/part/ex18ShapeOracle.testSupport.js",
    "target": "packages/model/src/part/ex18ShapeOracle.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/ex18ShapeOracle.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/machiningSurfaceOracle.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathClosedIntegralsFlow.ts",
    "specifier": "../../packages/expression/src/math/closedIntegrals.js",
    "target": "packages/expression/src/math/closedIntegrals.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/closedIntegrals.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathCoverageFlow.ts",
    "specifier": "../../packages/expression/src/math/differentialEquationNotation.js",
    "target": "packages/expression/src/math/differentialEquationNotation.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/differentialEquationNotation.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathCoverageFlow.ts",
    "specifier": "../../packages/expression/src/math/mathTextSyntax.js",
    "target": "packages/expression/src/math/mathTextSyntax.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/mathTextSyntax.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathEditorReady.ts",
    "specifier": "../../packages/expression/src/math/exactMathEngineClient.js",
    "target": "packages/expression/src/math/exactMathEngineClient.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/math/exactMathEngineClient.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathGeometryFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathGeometryFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathGeometryFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathGeometryReferenceFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/mathPaceSlowFlow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/memoryHighwaterFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/memoryHighwaterFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/memoryHighwaterFlow.ts",
    "specifier": "../../packages/test-utils/src/processMemorySamples.js",
    "target": "packages/test-utils/src/processMemorySamples.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/processMemorySamples.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/namedSavePointCapacityFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/namedSavePointsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 3,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/namedSavePointsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/namedViewUnavailableFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/nameSearchFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/nameSearchFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/assets.js",
    "target": "packages/fem/src/assets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/assets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamJointAssets.js",
    "target": "packages/fem/src/beamJointAssets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamJointAssets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamJointInitialStrainAssets.js",
    "target": "packages/fem/src/beamJointInitialStrainAssets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamJointInitialStrainAssets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamWeldAssets.js",
    "target": "packages/fem/src/beamWeldAssets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamWeldAssets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/nativeBoltPreload.js",
    "target": "packages/fem/src/nativeBoltPreload.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/nativeBoltPreload.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/nativeBoltPreloadBinding.js",
    "target": "packages/fem/src/nativeBoltPreloadBinding.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/nativeBoltPreloadBinding.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-bolt-preload-worker.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamWeldSpanAssets.js",
    "target": "packages/fem/src/beamWeldSpanAssets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamWeldSpanAssets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamWeldSpanContact.js",
    "target": "packages/fem/src/beamWeldSpanContact.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamWeldSpanContact.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/beamWeldSpanStress.js",
    "target": "packages/fem/src/beamWeldSpanStress.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/beamWeldSpanStress.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/modal.testSupport.js",
    "target": "packages/fem/src/modal.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/modal.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/native-weld-stress-worker.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/occtCompileReuseFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/occtCompileReuseFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/occtCompileReuseFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/occtCompileReuseFlow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/offlineEditionFixture.ts",
    "specifier": "../../packages/ui/src/security/contentSecurityPolicy.js",
    "target": "packages/ui/src/security/contentSecurityPolicy.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/security/contentSecurityPolicy.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/openDocumentHistoryFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/openDocumentHistoryFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/p8-drawing.spec.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/partAssetLifetimeFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/partAssetLifetimeFlow.ts",
    "specifier": "../../packages/kernel/src/occt/brepBytes.js",
    "target": "packages/kernel/src/occt/brepBytes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/brepBytes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/partAssetLifetimeFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/pg5aSolidPixelsFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/pg5aSolidPixelsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/pg5aSolidPixelsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningFlow.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/allocations.js",
    "target": "packages/kernel/src/occt/allocations.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/allocations.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/brepBytes.js",
    "target": "packages/kernel/src/occt/brepBytes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/brepBytes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/extractEdges.js",
    "target": "packages/kernel/src/occt/extractEdges.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/extractEdges.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/makeHole.js",
    "target": "packages/kernel/src/occt/makeHole.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/makeHole.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/subShapes.js",
    "target": "packages/kernel/src/occt/subShapes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/subShapes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/occt/tessellate.js",
    "target": "packages/kernel/src/occt/tessellate.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/occt/tessellate.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/kernel/src/types.js",
    "target": "packages/kernel/src/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/kernelBridge/solidRequests.js",
    "target": "packages/model/src/kernelBridge/solidRequests.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/solidRequests.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/planarMachiningOracle.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/process-resource-sampler.spec.ts",
    "specifier": "../../packages/test-utils/src/processMemorySamples.js",
    "target": "packages/test-utils/src/processMemorySamples.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/processMemorySamples.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/processResourceSampler.ts",
    "specifier": "../../packages/test-utils/src/processMemorySamples.js",
    "target": "packages/test-utils/src/processMemorySamples.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/processMemorySamples.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/radialMenuModesFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/readLifecycleFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/readLifecycleFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/readResponseFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/readResponseFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/readResponsivenessFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/recompute.ts",
    "specifier": "../../packages/expression/src/math/publicClient.js",
    "target": "packages/expression/src/math/publicClient.js",
    "count": 1,
    "reason": "Root-approved exact-math reopen wait reads EXACT_MATH_ENGINE_LIMITS.totalMs from the real public client source. Actual worker preparation progressed at 143272ms; the package alias is not resolvable from e2e. This single reference preserves the canonical math limit without copying it or changing the kernel default."
  },
  {
    "consumer": "e2e/tests/recompute.ts",
    "specifier": "../../packages/test-utils/src/recomputeState.js",
    "target": "packages/test-utils/src/recomputeState.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/recomputeState.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/recompute.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/recompute.ts",
    "specifier": "../../packages/ui/src/app/PointerCadApp.js",
    "target": "packages/ui/src/app/PointerCadApp.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/app/PointerCadApp.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/recompute.ts",
    "specifier": "../../packages/ui/src/store/recomputeSlice.js",
    "target": "packages/ui/src/store/recomputeSlice.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/store/recomputeSlice.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFixture.ts",
    "specifier": "../../packages/kernel/src/index.js",
    "target": "packages/kernel/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFixture.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceAmbiguityFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceRepairAppearanceFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceRepairAppearanceFixture.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/referenceRepairAppearanceFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  { "consumer": "e2e/tests/saveResponsivenessFlow.ts", "specifier": "../../packages/test-utils/src/releasePerformance.js", "target": "packages/test-utils/src/releasePerformance.js", "count": 1, "reason": "Root-approved save response observation retains all 100 paired max readings and strict p95<100 target status while rejecting missing/invalid samples." },
  {
    "consumer": "e2e/tests/saveResponsivenessFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/saveResponsivenessFlow.ts",
    "specifier": "../../packages/io/src/limits.js",
    "target": "packages/io/src/limits.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/limits.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/saveResponsivenessFlow.ts",
    "specifier": "../../packages/io/src/pcad/pcadFile.js",
    "target": "packages/io/src/pcad/pcadFile.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/pcad/pcadFile.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/saveResponsivenessFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/saveResponsivenessFlow.ts",
    "specifier": "../../packages/test-utils/src/processMemorySamples.js",
    "target": "packages/test-utils/src/processMemorySamples.js",
    "count": 1,
    "reason": "R06 save sampler validates every discovered PID and retains missing reads as unknown before the existing memory-budget assertion."
  },
  {
    "consumer": "e2e/tests/script-performance.spec.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/scriptLimitsFlow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/scriptsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/scriptsFlow.ts",
    "specifier": "../../packages/model/src/scripting/scriptTypes.js",
    "target": "packages/model/src/scripting/scriptTypes.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/scripting/scriptTypes.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/io/src/pcad/documentJson.js",
    "target": "packages/io/src/pcad/documentJson.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/pcad/documentJson.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/kernel/src/types.js",
    "target": "packages/kernel/src/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/geometry/subShapeRef.js",
    "target": "packages/model/src/geometry/subShapeRef.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/geometry/subShapeRef.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/kernelBridge.js",
    "target": "packages/model/src/kernelBridge.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/kernelBridge/createSubShapeReference.js",
    "target": "packages/model/src/kernelBridge/createSubShapeReference.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/createSubShapeReference.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/kernelBridge/referenceResolution.js",
    "target": "packages/model/src/kernelBridge/referenceResolution.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/kernelBridge/referenceResolution.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/part/createPartDocument.js",
    "target": "packages/model/src/part/createPartDocument.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/createPartDocument.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/part/types.js",
    "target": "packages/model/src/part/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/semantic-origin-reopen.spec.ts",
    "specifier": "../../packages/model/src/sketch/createSketchDocument.js",
    "target": "packages/model/src/sketch/createSketchDocument.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/sketch/createSketchDocument.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-configuration.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-hole-table.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-metal.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-performance.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-performance.spec.ts",
    "specifier": "../../packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js",
    "target": "packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-performance.spec.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheet-profile.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/model/src/parameters/types.js",
    "target": "packages/model/src/parameters/types.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/parameters/types.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/model/src/part/configurations.js",
    "target": "packages/model/src/part/configurations.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/configurations.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/model/src/part/reevaluatePart.js",
    "target": "packages/model/src/part/reevaluatePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/reevaluatePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/model/src/part/resolvePart.js",
    "target": "packages/model/src/part/resolvePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/resolvePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetConfigurationFixture.ts",
    "specifier": "../../packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js",
    "target": "packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetDrawingFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetExportFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetHoleFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetHoleFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetHoleFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetProfileFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetProfileFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sheetProfileFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketch-corner-boundary.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/model/src/sketch/constraints/connected1000Fixture.testSupport.js",
    "target": "packages/model/src/sketch/constraints/connected1000Fixture.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/sketch/constraints/connected1000Fixture.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/test-utils/src/releasePerformance.js",
    "target": "packages/test-utils/src/releasePerformance.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/test-utils/src/releasePerformance.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/ui/src/viewport/sketchDragObservation.js",
    "target": "packages/ui/src/viewport/sketchDragObservation.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/viewport/sketchDragObservation.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/sketchConnected1000Flow.ts",
    "specifier": "../../packages/ui/src/viewport/sketchDragTiming.js",
    "target": "packages/ui/src/viewport/sketchDragTiming.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/viewport/sketchDragTiming.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/smoke.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-buckling-worker.spec.ts",
    "specifier": "../../packages/fem/src/assets.js",
    "target": "packages/fem/src/assets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/assets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-buckling-worker.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-buckling-worker.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-buckling-worker.spec.ts",
    "specifier": "../../packages/fem/src/solidBucklingModel.js",
    "target": "packages/fem/src/solidBucklingModel.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidBucklingModel.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-modal-worker.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-modal-worker.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-modal-worker.spec.ts",
    "specifier": "../../packages/fem/src/solidModalModel.js",
    "target": "packages/fem/src/solidModalModel.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidModalModel.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/assets.js",
    "target": "packages/fem/src/assets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/assets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/solidAnalysisModel.js",
    "target": "packages/fem/src/solidAnalysisModel.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidAnalysisModel.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/solidAnalysisTranslation.js",
    "target": "packages/fem/src/solidAnalysisTranslation.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidAnalysisTranslation.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/fem/src/solidYieldSummary.js",
    "target": "packages/fem/src/solidYieldSummary.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidYieldSummary.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solid-yield-worker.spec.ts",
    "specifier": "../../packages/model/src/analysis/analysisModel.js",
    "target": "packages/model/src/analysis/analysisModel.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/analysisModel.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteAuthoringFlow.ts",
    "specifier": "../../packages/ui/src/viewport/cameraMath.js",
    "target": "packages/ui/src/viewport/cameraMath.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/viewport/cameraMath.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/assets.js",
    "target": "packages/fem/src/assets.js",
    "count": 2,
    "reason": "Existing e2e dependency on packages/fem/src/assets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/cadSolidFinite.js",
    "target": "packages/fem/src/cadSolidFinite.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/cadSolidFinite.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/cadTetraMesh.js",
    "target": "packages/fem/src/cadTetraMesh.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/cadTetraMesh.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/client.js",
    "target": "packages/fem/src/client.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/client.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/protocol.js",
    "target": "packages/fem/src/protocol.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/protocol.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/solidFiniteAssets.js",
    "target": "packages/fem/src/solidFiniteAssets.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidFiniteAssets.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/fem/src/solidFiniteTranslation.js",
    "target": "packages/fem/src/solidFiniteTranslation.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/fem/src/solidFiniteTranslation.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/kernel/src/worker/kernelApi.js",
    "target": "packages/kernel/src/worker/kernelApi.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/kernel/src/worker/kernelApi.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/solidFiniteWorkerFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 2,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendFlow.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendFlow.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendStockFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelBendStockFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelEditableStockFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelEditableStockFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelEditableStockFlow.ts",
    "specifier": "../../packages/model/src/part/recomputePart.js",
    "target": "packages/model/src/part/recomputePart.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/part/recomputePart.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/steelEditableStockFlow.ts",
    "specifier": "../../packages/model/src/testing/createNativeKernelBridge.node.js",
    "target": "packages/model/src/testing/createNativeKernelBridge.node.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/testing/createNativeKernelBridge.node.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/surfaceFixture.ts",
    "specifier": "../../packages/expression/src/index.js",
    "target": "packages/expression/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/expression/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/surfaceFixture.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/surfaceFixture.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/surfacesFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/templateCaptureFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/templateCaptureFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/templateToolDefaultsFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/templateToolDefaultsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/toolDefaultsSettingsFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/tutorialFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/usabilityKeyboardFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/usabilityKeyboardFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/viewcube.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/viewcube.spec.ts",
    "specifier": "../../packages/ui/src/viewcube/viewCubeCamera.js",
    "target": "packages/ui/src/viewcube/viewCubeCamera.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/ui/src/viewcube/viewCubeCamera.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weld-layer-browser.spec.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weld-layer-browser.spec.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.js",
    "target": "packages/model/src/analysis/beamInputs.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weld-layer-browser.spec.ts",
    "specifier": "../../packages/model/src/analysis/beamInputs.testSupport.js",
    "target": "packages/model/src/analysis/beamInputs.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/beamInputs.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weld-layer-browser.spec.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weldSpanAuthorFlow.ts",
    "specifier": "../../packages/io/src/index.js",
    "target": "packages/io/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/io/src/index.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weldSpanAuthorFlow.ts",
    "specifier": "../../packages/model/src/analysis/cadWeldSpanLayer.testSupport.js",
    "target": "packages/model/src/analysis/cadWeldSpanLayer.testSupport.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/cadWeldSpanLayer.testSupport.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weldSpanAuthorFlow.ts",
    "specifier": "../../packages/model/src/analysis/weldSpanInput.js",
    "target": "packages/model/src/analysis/weldSpanInput.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/analysis/weldSpanInput.js; retained as a specific migration baseline."
  },
  {
    "consumer": "e2e/tests/weldSpanAuthorFlow.ts",
    "specifier": "../../packages/model/src/index.js",
    "target": "packages/model/src/index.js",
    "count": 1,
    "reason": "Existing e2e dependency on packages/model/src/index.js; retained as a specific migration baseline."
  }
] as const;
