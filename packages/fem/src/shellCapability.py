"""Test-only observations of the bundled OOFEM shell API, not a product solver."""
import json
from importlib.metadata import version


def _missing_attribute(owner, attribute):
    """Record the actual public lookup failure, not a guessed binding name."""
    try:
        getattr(owner, attribute)
    except AttributeError as error:
        return str(error)
    raise AssertionError(f'Public API changed: {attribute} is now exposed; requalify it')


def _specimen(np, fem, thickness):
    result = {'inputThicknessMm': thickness}
    lines = ['/pcad_fem/shell-capability.out', 'One triangle; N mm MPa',
             'LinearStatic nsteps 1 nmodules 0', 'domain 3dshell', 'OutputManager',
             'ndofman 3 nelem 1 ncrosssect 1 nmat 1 nbc 2 nltf 1 nic 0',
             'node 1 coords 3 0 0 0 bc 6 1 1 1 1 1 1',
             'node 2 coords 3 10 0 0 bc 6 1 1 1 1 1 1',
             'node 3 coords 3 0 10 0 load 1 2',
             'tr_shell02 1 nodes 3 1 2 3 mat 1 crosssect 1 nip 4',
             f'SimpleCS 1 thick {thickness} material 1',
             'IsoLE 1 d 0 E 205000 n 0.3 tAlpha 0',
             'BoundaryCondition 1 loadTimeFunction 1 prescribedValue 0',
             'NodalLoad 2 loadTimeFunction 1 components 6 100 0 -100 10 20 30',
             'ConstantFunction 1 f(t) 1', '']
    with open('/pcad_fem/shell-capability.in', 'w', encoding='utf-8') as stream:
        stream.write(chr(10).join(lines))
    problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader('/pcad_fem/shell-capability.in'),
                                    fem.problemMode.processor, 0, None, False)
    if problem is None or problem.checkProblemConsistency() != 1:
        raise RuntimeError('shell-capability: inconsistent model')
    try:
        problem.solveYourself()
        step = problem.giveCurrentStep(False)
        domain = problem.giveDomain(1)
        element = domain.giveElement(1)
        result['elementClass'] = element.giveClassName()
        assert element.giveNumberOfNodes() == 3
        assert element.giveCrossSection().giveClassName() == 'SimpleCrossSection'
        dofs = [fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w,
                fem.DofIDItem.R_u, fem.DofIDItem.R_v, fem.DofIDItem.R_w]
        result['nodeDofs'] = [domain.giveDofManager(i).giveNumberOfDofs() for i in range(1, 4)]
        result['dofMasks'] = []
        for i in range(1, 4):
            mask = fem.IntArray()
            element.giveDofManDofIDMask(i, mask)
            result['dofMasks'].append(list(mask))
            assert element.giveDofManagerNumber(i) == i
            assert [int(domain.giveDofManager(i).giveDofWithID(dof).giveDofID()) for dof in dofs] == list(mask)
        result['displacements'] = [[domain.giveDofManager(i).giveDofWithID(dof).giveUnknown(
            fem.ValueModeType.VM_Total, step) for dof in dofs] for i in range(1, 4)]
        matrix = fem.FloatMatrix()
        element.giveCharacteristicMatrix(matrix, fem.CharType.TangentStiffnessMatrix, step)
        stiffness = np.array([[matrix[i, j] for j in range(18)] for i in range(18)])
        assert np.isfinite(stiffness).all()
        matrix_norm = float(np.linalg.norm(stiffness))
        assert matrix_norm > 0
        result['stiffnessSymmetryRelative'] = float(np.linalg.norm(stiffness - stiffness.T)) / matrix_norm
        displacement = np.array(result['displacements']).reshape(-1)
        assert np.isfinite(displacement).all()
        load = np.zeros(18)
        load[12:] = [100, 0, -100, 10, 20, 30]
        result['loadedEnergyNmm'] = float(displacement @ stiffness @ displacement / 2)
        result['halfLoadWorkNmm'] = float(displacement @ load / 2)
        assert result['loadedEnergyNmm'] > 0 and result['halfLoadWorkNmm'] > 0
        result['freeEquilibriumRelative'] = float(np.linalg.norm((stiffness @ displacement - load)[12:]) / np.linalg.norm(load))
        result['rigidEnergiesNmm'] = []
        result['rigidResidualsRelative'] = []
        points = np.array([[0., 0., 0.], [10., 0., 0.], [0., 10., 0.]])
        # Linearized rigid generators: translations of 1 mm; rotations of 1 rad
        # with u = omega x x and nodal theta = omega. Not a finite-rotation test.
        for axis in range(6):
            vector = np.zeros((3, 6))
            if axis < 3:
                vector[:, axis] = 1
            else:
                rotation = np.eye(3)[axis - 3]
                vector[:, :3] = np.cross(rotation, points)
                vector[:, 3:] = rotation
            flat = vector.reshape(-1)
            result['rigidEnergiesNmm'].append(float(flat @ stiffness @ flat / 2))
            result['rigidResidualsRelative'].append(float(np.linalg.norm(stiffness @ flat) / (matrix_norm * np.linalg.norm(flat))))
        result['rigidEnergyRatios'] = [abs(energy) / result['loadedEnergyNmm'] for energy in result['rigidEnergiesNmm']]
        rule = element.giveDefaultIntegrationRulePtr()
        result['integrationPointCount'] = rule.giveNumberOfIntegrationPoints()
        point = rule.getIntegrationPoint(0)
        result['missingBindings'] = {
            'CrossSection.give': _missing_attribute(element.giveCrossSection(), 'give'),
            'CrossSectionProperty': _missing_attribute(fem, 'CrossSectionProperty'),
            'CS_Thickness': _missing_attribute(fem, 'CS_Thickness'),
            'Element.giveRotationMatrix': _missing_attribute(element, 'giveRotationMatrix'),
            'GaussPoint.giveNaturalCoordinates': _missing_attribute(point, 'giveNaturalCoordinates'),
            'GaussPoint.giveWeight': _missing_attribute(point, 'giveWeight'),
            'GaussPoint.giveMaterialMode': _missing_attribute(point, 'giveMaterialMode'),
            'GaussPoint.giveSlaveGaussPoint': _missing_attribute(point, 'giveSlaveGaussPoint'),
            'GaussPoint.giveSlaveGaussPoints': _missing_attribute(point, 'giveSlaveGaussPoints'),
        }
        result['integrationPoints'] = []
        for index in range(result['integrationPointCount']):
            point = rule.getIntegrationPoint(index)
            row = {'globalCoordinatesMm': list(point.giveGlobalCoordinates()), 'values': {}}
            for name in ['IST_StressTensor', 'IST_StressTensor_Reduced', 'IST_ShellForceTensor', 'IST_ShellMomentTensor', 'IST_ShellStrainTensor', 'IST_CurvatureTensor']:
                value = fem.FloatArray()
                status = element.giveIPValue(value, point, getattr(fem.InternalStateType, name), step)
                assert status == 1 and np.isfinite(list(value)).all()
                row['values'][name] = list(value)
            cauchy = fem.FloatArray()
            row['cauchyStressStatus'] = element.giveIPValue(cauchy, point, fem.InternalStateType.IST_CauchyStressTensor, step)
            row['cauchyStressValues'] = list(cauchy)
            result['integrationPoints'].append(row)
        return result, stiffness
    finally:
        problem.terminateAnalysis()


