"""Linear prestress (bifurcation) buckling of an existing tet4 solid, N-mm-MPa; OOFEM214b161 ltrspace/IsoLE.

Successor of task159 r159 solidBuckling.py (cc1b5042): the native path now exists. Source evidence (pinned archive
4688f06a, extracted to scratchpad/claude/inspections/v103-prestress-native-source-r159):
- Structural3DElement::computeInitialStressMatrix (structural3delement.C:116-187, override in .h:85) integrates
  BH^T M BH dV with M_(ij)(kl) = delta_ik sigma_jl and sigma from giveIPValue(IST_StressTensor); LTRSpace derives from
  Structural3DElement. Every one of the 27 nonzero M entries was checked against delta_ik sigma_jl.
- The source marks it OOFEM_WARNING("Implementation not tested yet!"); error.h:79-80 makes OOFEM_ERROR a thrown
  RuntimeException and OOFEM_WARNING a log line unless warningIsError. Therefore every native element K_g is accepted
  only when it equals the independent closed form V (g_a^T S g_b) delta_ij of the independently recomputed stress
  S = D B u within 1e-8, and the native stress itself must equal D B u within 1e-8.
Lifecycle as the validated solidPlasticAnalysis.py (metastep, preInitializeNextStep, initializeYourself,
solveYourselfAt, updateYourself, giveIPValue on integration point 0); deck as solidAnalysis.py plus NodalLoad/Set records
as solidPlasticAnalysis.py. Contract: (K + lambda Kg) phi = 0 on the free DOFs; lambda > 0 multiplies the whole
reference load set. Tension-only, stress-free, mechanism and numerically unresolved states are refused.
"""
import json
import math
from importlib.metadata import version

MAX_FREE_DOFS = 1200
DECK = '/pcad_fem/solid-buckling.in'
OUT = '/pcad_fem/solid-buckling.out'


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('solid-buckling-numeric: finite number required')
    return float(value)


def tet4_initial_stress(np, points, stress):
    """Kg[3a+i][3b+j] = V (g_a^T S g_b) delta_ij for constant gradients g_a and constant Cauchy stress S.

    stress is Voigt xx, yy, zz, yz, xz, xy in MPa; points are four mm coordinates in positive orientation."""
    points = np.asarray(points, dtype=float)
    edges = points[1:] - points[0]
    determinant = float(np.linalg.det(edges))
    if not math.isfinite(determinant) or determinant <= 0:
        raise ValueError('solid-buckling-geometry: non-positive tetrahedron volume')
    inverse = np.linalg.inv(edges)
    gradients = np.vstack([-inverse.sum(axis=1), inverse.T])
    xx, yy, zz, yz, xz, xy = (float(v) for v in stress)
    tensor = np.array([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]])
    scalar = gradients @ tensor @ gradients.T
    return np.kron(scalar * (determinant / 6.0), np.eye(3))


def tet4_stress(np, points, displacement, young, poisson):
    """Cauchy stress D B u (Voigt xx, yy, zz, yz, xz, xy, engineering shear) of a linear isotropic tet4."""
    points = np.asarray(points, dtype=float)
    inverse = np.linalg.inv(points[1:] - points[0])
    gradients = np.vstack([-inverse.sum(axis=1), inverse.T])
    grad = np.asarray(displacement, dtype=float).T @ gradients  # grad[i][j] = d u_i / d x_j
    strain = [grad[0, 0], grad[1, 1], grad[2, 2], grad[1, 2] + grad[2, 1], grad[0, 2] + grad[2, 0], grad[0, 1] + grad[1, 0]]
    mu = young / (2 * (1 + poisson))
    lame = young * poisson / ((1 + poisson) * (1 - 2 * poisson))
    trace = strain[0] + strain[1] + strain[2]
    return [2 * mu * strain[0] + lame * trace, 2 * mu * strain[1] + lame * trace, 2 * mu * strain[2] + lame * trace,
            mu * strain[3], mu * strain[4], mu * strain[5]]


