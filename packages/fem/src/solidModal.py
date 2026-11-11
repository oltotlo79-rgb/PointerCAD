"""Linear-elastic free vibration of the existing tet4 solid model (EX09, continuum modal core).

Same native path as the static solid route (solidAnalysis.py): fixed OOFEM 214b161 ``ltrspace`` elements
with ``IsoLE`` material, instantiated from a TXT deck. Element stiffness and mass come from the native
``giveCharacteristicMatrix(.., CharType.TangentStiffnessMatrix / CharType.MassMatrix, step)`` calls already used
by beamAnalysis.run_beam_modal; the generalized eigenproblem K v = lambda M v is solved with the fixed NumPy
2.2.5 build by Cholesky mass whitening and ``eigh`` exactly as the beam modal route does. This is not OOFEM
EigenValueDynamic and claims nothing about its eigensolver.

The plan is already in coherent N-mm-MPa-tonne-s units: lengths mm, E in MPa (N/mm^2), density in t/mm^3
(the single kg/m^3 conversion is solidModalTranslation.ts), so eigenvalues are in 1/s^2 and frequencies in Hz.
The plan is external JSON and is validated here completely; the TypeScript checks are not relied upon. Mass is
the native consistent tet4 mass; each element matrix is checked against the closed-form consistent tet4 mass
(rho V / 20 (1 + delta_ij) per direction) so a lumped or wrongly scaled native matrix is refused instead of
reported. A natural frequency is a linear-elastic estimate of the meshed model only; it is never a safety or
resonance certification.
"""
import json
import math
from importlib.metadata import version

MAX_NODES = 600
MAX_ELEMENTS = 3000
MAX_MODES = 20
MAX_SAFE_INTEGER = 2 ** 53 - 1
# 1e5 kg/m^3, above every engineering solid; an unconverted kg/m^3 number (e.g. 7850) is refused.
MAX_DENSITY_T_PER_MM3 = 1e-7
PLAN_SCHEMA = 'pointercad-solid-tet4-modal-plan/2'
NATIVE_SCHEMA = 'pointercad-solid-tet4-modal-native/2'
PLAN_FIELDS = ('schema', 'source', 'units', 'numericBudgetBytes', 'nodes', 'elements', 'materials', 'fixed',
               'modeCount')


def _finite(value, label='solid-modal-numeric: finite number required'):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(label)
    return float(value)


def _integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(label)
    return value


def _text(value, label):
    if not isinstance(value, str) or not 1 <= len(value) <= 256:
        raise ValueError(label)
    return value


def _record(value, fields, label):
    if not isinstance(value, dict) or len(value) != len(fields) or set(value) != set(fields):
        raise ValueError(f'solid-modal-input: {label} requires exactly the fields ' + ', '.join(fields))
    return value


def _list(value, minimum, maximum, label):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValueError(f'solid-modal-input: {label} must be a list of {minimum} to {maximum} entries')
    return value


def _reject_constant(token):
    raise ValueError(f'solid-modal-input: non-finite JSON token {token}')


def _unique_pairs(pairs):
    row = {}
    for key, value in pairs:
        if key in row:
            raise ValueError('solid-modal-input: duplicate JSON key')
        row[key] = value
    return row


def parse_plan(text):
    """Strict JSON: NaN/Infinity tokens and repeated keys are refused instead of being silently accepted."""
    return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_unique_pairs)


def _symmetric(np, matrix, label):
    if not np.isfinite(matrix).all():
        raise ValueError(f'solid-modal-numeric: non-finite {label}')
    norm = float(np.linalg.norm(matrix))
    if norm <= 0 or np.linalg.norm(matrix - matrix.T) > norm * 1e-11:
        raise ValueError(f'solid-modal-symmetry: invalid {label}')
    return (matrix + matrix.T) / 2