def probe_shell_capability():
    import numpy as np
    import oofem as fem
    import pyodide

    assert __debug__, 'Python assertions must be enabled'
    assert version('oofem') == '3.1.dev5+g214b161ed'
    assert np.__version__ == '2.2.5' and pyodide.__version__ == '0.29.3'
    registered = fem.getClassFactory().getRegisteredNames()['Element']
    # These input-record names were located in the pinned source archive. The
    # live factory confirms registration only; only tr_shell02 is solved here.
    candidates = ['dktplate', 'dktplate3d', 'cctplate', 'cctplate3d', 'qdktplate', 'quad1mindlin',
                  'tr_shell01', 'tr_shell02', 'tr_shell11', 'rershell', 'mitc4shell', 'quad1mindlinshell3d', 'tr2shell7']
    assert all(name in registered for name in candidates)
    thin, k1 = _specimen(np, fem, 1.0)
    thick, k2 = _specimen(np, fem, 2.0)
    membrane = [0, 1, 5, 6, 7, 11, 12, 13, 17]
    bending = [2, 3, 4, 8, 9, 10, 14, 15, 16]
    scaling = {}
    # Independent linear-elastic thickness laws: membrane proportional to t,
    # DKT bending proportional to t^3, not a read-back of the supplied number.
    for name, indices, expected in [('membrane', membrane, 2), ('bending', bending, 8)]:
        a, b = k1[np.ix_(indices, indices)], k2[np.ix_(indices, indices)]
        scaling[name] = {'expectedFactor': expected, 'measuredNormRatio': float(np.linalg.norm(b) / np.linalg.norm(a)),
                         'relativeError': float(np.linalg.norm(b - expected * a) / np.linalg.norm(expected * a))}
    return json.dumps({'oofemVersion': version('oofem'), 'numpyVersion': np.__version__,
                       'pyodideVersion': pyodide.__version__, 'registeredCandidates': candidates,
                       'specimens': [thin, thick], 'thicknessScaling': scaling}, allow_nan=False)