def solve_buckling(np, stiffness, geometric, mode_count, node_count, free):
    """Lowest positive load factors of (K + lambda Kg) phi = 0 on the free DOFs.

    K must be symmetric positive definite (Cholesky K = C C^T); A = C^-1 (-Kg) C^-T is symmetric with eigenvalues
    mu, and every positive mu gives lambda = 1/mu. Shapes are expanded to all nodes (prescribed DOFs exactly 0) and
    scaled so that the largest nodal translation norm is 1."""
    stiffness = np.asarray(stiffness, dtype=float)
    geometric = np.asarray(geometric, dtype=float)
    size = stiffness.shape[0]
    if stiffness.shape != (size, size) or geometric.shape != (size, size) or len(free) != size or size < mode_count:
        raise ValueError('solid-buckling-supports: inconsistent reduced system')
    for label, matrix in (('stiffness', stiffness), ('initial-stress', geometric)):
        norm = float(np.linalg.norm(matrix))
        if not np.isfinite(matrix).all() or (label == 'stiffness' and norm <= 0) \
                or np.linalg.norm(matrix - matrix.T) > max(norm, 1e-300) * 1e-11:
            raise ValueError(f'solid-buckling-numeric: invalid {label} matrix')
    stiffness = (stiffness + stiffness.T) / 2
    geometric = (geometric + geometric.T) / 2
    if not float(np.linalg.norm(geometric)) > 0:
        raise ValueError('solid-buckling-no-positive-mode: the reference state is stress-free')
    try:
        factor = np.linalg.cholesky(stiffness)
    except np.linalg.LinAlgError as error:
        raise ValueError('solid-buckling-mechanism: reduced stiffness is not positive definite') from error
    if float(np.min(np.diag(factor))) ** 2 <= float(np.max(np.diag(stiffness))) * 1e-12:
        raise ValueError('solid-buckling-mechanism: reduced stiffness is numerically singular')
    left = np.linalg.solve(factor, -geometric)
    reduced = np.linalg.solve(factor, left.T).T
    reduced = (reduced + reduced.T) / 2
    values, vectors = np.linalg.eigh(reduced)
    threshold = float(np.max(np.abs(values))) * 1e-10
    order = [i for i in np.argsort(values)[::-1] if values[i] > threshold]
    if len(order) < mode_count:
        raise ValueError(f'solid-buckling-no-positive-mode: {len(order)} positive load factor(s) for '
                         f'{mode_count} requested; tension or insufficient compression in the reference state')
    modes = []
    for number, index in enumerate(order[:mode_count], 1):
        load_factor = float(1.0 / values[index])
        reduced_shape = np.linalg.solve(factor.T, vectors[:, index])
        full = np.zeros(3 * node_count)
        full[np.asarray(free, dtype=int)] = reduced_shape
        nodal = full.reshape((node_count, 3))
        amplitude = float(np.max(np.linalg.norm(nodal, axis=1)))
        if not math.isfinite(amplitude) or amplitude <= 0:
            raise ValueError('solid-buckling-numeric: degenerate mode shape')
        nodal = nodal / amplitude
        phi = nodal.reshape(-1)[np.asarray(free, dtype=int)]
        residual = float(np.linalg.norm((stiffness + load_factor * geometric) @ phi)
                         / (np.linalg.norm(stiffness @ phi) + abs(load_factor) * np.linalg.norm(geometric @ phi)))
        if not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('solid-buckling-numeric: eigen residual exceeds 1e-8')
        modes.append({'number': number, 'loadFactor': load_factor, 'normalizedResidual': residual,
                      'shape': [[0.0 if v == 0 else float(v) for v in row] for row in nodal.tolist()]})
    return modes


