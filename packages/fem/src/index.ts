export { FemClient, type FemWorkerPort, type FemCompletion, type FemOptions, type TetraMeshQualityCompletion, type SolidFatigueAnalysis, type SolidFatigueCompletion } from './client.js';
export { createProductFemWorker } from './productWorker.js';
export type { FemPhase } from './protocol.js';
export { meshCadBoundary, prepareCadTetraMesh, type CadTetraContext, type CadTetraRegion, type CadTetraOutcome } from './cadTetraMesh.js';
export { CURVED_CAD_TETRA_SCHEMA, CurvedRouteRefusal, meshCadCurvedBoundary, prepareCurvedCadTetraMesh,
  type CurvedCadTetraOptions, type CurvedCadTetraOutcome, type CurvedCadTetraVolume, type CurvedRouteRefusalCode } from './cadCurvedTetraMesh.js';
export { CURVED_PLC_BOUND_SCHEMA, CurvedPlcRefusal, boundCurvedPlc, type CurvedFaceBound, type CurvedPlcBound,
  type CurvedPlcRefusalCode, type CurvedSurface } from './curvedPlcBound.js';
export { TETRA_MESH_SCHEMA, TETRA_LIMITS, readTetraMeshInput, readTetraMeshingControls, tetraMeshInputSha256, decodeTetraMesh,
  type TetraMeshingControls, type TetraMeshSource, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';
export type { BeamAnalysisDocument, BeamAnalysisResult, BeamModalResult } from './analysisModel.js';
export type { BeamBucklingInput, BeamBucklingResult, BucklingRestraints } from './bucklingModel.js';
export { translateBeamBuckling, bucklingInputSha256 } from './bucklingTranslation.js';
export { decodeBeamBuckling, isBeamBucklingResult, bucklingResultMatches } from './bucklingResults.js';
export { standardMembersToBeamBuckling, type CadBucklingCheck } from './cadBuckling.js';
export type { BeamTransientInput, BeamTransientResult, TransientHistory, TransientLoadFactorSample,
  TransientNodeResponse, TransientSample } from './transientModel.js';
export { translateBeamTransient, transientInputSha256, transientLoadFactor, transientOutputSteps,
  TRANSIENT_MAXIMUM_STEPS, TRANSIENT_MAXIMUM_OUTPUT_SAMPLES, TRANSIENT_MAXIMUM_LOAD_SAMPLES,
  TRANSIENT_WORK_LIMIT } from './transientTranslation.js';
export { decodeBeamTransient, isBeamTransientResult, transientResultMatches } from './transientResults.js';
export { transientAxialMatches, transientAxialResponse, type TransientAxialExtreme, type TransientAxialResponse,
  type TransientMemberAxial } from './transientAxial.js';
export { standardMembersToBeamTransient, type CadTransientCheck } from './cadTransient.js';
export { PLASTIC_BAR_LIMITS, PLASTIC_BAR_PLAN_SCHEMA, plasticBarSchedule, readPlasticBarPlan, type PlasticBarMaterial,
  type PlasticBarPlan, type PlasticBarSample } from './plasticBar.js';
export { PLASTIC_BAR_INPUT_SCHEMA, plasticBarInputSha256, translatePlasticBar, type PlasticBarInput,
  type PlasticBarSource } from './plasticBarTranslation.js';
export { decodePlasticBar, isPlasticBarResult, plasticBarResultMatches, PLASTIC_BAR_TOLERANCES,
  type PlasticBarDeviation, type PlasticBarNativeSample, type PlasticBarResult } from './plasticBarResults.js';
export { CONTACT_RESULT_TOLERANCE, MAX_BEAM_CONTACTS, MAX_CONTACT_GAP_M, MAX_CONTACT_LOAD_FACTORS, contactPivotLimit,
  validateBeamContacts, type BeamContactDefinition, type BeamContactInput, type BeamContactResult,
  type ContactLoadState, type ContactNodeDisplacement, type ContactStateOfPair, type ContactValidation,
  type ContactValidationCode } from './contactModel.js';
export { contactInputSha256, translateBeamContact, type OofemContactPlan } from './contactTranslation.js';
export { contactResultMatches, decodeBeamContact, isBeamContactResult, type BeamContactAnalysisResult } from './contactResults.js';
export { FATIGUE_INPUT_SCHEMA, FATIGUE_RESULT_SCHEMA, MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS,
  MAX_FATIGUE_STRESS_MPA, validateFatigueInput, readFatigueSnCurve, type FatigueAnalysis, type FatigueCycle, type FatigueError, type FatigueErrorCode,
  type FatigueHistoryResult, type FatigueInput, type FatigueLife, type FatigueMeanStressAssumption, type FatigueResult,
  type FatigueSequence, type FatigueSnCurve, type FatigueSource, type FatigueStressDefinition, type FatigueStressHistory,
  type FatigueValidation } from './fatigueModel.js';
export { analyzeFatigue, curveStressMpa, rainflowCycles } from './fatigue.js';
export { analyzeFatigueWithMeanStressCorrection } from './fatigue.js';
export { FATIGUE_PIECEWISE_CONTINUITY_TOLERANCE, FATIGUE_PIECEWISE_INPUT_SCHEMA, FATIGUE_PIECEWISE_RESULT_SCHEMA, MAX_FATIGUE_PIECEWISE_SEGMENTS, analyzeFatiguePiecewise, piecewiseEndStressMpa, piecewiseInverseLife, validateFatiguePiecewiseInput, type FatiguePiecewiseAnalysis, type FatiguePiecewiseApplicability, type FatiguePiecewiseCurve, type FatiguePiecewiseEnd, type FatiguePiecewiseError, type FatiguePiecewiseErrorCode, type FatiguePiecewiseInput, type FatiguePiecewiseResult, type FatiguePiecewiseSegment, type FatiguePiecewiseValidation } from './fatiguePiecewise.js';
export { FATIGUE_PROPORTIONAL_TENSOR_METHOD, FATIGUE_PROPORTIONAL_TENSOR_SCHEMA, FATIGUE_TENSOR_COMPONENT_KEYS, FATIGUE_TENSOR_COMPONENTS, analyzeProportionalTensorFatigue, proportionalTensorFatigueInput, validateProportionalTensorFatigueInput, type FatigueReferenceTensor, type FatigueTensorAnalysis, type FatigueTensorComponent, type FatigueTensorConversion, type FatigueTensorConversionResult, type FatigueTensorError, type FatigueTensorErrorCode } from './fatigueTensor.js';
export { FATIGUE_GOODMAN_SCHEMA, FATIGUE_CORRECTED_RESULT_SCHEMA, GOODMAN_MINIMUM_CYCLES_EXCLUSIVE,
  validateFatigueMeanStressCorrection, type FatigueMeanStressCorrection, type FatigueCorrectionError,
  type FatigueCorrectionErrorCode, type FatigueCorrectionValidation, type FatigueCorrectedAnalysis,
  type FatigueCorrectedHistoryResult, type FatigueCorrectedResult } from './fatigueModel.js';
export { AXIAL_FATIGUE_MEASURE, PASCALS_PER_MEGAPASCAL, axialFatigueHistory, type AxialFatigueError,
  type AxialFatigueErrorCode, type AxialFatigueHistory, type AxialFatigueProvenance, type AxialFatigueSelection
} from './fatigueAxial.js';
export { SOLID_FATIGUE_MEASURE, readSolidFatigueSelection, solidFatigueInput, type SolidFatigueSelection,
  type SolidFatigueProvenance, type SolidFatigueTensorInput, type SolidFatigueError, type SolidFatigueAdaptation } from './fatigueSolid.js';
export { STRAIN_LIFE_INPUT_SCHEMA, STRAIN_LIFE_RESULT_SCHEMA, analyzeStrainLife, strainLifeAmplitudeAt, validateStrainLifeInput, type StrainLifeAnalysis, type StrainLifeError, type StrainLifeErrorCode, type StrainLifeInput, type StrainLifeResult } from './fatigueStrainLife.js';
export { MAX_STRAIN_HISTORY_ABS_STRAIN, STRAIN_HISTORY_INPUT_SCHEMA, STRAIN_HISTORY_RESULT_SCHEMA, analyzeStrainHistory,
  validateStrainHistoryInput, type StrainHistory, type StrainHistoryAnalysis, type StrainHistoryCycle, type StrainHistoryError,
  type StrainHistoryErrorCode, type StrainHistoryInput, type StrainHistoryLife, type StrainHistoryResult,
  type StrainHistoryResultEntry, type StrainHistoryValidation } from './fatigueStrainHistory.js';
export { STRAIN_STRESS_HISTORY_INPUT_SCHEMA, STRAIN_STRESS_HISTORY_RESULT_SCHEMA, analyzeStrainStressHistory, pairedReversalStress,
  validateStrainStressHistoryInput, type StrainStressHistory, type StrainStressHistoryAnalysis, type StrainStressHistoryCycle,
  type StrainStressHistoryError, type StrainStressHistoryErrorCode, type StrainStressHistoryInput, type StrainStressHistoryLife,
  type StrainStressHistoryResult, type StrainStressHistoryResultEntry, type StrainStressHistoryValidation,
  type StrainStressSample } from './fatigueStrainStressHistory.js';
export { LOCAL_CYCLE_INPUT_SCHEMA, LOCAL_CYCLE_MAX_ABS_STRAIN, LOCAL_CYCLE_RESULT_SCHEMA, analyzeLocalCycle, swtParameterAt, validateLocalCycleInput, type LocalCycle, type LocalCycleAnalysis, type LocalCycleCorrection, type LocalCycleError, type LocalCycleErrorCode, type LocalCycleInput, type LocalCycleResult, type LocalCycleValidation } from './fatigueLocalCycle.js';
export { CAD_SHELL_SURFACE_SCHEMA, CadShellSurfaceRefusal, prepareCadShellSurfaceMesh, requestCadShellSurfaceMesh,
  type CadShellSurfaceOptions, type CadShellSurfaceMesh, type CadShellSurfaceOutcome } from './cadShellSurfaceMesh.js';
export { diagnoseTetraMeshQuality, readTetraMeshQualityLimits, type TetraMeshQualityLimits,
  type TetraMeshQuality, type TetrahedronQuality } from './tetraMeshQuality.js';
export { meshAssemblyTetrahedra, selectAssemblyTetraBoundary, type AssemblyTetraPart, type AssemblyTetraContext, type AssemblyTetraBudget,
  type AssemblyTetraRegions, type AssemblyTetraBoundarySelection, type AssemblyTetraOccurrence,
  type AssemblyTetraMesh, type AssemblyTetraOutcome } from './assemblyTetraMesh.js';
export { meshCadAssemblyTetrahedra, type CadAssemblyTetraPart, type CadAssemblyTetraContext, type CadAssemblyTetraOutcome } from './cadAssemblyTetraMesh.js';
export type { SolidAnalysisInput, SolidAnalysisPlan, SolidAnalysisResult, SolidSource, SolidMaterial,
  SolidTet4, SolidVector3, SolidVector6, SolidElementResult } from './solidAnalysisModel.js';
export { SOLID_LIMITS, translateSolidAnalysis, solidInputSha256 } from './solidAnalysisTranslation.js';
export { decodeSolidAnalysis, SOLID_METHOD } from './solidAnalysisResults.js';
export type { SolidModalInput, SolidModalMaterial, SolidModalPlan, SolidModalMode, SolidModalResult,
  SolidModalApplicability } from './solidModalModel.js';
export { SOLID_MODAL_LIMITS, solidModalReservedBytes, translateSolidModal, solidModalInputSha256 } from './solidModalTranslation.js';
export { decodeSolidModal, SOLID_MODAL_METHOD } from './solidModalResults.js';
export { isSolidModalResult, solidModalResultMatches } from './solidModalPublicResult.js';
export type { SolidBucklingInput, SolidBucklingPlan, SolidBucklingMode, SolidBucklingResult } from './solidBucklingModel.js';
export { SOLID_BUCKLING_MAX_MODES, translateSolidBuckling, solidBucklingInputSha256 } from './solidBucklingTranslation.js';
export { decodeSolidBuckling, SOLID_BUCKLING_METHOD } from './solidBucklingResults.js';
export { isSolidBucklingResult, solidBucklingResultMatches } from './solidBucklingPublicResult.js';
export { analyzeCadSolid, prepareCadSolidAnalysis, type CadSolidSettings, type CadSolidPressureSettings,
  type CadSolidPrepared, type CadSolidOutcome } from './cadSolidAnalysis.js';
export { analyzeCadSolidPlastic, cadSolidPlasticInput, type CadSolidPlasticSettings,
  type CadSolidPlasticOutcome } from './cadSolidPlastic.js';
export { SOLID_PLASTIC_PLAN_SCHEMA, SOLID_PLASTIC_LIMITS, readSolidPlasticPlan,
  type SolidPlasticPlan, type SolidPlasticMaterial, type SolidPlasticDof } from './solidPlastic.js';
export { SOLID_PLASTIC_INPUT_SCHEMA, translateSolidPlastic, solidPlasticInputSha256,
  type SolidPlasticInput, type SolidPlasticSource } from './solidPlasticTranslation.js';
export { SOLID_PLASTIC_METHOD, SOLID_PLASTIC_SCOPE, SOLID_PLASTIC_RESIDUAL_BOUND,
  type SolidPlasticRecord, type SolidPlasticElementState } from './solidPlasticResults.js';
export { decodeSolidPlastic, isSolidPlasticResult, solidPlasticResultMatches,
  type SolidPlasticResult } from './solidPlasticPublicResult.js';
export { translateBeamBoltContact, beamBoltContactInputSha256, decodeBeamBoltContact,
  type AxialBoltDefinition, type AxialBoltPlan, type AxialBoltForce, type BeamBoltContactInput,
  type BeamBoltContactPlan, type BeamBoltContactResult } from './beamBoltContact.js';
export { analyzeBeamBoltContact } from './beamBoltContactRuntime.js';
export { prepareCadBeamBoltContact } from './cadBeamBoltContact.js';
export { translateBeamWeldContact, beamWeldContactInputSha256, decodeBeamWeldContact,
  type WeldLayerGeometry, type WeldLayerDefinition, type WeldLayerPlan, type WeldLayerWrench,
  type BeamWeldContactInput, type BeamWeldContactPlan, type BeamWeldContactResult } from './beamWeldContact.js';
export { analyzeBeamWeldContact } from './beamWeldContactRuntime.js';

export { prepareCadBeamWeldContact } from './cadBeamWeldContact.js';
export { translateBeamJointContact, beamJointContactInputSha256, decodeBeamJointContact,
  type BeamJointContactInput, type BeamJointContactPlan, type BeamJointContactResult } from './beamJointContact.js';
export { analyzeBeamJointContact } from './beamJointContactRuntime.js';
export { prepareCadBeamJointContact } from './cadBeamJointContact.js';
export { translateBeamJointInitialStrain, beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain,
  type BeamJointInitialStrainInput, type BeamJointInitialStrainPlan, type BeamJointInitialStrainResult,
  type InitialStrainBoltForce, type ShankShortening } from './beamJointInitialStrain.js';
export { analyzeBeamJointInitialStrain } from './beamJointInitialStrainRuntime.js';
export { calculateBoltPreloadStages, type BoltPreloadDeclaration, type BoltPreloadState } from './boltPreloadStages.js';
export { prepareCadBeamJointInitialStrain } from './cadBeamJointInitialStrain.js';
export { translateBeamImpact, impactInputSha256, impactRefinementMap, type OofemImpactPlan } from './beamImpactTranslation.js';
export { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
export { analyzeBeamImpact } from './beamImpactRuntime.js';
export { BEAM_IMPACT_SCOPE, type BeamImpactInput, type BeamImpactResult, type BeamImpactContact,
  type BeamImpactInitialVelocity, type BeamImpactHistory, type BeamImpactSample } from './beamImpactModel.js';
export { IMPACT_MEMBER_UNASSESSED, impactMemberResponse, impactMemberResponseMatches, type ImpactMemberExtreme,
  type ImpactMemberResponse, type ImpactMemberResponseSet, type ImpactMemberSeries } from './beamImpactMemberResponse.js';
export { decodeImpactInterior, impactElementEndForces, type BeamImpactElement, type BeamImpactInterior,
  type BeamImpactMeshNode, type ImpactElementEndForces, type SectionResultants } from './beamImpactInterior.js';
export { checkFibreSection, compareWithYield, elementFibreStresses, fibreExtremes, fibreStress, type AnalysedSection,
  type BeamFibreSection, type ElementFibreStress, type FibreExtreme, type FibreSectionCheck, type SourcedYield,
  type YieldComparison } from './beamFibreStress.js';

// Internal numeric entry only; CAD persistence and UI remain separate, unimplemented integration.
export type { NativeBoltPreloadPlan, NativeBoltPreloadResult } from './nativeBoltPreload.js';
export type { NativeBoltPreloadWireInput, NativeBoltPreloadOwnedResult } from './nativeBoltPreloadBinding.js';
export { prepareCadNativeBoltPreload, type CadNativeBoltPreloadInput } from './cadNativeBoltPreload.js';

export { recoverWeldThroatStress, recoverJointWeldThroatStress, recoverInitialStrainWeldThroatStress } from './weldThroatStress.js';

export { analyzeFrameBoltContact } from './frameBoltContactRuntime.js';
export { isFrameBoltContactResult, frameBoltContactResultMatches, type FrameBoltContactResult } from './frameBoltContactBinding.js';
export type { FrameBoltContactInput } from './beamBoltContact.js';