def _positive_factor(np, matrix, failure):
    if not np.isfinite(matrix).all() or np.any(np.diag(matrix) <= 0):
        raise ValueError(failure)
    try:
        factor = np.linalg.cholesky(matrix)
    except np.linalg.LinAlgError as error:
        raise ValueError(failure) from error
    if not np.isfinite(factor).all() or np.any(np.diag(factor) <= 0):
        raise ValueError(failure)
    return factor


def tet4_volume(points):
    """Signed volume of a tet4 from four [x, y, z] points (mm^3); positive for the OOFEM node order."""
    (x0, y0, z0), (x1, y1, z1), (x2, y2, z2), (x3, y3, z3) = points
    a = (x1 - x0, y1 - y0, z1 - z0)
    b = (x2 - x0, y2 - y0, z2 - z0)
    c = (x3 - x0, y3 - y0, z3 - z0)
    return (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6


def consistent_tet4_mass(np, density, volume):
    """Closed-form consistent mass of a linear tetrahedron, DOF order (u, v, w) per node (12 x 12)."""
    base = (np.ones((4, 4)) + np.eye(4)) * (density * volume / 20)
    return np.kron(base, np.eye(3))


def check_element_mass(np, native_mass, density, volume):
    """Refuse a native element mass that is not the consistent tet4 mass of the given density and volume."""
    expected = consistent_tet4_mass(np, density, volume)
    scale = float(np.max(np.abs(expected)))
    if not scale > 0:
        raise ValueError('solid-modal-mass: nonpositive element mass')
    error = float(np.max(np.abs(native_mass - expected))) / scale
    if not math.isfinite(error) or error > 1e-10:
        raise ValueError('solid-modal-mass: native element mass is not the consistent tet4 mass')
    return error


def _components(element_nodes, count):
    parent = list(range(count))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    used = set()
    for nodes in element_nodes:
        used.update(nodes)
        for other in nodes[1:]:
            a, b = find(nodes[0]), find(other)
            if a != b:
                parent[b] = a
    if len(used) != count:
        raise ValueError('solid-modal-mesh: every node must belong to an element')
    return len({find(index) for index in range(count)})


def rigid_motions(np, positions):
    """Six translational/rotational rigid motions of the whole node set, translation DOFs only (3n x 6)."""
    points = np.asarray(positions, dtype=float)
    centre = points.mean(axis=0)
    scale = max(1.0, float(np.max(np.linalg.norm(points - centre, axis=1))))
    columns = []
    for axis in range(3):
        motion = np.zeros(points.shape)
        motion[:, axis] = 1.0
        columns.append(motion.reshape(-1))
    for axis in range(3):
        direction = np.eye(3)[axis]
        columns.append((np.cross(direction, (points - centre) / scale)).reshape(-1))
    return np.column_stack(columns)


def dense_modal_bytes(size):
    """Upper bound in bytes of the float64 arrays that coexist in this route, for s = size = 3 x nodes,
    f <= s free DOFs and r <= f elastic DOFs (f, or f - 6 without restraints). The peak is the eigh call:
      4 s^2  assembled K and M held by run_solid_modal plus the symmetrized copies made by solve_solid_modal
      5 f^2  reduced_k, reduced_m, cholesky, operator, basis (the identity, or the complete QR factor it views)
      5 r^2  projected, and inside eigh the LAPACK input copy, the eigenvector output and syevd's 2 r^2 work
    Every other stage holds fewer quadratic arrays: forming the operator (two solves with their LAPACK copies
    of a and b) 4 s^2 + 7 f^2, its symmetrization 4 s^2 + 6 f^2, the mode back-substitution 4 s^2 + 6 f^2 + 2 r^2,
    the mass symmetrization 5 s^2. Linear terms stay below 160 s: rigid motions 6 s, the full/reduced modes and
    the back-substitution right side and copy 4 x 20 s, residual vectors 4 s, syevd 6 r + iwork 5 r, QR inputs
    and factors 12 f, index arrays 3 s. 4096 covers scalars, 12 x 12 element matrices and the m x m Gram
    matrix. Python lists, the deck text and the JSON reply are interpreter heap and are not counted.
    The six-array claim of r147 (6 s^2) undercounted this route.
    """
    return (14 * size * size + 160 * size + 4096) * 8


def solve_solid_modal(np, positions, element_nodes, fixed, stiffness, mass, mode_count):
    """Pure core: lowest elastic modes of K v = lambda M v with translational DOFs.

    ``fixed`` is a list of three booleans per node. Without any restraint, the six rigid motions are checked
    against K, mass-orthonormalized and projected out (a single connected mesh is required). With restraints,
    no rigid subspace is assumed and any remaining mechanism is refused as a nonpositive eigenvalue.
    Returns eigenvalues (1/s^2), mass-normalized full-length vectors and the quality measures.
    """
    count = len(positions)
    size = 3 * count
    if stiffness.shape != (size, size) or mass.shape != (size, size):
        raise ValueError('solid-modal-size: assembled matrices do not match the node count')
    if not isinstance(mode_count, int) or isinstance(mode_count, bool) or not 1 <= mode_count <= MAX_MODES:
        raise ValueError('solid-modal-modes: 1 to 20 modes required')
    free = np.array([3 * node + axis for node in range(count) for axis in range(3) if not fixed[node][axis]], dtype=int)
    if free.size == 0:
        raise ValueError('solid-modal-restraints: no free degrees of freedom')
    stiffness = _symmetric(np, stiffness, 'global stiffness')
    mass = _symmetric(np, mass, 'global mass')
    reduced_k = stiffness[np.ix_(free, free)]
    reduced_m = mass[np.ix_(free, free)]
    cholesky = _positive_factor(np, reduced_m, 'solid-modal-mass: mass is not positive definite')
    operator = _symmetric(np, np.linalg.solve(cholesky, np.linalg.solve(cholesky, reduced_k).T).T,
                          'mass-whitened stiffness')
    restrained = any(any(row) for row in fixed)
    rigid_count = 0
    maximum_rigid_residual = 0.0
    if restrained:
        basis = np.eye(free.size)
    else:
        if _components(element_nodes, count) != 1:
            raise ValueError('solid-modal-mesh: an unrestrained model must be one connected solid')
        rigid = rigid_motions(np, positions)
        k_norm = float(np.linalg.norm(reduced_k))
        for column in rigid.T:
            residual = float(np.linalg.norm(reduced_k @ column) / (k_norm * np.linalg.norm(column)))
            maximum_rigid_residual = max(maximum_rigid_residual, residual)
        if maximum_rigid_residual > 1e-10:
            raise ValueError('solid-modal-frame: assembled stiffness does not preserve rigid motions')
        orthogonal, triangular = np.linalg.qr(cholesky.T @ rigid, mode='complete')
        diagonal = np.abs(np.diag(triangular[:6]))
        if np.min(diagonal) <= np.max(diagonal) * 1e-12:
            raise ValueError('solid-modal-rigid: dependent rigid motion basis')
        rigid_count = 6
        basis = orthogonal[:, 6:]
    if mode_count > basis.shape[1]:
        raise ValueError('solid-modal-size: more modes requested than elastic degrees of freedom')
    projected = _symmetric(np, basis.T @ operator @ basis, 'elastic stiffness')
    values, vectors = np.linalg.eigh(projected)
    resolution = np.finfo(float).eps * max(1, projected.shape[0]) * float(np.linalg.norm(projected, ord=np.inf)) * 64
    if not np.isfinite(values).all() or np.any(values <= resolution):
        raise ValueError('solid-modal-mechanism: nonpositive or numerically unresolved elastic eigenvalue')
    selected = values[:mode_count]
    modes = np.linalg.solve(cholesky.T, basis @ vectors[:, :mode_count])
    gram = modes.T @ reduced_m @ modes
    orthogonality = float(np.max(np.abs(gram - np.eye(mode_count))))
    if not math.isfinite(orthogonality) or orthogonality > 1e-8:
        raise ValueError('solid-modal-orthogonality: eigenvectors are not mass orthonormal')
    residuals = []
    for index, eigenvalue in enumerate(selected):
        vector = modes[:, index]
        k_vector, m_vector = reduced_k @ vector, reduced_m @ vector
        denominator = float(np.linalg.norm(k_vector) + eigenvalue * np.linalg.norm(m_vector))
        if not math.isfinite(denominator) or denominator <= 0:
            raise ValueError('solid-modal-residual: invalid eigen-residual denominator')
        residual = float(np.linalg.norm(k_vector - eigenvalue * m_vector)) / denominator
        if not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('solid-modal-residual: normalized eigen-residual exceeded 1e-8')
        residuals.append(residual)
    full = np.zeros((size, mode_count))
    full[free, :] = modes
    return {'eigenvalues': selected, 'massNormalizedModes': full, 'residuals': residuals,
            'maximumMassOrthogonalityError': orthogonality, 'rigidBodyModes': rigid_count,
            'maximumRigidMotionResidual': maximum_rigid_residual, 'freeDofs': int(free.size)}


def _deck(plan):
    """Same deck shape as solidAnalysis._deck; IsoLE d is the plan density, already in t/mm^3, no loads."""
    materials = {row['id']: i + 1 for i, row in enumerate(plan['materials'])}
    lines = ['/pcad_fem/solid-modal.out', 'PointerCAD tet4 modal; coherent N, mm, MPa, t, s',
             'LinearStatic nsteps 1 nmodules 0', 'domain 3d', 'OutputManager',
             f"ndofman {len(plan['nodes'])} nelem {len(plan['elements'])} "
             f"ncrosssect {len(materials)} nmat {len(materials)} nbc 1 nltf 1 nic 0"]
    for number, (point, restraint) in enumerate(zip(plan['nodes'], plan['fixed'], strict=True), 1):
        lines.append(f'node {number} coords 3 ' + ' '.join(str(_finite(v)) for v in point)
                     + ' bc 3 ' + ' '.join('1' if v else '0' for v in restraint))
    for number, element in enumerate(plan['elements'], 1):
        material = materials[element['materialId']]
        lines.append(f'ltrspace {number} nodes 4 ' + ' '.join(str(i + 1) for i in element['nodes'])
                     + f' mat {material} crosssect {material}')
    for number in range(1, len(materials) + 1):
        lines.append(f'SimpleCS {number} material {number}')
    for number, material in enumerate(plan['materials'], 1):
        lines.append(f"IsoLE {number} d {_finite(material['densityTPerMm3'])!r} E {_finite(material['youngMPa'])} "
                     f"n {_finite(material['poisson'])} tAlpha 0.0")
    lines += ['BoundaryCondition 1 loadTimeFunction 1 prescribedValue 0.0',
              'PeakFunction 1 t 1.0 f(t) 1.0', '']
    return '\n'.join(lines)


def validate_plan(plan):
    """Strict, bounded native-unit plan; every refusal happens before the deck, OOFEM or any dense array.

    Unknown or missing fields, booleans used as numbers, non-finite or unused coordinates, malformed
    restraint rows, node indices and duplicate tetrahedra are refused here, independent of TypeScript.
    Returns the plan, the density per material id (t/mm^3) and the dense reservation in bytes.
    """
    _record(plan, PLAN_FIELDS, 'plan')
    if plan['schema'] != PLAN_SCHEMA:
        raise ValueError('solid-modal-input: unknown plan schema')
    if plan['units'] != 'N-mm-MPa-t-s':
        raise ValueError('solid-modal-input: N-mm-MPa-t-s plan units required')
    source = _record(plan['source'], ('documentId', 'revision', 'meshKey'), 'source')
    _text(source['documentId'], 'solid-modal-input: invalid source identity')
    _text(source['meshKey'], 'solid-modal-input: invalid source identity')
    _integer(source['revision'], 0, MAX_SAFE_INTEGER, 'solid-modal-input: invalid source revision')
    nodes = _list(plan['nodes'], 4, MAX_NODES, 'nodes')
    for point in nodes:
        if not isinstance(point, list) or len(point) != 3:
            raise ValueError('solid-modal-input: exactly three coordinates per node')
        for value in point:
            _finite(value, 'solid-modal-input: finite node coordinates required')
    count = len(nodes)
    budget = _integer(plan['numericBudgetBytes'], 1, MAX_SAFE_INTEGER,
                      'solid-modal-budget: explicit integer reservation required')
    reserved = dense_modal_bytes(3 * count)
    if reserved > budget:
        raise ValueError('solid-modal-budget: dense modal reservation exceeded')
    densities = {}
    for material in _list(plan['materials'], 1, MAX_ELEMENTS, 'materials'):
        _record(material, ('id', 'youngMPa', 'poisson', 'densityTPerMm3'), 'material')
        identity = _text(material['id'], 'solid-modal-material: invalid material id')
        if identity in densities:
            raise ValueError('solid-modal-material: duplicate material id')
        density = _finite(material['densityTPerMm3'], 'solid-modal-material: finite density required')
        young = _finite(material['youngMPa'], 'solid-modal-material: finite Young modulus required')
        poisson = _finite(material['poisson'], 'solid-modal-material: finite Poisson ratio required')
        if not 0 < density <= MAX_DENSITY_T_PER_MM3 or not young > 0 or not -1 < poisson < 0.5:
            raise ValueError('solid-modal-material: 0 < density <= 1e-7 t/mm^3, positive E and -1 < nu < 0.5 required')
        densities[identity] = density
    keys = set()
    used = set()
    for element in _list(plan['elements'], 1, MAX_ELEMENTS, 'elements'):
        _record(element, ('nodes', 'materialId'), 'element')
        ids = element['nodes']
        if not isinstance(ids, list) or len(ids) != 4 or any(type(i) is not int or not 0 <= i < count for i in ids) \
                or len(set(ids)) != 4:
            raise ValueError('solid-modal-input: invalid tet4 node indices')
        if not isinstance(element['materialId'], str) or element['materialId'] not in densities:
            raise ValueError('solid-modal-input: unknown element material')
        key = tuple(sorted(ids))
        if key in keys:
            raise ValueError('solid-modal-input: duplicate tetrahedron')
        keys.add(key)
        volume = tet4_volume([nodes[i] for i in ids])
        if not (math.isfinite(volume) and volume > 0):
            raise ValueError('solid-modal-input: tet4 volume must be finite and positive in node order')
        used.update(ids)
    if len(used) != count:
        raise ValueError('solid-modal-mesh: every node must belong to an element')
    fixed = _list(plan['fixed'], count, count, 'fixed')
    if any(not isinstance(row, list) or len(row) != 3 or any(type(v) is not bool for v in row) for row in fixed):
        raise ValueError('solid-modal-input: exactly three boolean translations per node')
    free = sum(not v for row in fixed for v in row)
    restrained = free < 3 * count
    if not restrained and _components([element['nodes'] for element in plan['elements']], count) != 1:
        raise ValueError('solid-modal-mesh: an unrestrained model must be one connected solid')
    elastic = free if restrained else free - 6
    mode_count = _integer(plan['modeCount'], 1, MAX_MODES, 'solid-modal-modes: 1 to 20 modes required')
    if mode_count > elastic:
        raise ValueError('solid-modal-size: more modes requested than elastic degrees of freedom')
    return plan, densities, reserved


def run_solid_modal():
    import numpy as np
    import oofem as fem
    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('solid-modal-native: unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/solid-modal-input.json', encoding='utf-8') as stream:
        text = stream.read()
    plan, densities, reserved = validate_plan(parse_plan(text))
    count = len(plan['nodes'])
    with open('/pcad_fem/solid-modal.in', 'w', encoding='utf-8') as stream:
        stream.write(_deck(plan))
    problem = None
    primary = None
    try:
        problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader('/pcad_fem/solid-modal.in'),
                                        fem.problemMode.processor, 0, None, False)
        if problem is None or problem.checkProblemConsistency() != 1:
            raise ValueError('solid-modal-native: inconsistent native model')
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        problem.init()
        step = problem.giveNextStep()
        domain = problem.giveDomain(1)
        size = 3 * count
        stiffness, mass = np.zeros((size, size)), np.zeros((size, size))
        expected_mask = [int(dof) for dof in (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)]
        total_mass = 0.0
        maximum_mass_error = 0.0
        for index, row in enumerate(plan['elements']):
            element = domain.giveElement(index + 1)
            mask = fem.IntArray()
            element.giveDofManDofIDMask(1, mask)
            if list(mask) != expected_mask:
                raise ValueError('solid-modal-native: unexpected tet4 DOF order')
            for local, node in enumerate(row['nodes'], 1):
                if element.giveDofManagerNumber(local) != node + 1:
                    raise ValueError('solid-modal-native: element/node association changed')
            native_k, native_m = fem.FloatMatrix(), fem.FloatMatrix()
            element.giveCharacteristicMatrix(native_k, fem.CharType.TangentStiffnessMatrix, step)
            element.giveCharacteristicMatrix(native_m, fem.CharType.MassMatrix, step)
            # Copy scalar values; no NumPy view may outlive a native FloatMatrix.
            local_k = np.array([[_finite(native_k[i, j]) for j in range(12)] for i in range(12)])
            local_m = np.array([[_finite(native_m[i, j]) for j in range(12)] for i in range(12)])
            local_k = _symmetric(np, local_k, 'native element stiffness')
            volume = tet4_volume([plan['nodes'][i] for i in row['nodes']])
            density = densities[row['materialId']]
            maximum_mass_error = max(maximum_mass_error, check_element_mass(np, local_m, density, volume))
            total_mass += density * volume
            indices = [3 * node + axis for node in row['nodes'] for axis in range(3)]
            stiffness[np.ix_(indices, indices)] += local_k
            mass[np.ix_(indices, indices)] += local_m
        solved = solve_solid_modal(np, plan['nodes'], [row['nodes'] for row in plan['elements']], plan['fixed'],
                                   stiffness, mass, plan['modeCount'])
        modes = []
        for index, eigenvalue in enumerate(solved['eigenvalues']):
            vector = solved['massNormalizedModes'][:, index]
            modes.append({'number': index + 1, 'eigenvaluePerSecondSquared': float(eigenvalue),
                          'frequencyHz': math.sqrt(float(eigenvalue)) / (2 * math.pi),
                          'normalizedResidual': solved['residuals'][index],
                          # v^T M v = 1 with M in t gives v in 1/sqrt(t), not a length: a displacement in mm is
                          # v times a modal amplitude in mm sqrt(t), which free vibration does not determine.
                          'massNormalizedShapePerSqrtT': vector.reshape(count, 3).tolist()})
        return json.dumps({'schema': NATIVE_SCHEMA, 'source': plan['source'],
                           'massMatrix': 'consistent', 'units': 'N-mm-MPa-t-s', 'modes': modes,
                           'totalMassT': total_mass, 'rigidBodyModes': solved['rigidBodyModes'],
                           'freeDofs': solved['freeDofs'],
                           'maximumMassOrthogonalityError': solved['maximumMassOrthogonalityError'],
                           'maximumRigidMotionResidual': solved['maximumRigidMotionResidual'],
                           'maximumElementMassError': maximum_mass_error,
                           'reservedNumericBytes': reserved}, allow_nan=False)
    except BaseException as error:
        primary = error
        raise
    finally:
        if problem is not None:
            try:
                problem.terminateAnalysis()
            except BaseException as cleanup:
                if primary is not None:
                    primary.add_note('Additional native termination error: ' + repr(cleanup))
                else:
                    raise