def solid_buckling_deck(plan):
    """LinearStatic deck of the reference state: solidAnalysis.py nodes/elements/IsoLE plus one NodalLoad per loaded node
    carrying only its free components (a load on a prescribed DOF produces no stress and enters the reaction)."""
    reference = plan['reference']
    data, fixed, forces = reference['input'], reference['fixed'], reference['forcesN']
    materials = {row['id']: i + 1 for i, row in enumerate(data['materials'])}
    loads = []
    for node, (force, flags) in enumerate(zip(forces, fixed, strict=True)):
        components = [(axis + 1, _finite(value)) for axis, value in enumerate(force) if value != 0 and not flags[axis]]
        if components:
            loads.append((node, components))
    if not loads:
        raise ValueError('solid-buckling-load: zero reference load on free degrees of freedom')
    lines = [OUT, 'PointerCAD tet4 prestress reference; coherent N, mm, MPa', 'LinearStatic nsteps 1 nmodules 0',
             'domain 3d', 'OutputManager',
             f"ndofman {len(data['nodes'])} nelem {len(data['elements'])} ncrosssect {len(materials)} nmat {len(materials)} "
             f"nbc {1 + len(loads)} nltf 1 nic 0 nset {len(loads)}"]
    for number, (point, flags) in enumerate(zip(data['nodes'], fixed, strict=True), 1):
        lines.append(f'node {number} coords 3 ' + ' '.join(repr(_finite(v)) for v in point)
                     + ' bc 3 ' + ' '.join('1' if v else '0' for v in flags))
    for number, element in enumerate(data['elements'], 1):
        material = materials[element['materialId']]
        lines.append(f'ltrspace {number} nodes 4 ' + ' '.join(str(i + 1) for i in element['nodes'])
                     + f' mat {material} crosssect {material}')
    for number in range(1, len(materials) + 1):
        lines.append(f'SimpleCS {number} material {number}')
    for number, material in enumerate(data['materials'], 1):
        lines.append(f"IsoLE {number} d 0 E {repr(_finite(material['youngMPa']))} "
                     f"n {repr(_finite(material['poisson']))} tAlpha 0.0")
    lines.append('BoundaryCondition 1 loadTimeFunction 1 prescribedValue 0.0')
    for index, (_, components) in enumerate(loads):
        lines.append(f'NodalLoad {index + 2} loadTimeFunction 1 dofs {len(components)} '
                     + ' '.join(str(dof) for dof, _ in components) + f' Components {len(components)} '
                     + ' '.join(repr(value) for _, value in components) + f' set {index + 1}')
    lines.append('PeakFunction 1 t 1.0 f(t) 1.0')
    lines += [f'Set {index + 1} nodes 1 {node + 1}' for index, (node, _) in enumerate(loads)]
    lines.append('')
    return '\n'.join(lines)


def _symmetric_native(np, fem, element, kind, step, label):
    native = fem.FloatMatrix()
    element.giveCharacteristicMatrix(native, kind, step)
    values = np.array([[_finite(native[i, j]) for j in range(12)] for i in range(12)])
    scale = float(np.max(np.abs(values)))
    if np.max(np.abs(values - values.T)) > max(scale, 1e-300) * 1e-11:
        raise ValueError(f'solid-buckling-native: invalid element {label} symmetry')
    return (values + values.T) / 2


