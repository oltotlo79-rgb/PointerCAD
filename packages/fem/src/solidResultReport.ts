import type { SolidAnalysisInput, SolidAnalysisResult } from './solidAnalysisModel.js';
import { solidInputSha256, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { solidResultMatches } from './solidAnalysisResults.js';

/** Output only. Reuses all numerical acceptance checks; introduces no rounding or new physical criteria. */
export async function solidResultReportRows(value: SolidAnalysisInput, result: SolidAnalysisResult): Promise<(string | number)[][]> {
  // Own both inputs before the digest await: later edits cannot mix two revisions in one report.
  const input = translateSolidAnalysis(value).input;
  const captured = structuredClone(result);
  const hash = await solidInputSha256(input);
  if (!solidResultMatches(captured, input, hash)) throw new Error('solid-report: result does not match input');
  const rows: (string | number)[][] = [['record', 'index', 'field', 'value']];
  const add = (record: string, index: number | string, field: string, data: string | number): void => {
    rows.push([record, index, field, data]);
  };
  for (const [field, data] of Object.entries({ schema: 'pointercad-solid-result-report/1', coordinates: 'global-XYZ-undeformed',
    units: 'N-mm-MPa', indexBase: 0, tensorOrder: 'xx,yy,zz,yz,xz,xy', shearStrain: 'engineering',
    structuralCertification: 'false', inputSha256: hash, method: captured.method })) add('metadata', '', field, data);
  add('input', '', 'json', JSON.stringify(input));
  // Fixed key order and the original native element actions allow independent replay of acceptance.
  const ordered: SolidAnalysisResult = { kind: captured.kind, source: input.source, inputSha256: hash,
    method: captured.method, units: captured.units, structuralCertification: false,
    displacementMm: captured.displacementMm, reactionN: captured.reactionN,
    ...(captured.reactionsN === undefined ? {} : { reactionsN: captured.reactionsN }),
    elements: captured.elements.map(element => ({ strain: element.strain, stressMPa: element.stressMPa })),
    strainEnergyNmm: captured.strainEnergyNmm, maximumRelativeEquilibriumResidual: captured.maximumRelativeEquilibriumResidual,
    reservedNumericBytes: captured.reservedNumericBytes, nativeElementForcesN: captured.nativeElementForcesN,
    minimumScaledPivot: captured.minimumScaledPivot };
  add('result', '', 'json', JSON.stringify(ordered));
  const axes = ['x', 'y', 'z'];
  input.nodes.forEach((node, index) => {
    axes.forEach((axis, component) => {
      add('node', index, `${axis}_mm`, node[component]);
      add('node', index, `u${axis}_mm`, captured.displacementMm[index][component]);
      add('node', index, `reaction_${axis}_N`, captured.reactionN[index][component]);
    });
  });
  const components = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
  input.elements.forEach((element, index) => {
    add('element', index, 'materialId', element.materialId);
    element.nodes.forEach((node, local) => add('element', index, `node${local}`, node));
    components.forEach((component, position) => {
      add('element', index, `stress_${component}_MPa`, captured.elements[index].stressMPa[position]);
      add('element', index, `strain_${component}`, captured.elements[index].strain[position]);
    });
  });
  add('summary', '', 'strainEnergy_Nmm', captured.strainEnergyNmm);
  add('summary', '', 'maximumRelativeEquilibriumResidual', captured.maximumRelativeEquilibriumResidual);
  return rows;
}