def run_solid_buckling():
    import numpy as np
    import oofem as fem
    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('solid-buckling-native: unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/solid-buckling-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    reference = plan.get('reference', {})
    data = reference.get('input', {})
    if plan.get('schema') != 'pointercad-solid-tet4-buckling-plan/1' or reference.get('schema') != 'pointercad-solid-tet4-plan/1' \
            or data.get('schema') != 'pointercad-solid-tet4/1' or data.get('units') != 'N-mm-MPa' \
            or plan.get('input', {}).get('schema') != 'pointercad-solid-tet4-buckling/1':
        raise ValueError('solid-buckling-input: invalid bounded plan')
    count, fixed = len(data['nodes']), reference['fixed']
    mode_count = plan['input']['modeCount']
    if not isinstance(mode_count, int) or isinstance(mode_count, bool) or not 1 <= mode_count <= 12:
        raise ValueError('solid-buckling-modes: expected an integer from 1 to 12')
    free = [3 * node + axis for node in range(count) for axis in range(3) if not fixed[node][axis]]
    if len(free) != plan['freeDofs'] or not mode_count <= len(free) <= MAX_FREE_DOFS:
        raise ValueError(f'solid-buckling-supports: free DOFs must be between the mode count and {MAX_FREE_DOFS}')
    # Dense K, Kg (3n)^2 each, reduced copies, Cholesky factor, eigenvectors: conservative eight-byte numbers.
    numbers = 2 * (3 * count) ** 2 + 6 * len(free) ** 2 + 400 * len(data['elements']) + 4096
    budget = data['numericBudgetBytes']
    if not isinstance(budget, int) or isinstance(budget, bool) or numbers * 8 > budget:
        raise ValueError('solid-buckling-budget: dense buckling reservation exceeds the numeric budget')
    with open(DECK, 'w', encoding='utf-8') as stream:
        stream.write(solid_buckling_deck(plan))
    problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(DECK), fem.problemMode.processor, 0, None, False)
    if problem is None:
        raise ValueError('solid-buckling-native: OOFEM rejected the generated deck')
    primary = None
    try:
        if problem.checkProblemConsistency() != 1:
            raise ValueError('solid-buckling-native: inconsistent native model')
        problem.init()
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        meta = problem.giveMetaStep(1)
        if meta is None or meta.giveNumberOfSteps() != 1:
            raise ValueError('solid-buckling-native: the default metastep must carry one step')
        problem.initMetaStepAttributes(meta)
        problem.preInitializeNextStep()
        step = problem.giveNextStep()
        problem.initializeYourself(step)
        problem.solveYourselfAt(step)
        problem.updateYourself(step)
        domain = problem.giveDomain(1)
        ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
        displacement = [[_finite(float(domain.giveDofManager(n + 1).giveDofWithID(dof).giveUnknown(
            fem.ValueModeType.VM_Total, step))) for dof in ids] for n in range(count)]
        if any(fixed[n][a] and displacement[n][a] != 0 for n in range(count) for a in range(3)):
            raise ValueError('solid-buckling-native: prescribed displacement is not exactly zero')
        materials = {row['id']: row for row in data['materials']}
        stiffness = np.zeros((3 * count, 3 * count))
        geometric = np.zeros((3 * count, 3 * count))
        rows = []
        expected_mask = [int(dof) for dof in ids]
        for e, row in enumerate(data['elements']):
            element = domain.giveElement(e + 1)
            mask = fem.IntArray()
            element.giveDofManDofIDMask(1, mask)
            if list(mask) != expected_mask:
                raise ValueError('solid-buckling-native: unexpected tet4 DOF order')
            for local, node in enumerate(row['nodes'], 1):
                if element.giveDofManagerNumber(local) != node + 1:
                    raise ValueError('solid-buckling-native: element/node association changed')
            k_native = _symmetric_native(np, fem, element, fem.CharType.TangentStiffnessMatrix, step, 'stiffness')
            kg_native = _symmetric_native(np, fem, element, fem.CharType.InitialStressMatrix, step, 'initial-stress')
            gp = element.giveDefaultIntegrationRulePtr().getIntegrationPoint(0)
            answer = fem.FloatArray()
            element.giveIPValue(answer, gp, fem.InternalStateType.IST_StressTensor, step)
            stress_native = [_finite(float(v)) for v in answer]
            if len(stress_native) != 6:
                raise ValueError('solid-buckling-native: element stress is not a 6-vector')
            points = [data['nodes'][n] for n in row['nodes']]
            material = materials[row['materialId']]
            stress = tet4_stress(np, points, [displacement[n] for n in row['nodes']], material['youngMPa'], material['poisson'])
            rows.append((stress_native, stress, kg_native, tet4_initial_stress(np, points, stress)))
            index = [3 * n + a for n in row['nodes'] for a in range(3)]
            stiffness[np.ix_(index, index)] += k_native
            geometric[np.ix_(index, index)] += kg_native
        stress_scale = max(abs(v) for _, stress, _, _ in rows for v in stress)
        if not math.isfinite(stress_scale) or stress_scale <= 0:
            raise ValueError('solid-buckling-no-positive-mode: the reference state is stress-free')
        stress_error = max(abs(a - b) for native, stress, _, _ in rows for a, b in zip(native, stress, strict=True)) / stress_scale
        if not stress_error <= 1e-8:
            raise ValueError(f'solid-buckling-native: native reference stress differs from D B u ({stress_error!r})')
        kg_scale = max(float(np.max(np.abs(oracle))) for _, _, _, oracle in rows)
        kg_error = max(float(np.max(np.abs(native - oracle))) for _, _, native, oracle in rows) / kg_scale
        if not math.isfinite(kg_error) or kg_error > 1e-8:
            raise ValueError(f'solid-buckling-native: native element initial-stress matrix differs from the closed-form '
                             f'tet4 matrix ({kg_error!r})')
        load = np.zeros(3 * count)
        for node, (force, flags) in enumerate(zip(reference['forcesN'], fixed, strict=True)):
            for axis in range(3):
                if not flags[axis]:
                    load[3 * node + axis] = _finite(force[axis])
        internal = stiffness @ np.array(displacement).reshape(-1)
        scale = max(float(np.max(np.abs(load[free]))), float(np.max(np.abs(internal[free]))), 1e-300)
        residual = float(np.max(np.abs(internal[free] - load[free]))) / scale
        if not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('solid-buckling-equilibrium: native reference residual exceeds 1e-8')
        modes = solve_buckling(np, stiffness[np.ix_(free, free)], geometric[np.ix_(free, free)], mode_count, count, free)
        return json.dumps({'schema': 'pointercad-solid-tet4-buckling-native/1', 'source': data['source'],
                           'freeDofs': len(free), 'referenceEquilibriumResidual': residual,
                           'maximumElementInitialStressError': kg_error, 'modes': modes}, allow_nan=False)
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except BaseException as cleanup:
            if primary is not None:
                primary.add_note('Additional native termination error: ' + repr(cleanup))
            else:
                raise
