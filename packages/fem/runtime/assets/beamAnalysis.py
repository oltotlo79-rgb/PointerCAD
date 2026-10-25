"""Fixed developer program. The request file contains translated numeric data only.

OOFEM commit 214b161ed: bindings/python/oofem.cpp and src/sm/Elements/Beams/beam3d.C.
Linear small-displacement Timoshenko beams, nodal loading, rigid shared nodes,
explicit full clamps. No capacity, weld/contact, geometric or material nonlinearity.
Every model is built with suppress_output: the Python factory (oofemutil.h createEngngModelOfType) never
assigns EngngModel::startTime, which the .out header (engngm.C:353) would format with ctime().
"""
import json
import math
from importlib.metadata import version


def run_beam_analysis():
    import oofem as fem
    from oofem import util

    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('Unexpected fixed OOFEM distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    if plan['schema'] != 'pointercad-oofem-beam-plan/1':
        raise ValueError('Unsupported internal numeric plan')
    problem = fem.linearStatic(nSteps=1, outFile='/pcad_fem/analysis.out', suppress_output=True)
    domain = fem.domain(1, 1, problem, fem.domainType._3dShellMode,
                        tstep_all=True, dofman_all=True, element_all=True)
    problem.setDomain(1, domain, True)
    function = fem.peakFunction(1, domain, t=1, f_t=1)
    boundary = [fem.boundaryCondition(1, domain, loadTimeFunction=1, prescribedValue=0.0)]
    nodes = []
    for row in plan['nodes']:
        load_number = len(boundary) + 1
        boundary.append(fem.nodalLoad(load_number, domain, loadTimeFunction=1,
                                      components=tuple(row['load'])))
        nodes.append(fem.node(row['number'], domain, coords=tuple(row['positionM']),
                              bc=((1 if row['fixed'] else 0),) * 6, load=(load_number,)))
    materials = [fem.isoLE(row['number'], domain, d=row['densityKgM3'],
                            E=row['youngPa'], n=row['poisson'], tAlpha=0.0)
                 for row in plan['materials']]
    sections = [fem.simpleCS(row['number'], domain, area=row['areaM2'],
                              Iy=row['iyM4'], Iz=row['izM4'], Ik=row['torsionM4'],
                              beamShearCoeff=row['shearFactor']) for row in plan['sections']]
    elements = [fem.beam3d(row['number'], domain, nodes=tuple(row['nodes']),
                           mat=row['material'], crossSect=row['section'],
                           zaxis=tuple(row['frame']['z'])) for row in plan['members']]
    util.setupDomain(domain, nodes, elements, sections, materials, boundary, (), (function,), ())
    if problem.checkProblemConsistency() != 1:
        raise ValueError('OOFEM rejected structural consistency')
    problem.init()
    problem.postInitialize()
    problem.setRenumberFlag()
    try:
        problem.solveYourself()
        step = problem.giveCurrentStep(False)
        dofs = [fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w,
                fem.DofIDItem.R_u, fem.DofIDItem.R_v, fem.DofIDItem.R_w]
        decoded_nodes = []
        for row in plan['nodes']:
            node = domain.giveDofManager(row['number'])
            unknowns = [float(node.giveDofWithID(dof).giveUnknown(fem.ValueModeType.VM_Total, step)) for dof in dofs]
            decoded_nodes.append({'number': node.giveNumber(), 'unknowns': unknowns})
        decoded_elements = []
        for row in plan['members']:
            element = domain.giveElement(row['number'])
            forces = fem.FloatArray()
            # Native B^T sigma integration returns the LOCAL element force vector.
            # Only nodal loads are accepted, so no distributed-load subtraction is needed.
            element.giveCharacteristicVector(forces, fem.CharType.InternalForcesVector,
                                             fem.ValueModeType.VM_Total, step)
            values = [float(v) for v in forces]
            if len(values) != 12:
                raise ValueError('Expected twelve local element end actions')
            decoded_elements.append({'number': element.giveNumber(),
                'nodes': [element.giveDofManagerNumber(1), element.giveDofManagerNumber(2)],
                'localEndForces': values})
        for row in decoded_nodes:
            if not all(math.isfinite(v) for v in row['unknowns']):
                raise ValueError('OOFEM returned non-finite nodal unknowns')
        for row in decoded_elements:
            if not all(math.isfinite(v) for v in row['localEndForces']):
                raise ValueError('OOFEM returned non-finite element forces')
        return json.dumps({'schema': 'pointercad-oofem-beam-result/1',
                           'nodes': decoded_nodes, 'elements': decoded_elements}, allow_nan=False)
    finally:
        problem.terminateAnalysis()


def _bending_rotary_mass(np, length, material, section):
    """Additional kinetic energy only; native mass already includes torsion.

    Rotation interpolation follows OOFEM commit 214b161ed beam3d.C 152-200.
    Three Gauss points integrate the quadratic rotation products exactly.
    rho is kg/m3, Iy/Iz m4; this contributes kg*m2 to rotation/rotation
    blocks and the corresponding mixed units to other blocks.
    """
    young = material['youngPa']
    shear = young / (2 * (1 + material['poisson']))
    shear_area = section['shearFactor'] * section['areaM2']
    result = np.zeros((12, 12))
    for point, weight in ((-math.sqrt(3 / 5), 5 / 9), (0.0, 8 / 9),
                          (math.sqrt(3 / 5), 5 / 9)):
        s = (point + 1) / 2
        for inertia, indices, sign in (
                (section['iyM4'], (2, 4, 8, 10), 1),
                (section['izM4'], (1, 5, 7, 11), -1)):
            kappa = 6 * young * inertia / (shear * shear_area * length * length)
            denominator = 1 + 2 * kappa
            rotation = np.zeros(12)
            rotation[list(indices)] = [
                sign * (6 * s - 6 * s * s) / (length * denominator),
                (denominator - 2 * (2 + kappa) * s + 3 * s * s) / denominator,
                -sign * (6 * s - 6 * s * s) / (length * denominator),
                (-2 * (1 - kappa) * s + 3 * s * s) / denominator,
            ]
            result += (material['densityKgM3'] * inertia * length * weight / 2
                       * np.outer(rotation, rotation))
    return result


def _modal_components(plan):
    neighbours = {row['number']: set() for row in plan['nodes']}
    for member in plan['members']:
        a, b = member['nodes']
        neighbours[a].add(b)
        neighbours[b].add(a)
    seen, components = set(), []
    for node in neighbours:
        if node in seen:
            continue
        pending, component = [node], []
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            component.append(current)
            pending.extend(neighbours[current] - seen)
        components.append(sorted(component))
    return components


def _symmetric(np, matrix, label):
    if not np.isfinite(matrix).all():
        raise ValueError(f'modal-numeric: non-finite {label}')
    norm = float(np.linalg.norm(matrix))
    if norm <= 0 or np.linalg.norm(matrix - matrix.T) > norm * 1e-11:
        raise ValueError(f'modal-symmetry: invalid {label}')
    return (matrix + matrix.T) / 2


def _positive_factor(np, matrix, failure):
    """Validate both the physical input and the native factorization result.

    Some compiled LAPACK paths can propagate non-finite factors without a
    Python LinAlgError. Never pass such a factor to the next linear solve.
    Positive diagonals alone do not prove definiteness; Cholesky and its
    finite, strictly positive diagonal factor remain mandatory.
    """
    if not np.isfinite(matrix).all() or np.any(np.diag(matrix) <= 0):
        raise ValueError(failure)
    try:
        factor = np.linalg.cholesky(matrix)
    except np.linalg.LinAlgError as error:
        raise ValueError(failure) from error
    if not np.isfinite(factor).all() or np.any(np.diag(factor) <= 0):
        raise ValueError(failure)
    return factor


def _modal_residuals(np, stiffness, mass, values, vectors):
    residuals = []
    for index, eigenvalue in enumerate(values):
        vector = vectors[:, index]
        k_vector, m_vector = stiffness @ vector, mass @ vector
        denominator = np.linalg.norm(k_vector) + eigenvalue * np.linalg.norm(m_vector)
        if not math.isfinite(float(denominator)) or denominator <= 0:
            raise ValueError('modal-residual: invalid eigen-residual denominator')
        residual = float(np.linalg.norm(k_vector - eigenvalue * m_vector) / denominator)
        if not math.isfinite(residual):
            raise ValueError('modal-residual: non-finite eigen-residual')
        residuals.append(residual)
    return residuals


def _refine_restrained_modes(np, stiffness, mass, values, vectors):
    """Refine the selected elastic subspace in the original reduced equations.

    A normwise backward-stable eigensolve of the mass-whitened operator can
    lose relative accuracy in its smallest eigenpairs when the full spectrum
    spans many scales. Block inverse iteration suppresses high-mode error;
    Rayleigh-Ritz preserves a coupled, mass-orthonormal subspace, including
    repeated or clustered eigenvalues. This changes no physical matrix.

    This helper requires positive-definite restrained K. Free rigid-body
    systems retain the separate analytical-nullspace route and never enter.
    Four iterations bound the work. The original residual/orthogonality gates
    below remain authoritative even if refinement cannot improve the result.
    """
    best_values, best_vectors = values, vectors
    best_error = max(_modal_residuals(np, stiffness, mass, values, vectors))
    if best_error <= 1e-10:
        return best_values, best_vectors
    diagonal = np.diag(stiffness)
    if not np.isfinite(diagonal).all() or np.any(diagonal <= 0):
        raise ValueError('modal-mechanism: invalid restrained stiffness diagonal')
    scaling = 1 / np.sqrt(diagonal)
    equilibrated = _symmetric(np, scaling[:, None] * stiffness * scaling[None, :],
                              'equilibrated restrained stiffness')
    factor = _positive_factor(np, equilibrated,
        'modal-mechanism: restrained stiffness is not positive definite')
    current = vectors
    for _ in range(4):
        right = scaling[:, None] * (mass @ current)
        inverse_modes = scaling[:, None] * np.linalg.solve(factor.T, np.linalg.solve(factor, right))
        gram = _symmetric(np, inverse_modes.T @ mass @ inverse_modes, 'inverse-iteration modal mass')
        normalization = _positive_factor(np, gram,
            'modal-orthogonality: refinement subspace lost rank')
        basis = np.linalg.solve(normalization, inverse_modes.T).T
        projected = _symmetric(np, basis.T @ stiffness @ basis, 'refined modal stiffness')
        candidate_values, rotation = np.linalg.eigh(projected)
        if not np.isfinite(candidate_values).all() or np.any(candidate_values <= 0):
            raise ValueError('modal-mechanism: invalid refined elastic eigenvalue')
        current = basis @ rotation
        error = max(_modal_residuals(np, stiffness, mass, candidate_values, current))
        if error < best_error:
            best_values, best_vectors, best_error = candidate_values, current, error
        if best_error <= 1e-10:
            break
    return best_values, best_vectors


def _solve_modal_system(np, plan, stiffness, mass, total_mass):
    """One global system, full support reduction, analytical rigid subspace.

    q = D v with translational D=L and rotational D=1 avoids comparing metres
    directly with radians. Cholesky whitens the positive mass. Known rigid
    motions are checked against K, mass-orthonormalized and projected out;
    unexpected nullspace/negative elastic eigenvalues are rejected.
    """
    nodes = plan['nodes']
    size = 6 * len(nodes)
    length = plan['normalizationLengthM']
    diagonal = np.tile([length, length, length, 1, 1, 1], len(nodes))
    free = np.array([6 * index + dof for index, row in enumerate(nodes)
                     if not row['fixed'] for dof in range(6)], dtype=int)
    if free.size == 0:
        raise ValueError('modal-restraints: no free degrees of freedom')
    stiffness = _symmetric(np, stiffness, 'global stiffness')
    mass = _symmetric(np, mass, 'global mass')
    scaled_k = (diagonal[:, None] * stiffness * diagonal[None, :])[np.ix_(free, free)]
    scaled_m = (diagonal[:, None] * mass * diagonal[None, :])[np.ix_(free, free)]
    cholesky = _positive_factor(np, scaled_m,
        'modal-mass: mass is not positive definite')
    left = np.linalg.solve(cholesky, scaled_k)
    operator = _symmetric(np, np.linalg.solve(cholesky, left.T).T, 'mass-whitened stiffness')
    components = _modal_components(plan)
    rigid_columns = []
    any_fixed = any(row['fixed'] for row in nodes)
    for component in components:
        fixed = any(nodes[number - 1]['fixed'] for number in component)
        if fixed:
            continue
        if any_fixed:
            raise ValueError('modal-mechanism: restrained structure has an unsupported connected component')
        centre = np.mean([nodes[number - 1]['positionM'] for number in component], axis=0)
        for axis in range(6):
            motion = np.zeros(size)
            direction = np.eye(3)[axis % 3]
            for number in component:
                offset = 6 * (number - 1)
                if axis < 3:
                    motion[offset:offset + 3] = direction
                else:
                    relative = (np.asarray(nodes[number - 1]['positionM']) - centre) / length
                    motion[offset:offset + 3] = np.cross(direction, relative)
                    motion[offset + 3:offset + 6] = direction
            rigid_columns.append(motion[free])
    rigid_count = len(rigid_columns)
    maximum_rigid_residual = 0.0
    if rigid_count:
        rigid = np.column_stack(rigid_columns)
        k_norm = float(np.linalg.norm(scaled_k))
        for column in rigid.T:
            residual = float(np.linalg.norm(scaled_k @ column) / (k_norm * np.linalg.norm(column)))
            maximum_rigid_residual = max(maximum_rigid_residual, residual)
        if maximum_rigid_residual > 1e-10:
            raise ValueError('modal-frame: assembled stiffness does not preserve rigid motions')
        orthogonal, triangular = np.linalg.qr(cholesky.T @ rigid, mode='complete')
        diagonal_r = np.abs(np.diag(triangular[:rigid_count]))
        if np.min(diagonal_r) <= np.max(diagonal_r) * 1e-12:
            raise ValueError('modal-rigid: dependent rigid motion basis')
        elastic_basis = orthogonal[:, rigid_count:]
    else:
        elastic_basis = np.eye(free.size)
    if plan['modeCount'] > elastic_basis.shape[1]:
        raise ValueError('modal-size: more modes requested than elastic degrees of freedom')
    reduced = _symmetric(np, elastic_basis.T @ operator @ elastic_basis, 'elastic stiffness')
    eigenvalues, eigenvectors = np.linalg.eigh(reduced)
    resolution = np.finfo(float).eps * max(1, reduced.shape[0]) * float(np.linalg.norm(reduced, ord=np.inf)) * 64
    if np.any(eigenvalues <= resolution):
        raise ValueError('modal-mechanism: nonpositive or numerically unresolved elastic eigenvalue')
    selected_values = eigenvalues[:plan['modeCount']]
    whitened_modes = elastic_basis @ eigenvectors[:, :plan['modeCount']]
    scaled_modes = np.linalg.solve(cholesky.T, whitened_modes)
    if rigid_count == 0:
        selected_values, scaled_modes = _refine_restrained_modes(
            np, scaled_k, scaled_m, selected_values, scaled_modes)
    gram = scaled_modes.T @ scaled_m @ scaled_modes
    orthogonality = float(np.max(np.abs(gram - np.eye(plan['modeCount']))))
    if not math.isfinite(orthogonality) or orthogonality > 1e-8:
        raise ValueError('modal-orthogonality: eigenvectors are not mass orthonormal')
    results = []
    for index, eigenvalue in enumerate(selected_values):
        vector = scaled_modes[:, index]
        k_vector = scaled_k @ vector
        m_vector = scaled_m @ vector
        denominator = np.linalg.norm(k_vector) + eigenvalue * np.linalg.norm(m_vector)
        residual = float(np.linalg.norm(k_vector - eigenvalue * m_vector) / denominator)
        if not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('modal-residual: normalized eigen-residual exceeded 1e-8')
        full = np.zeros(size)
        full[free] = vector
        # A single shared amplitude factor preserves relative translation/rotation.
        # max(||u/L||, ||theta||) over all nodes is exactly one.
        amplitude = max(float(np.linalg.norm(full[offset:offset + 3]))
                        for offset in range(0, size, 3))
        if not math.isfinite(amplitude) or amplitude <= 0:
            raise ValueError('modal-shape: zero or invalid mode shape')
        sign = 1 if full[int(np.argmax(np.abs(full)))] >= 0 else -1
        full *= sign / amplitude
        generalized_mass = float(full[free] @ scaled_m @ full[free])
        decoded_nodes = []
        for node_index, row in enumerate(nodes):
            offset = 6 * node_index
            decoded_nodes.append({'number': row['number'],
                'translation': full[offset:offset + 3].tolist(),
                'rotation': full[offset + 3:offset + 6].tolist()})
        results.append({'number': index + 1, 'frequencyHz': math.sqrt(float(eigenvalue)) / (2 * math.pi),
            'eigenvaluePerSecondSquared': float(eigenvalue), 'normalizedResidual': residual,
            'generalizedMassKgM2': generalized_mass, 'nodes': decoded_nodes})
    return {'schema': 'pointercad-oofem-modal-result/1', 'modes': results,
        'rigidBodyModes': rigid_count, 'normalizationLengthM': length,
        'totalMassKg': total_mass, 'meshNodes': len(nodes), 'meshElements': len(plan['members']),
        'freeDofs': int(free.size), 'maximumMassOrthogonalityError': orthogonality,
        'maximumRigidMotionResidual': maximum_rigid_residual}


def run_beam_modal():
    """Native OOFEM matrices + explicit rotary correction + NumPy eigensolve.

    This is not OOFEM EigenValueDynamic and does not claim its eigensolver.
    No source string, path or native keyword is taken from document text.
    """
    import numpy as np
    import oofem as fem
    from oofem import util

    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('Unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    if plan['schema'] != 'pointercad-oofem-modal-plan/1' or not 2 <= len(plan['nodes']) <= 128:
        raise ValueError('Unsupported bounded modal numeric plan')
    problem = fem.linearStatic(nSteps=1, outFile='/pcad_fem/modal-matrices.out', suppress_output=True)
    domain = fem.domain(1, 1, problem, fem.domainType._3dShellMode,
                        tstep_all=True, dofman_all=True, element_all=True)
    problem.setDomain(1, domain, True)
    function = fem.peakFunction(1, domain, t=1, f_t=1)
    boundary = [fem.boundaryCondition(1, domain, loadTimeFunction=1, prescribedValue=0.0)]
    nodes = [fem.node(row['number'], domain, coords=tuple(row['positionM']),
                      bc=((1 if row['fixed'] else 0),) * 6) for row in plan['nodes']]
    materials = [fem.isoLE(row['number'], domain, d=row['densityKgM3'],
                           E=row['youngPa'], n=row['poisson'], tAlpha=0.0)
                 for row in plan['materials']]
    sections = [fem.simpleCS(row['number'], domain, area=row['areaM2'],
                             Iy=row['iyM4'], Iz=row['izM4'], Ik=row['torsionM4'],
                             beamShearCoeff=row['shearFactor']) for row in plan['sections']]
    elements = [fem.beam3d(row['number'], domain, nodes=tuple(row['nodes']),
                          mat=row['material'], crossSect=row['section'],
                          zaxis=tuple(row['frame']['z'])) for row in plan['members']]
    util.setupDomain(domain, nodes, elements, sections, materials, boundary, (), (function,), ())
    try:
        # Only solveYourself starts the analysis timer that terminateAnalysis stops (engngm.C:578, 2027).
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        if problem.checkProblemConsistency() != 1:
            raise ValueError('OOFEM rejected modal structural consistency')
        problem.init()
        problem.postInitialize()
        problem.setRenumberFlag()
        step = problem.giveNextStep()
        size = 6 * len(nodes)
        stiffness, mass = np.zeros((size, size)), np.zeros((size, size))
        total_mass = 0.0
        for row, element in zip(plan['members'], elements, strict=True):
            native_k, native_m = fem.FloatMatrix(), fem.FloatMatrix()
            element.giveCharacteristicMatrix(native_k, fem.CharType.TangentStiffnessMatrix, step)
            element.giveCharacteristicMatrix(native_m, fem.CharType.MassMatrix, step)
            # Copy scalar values; no NumPy view may outlive native FloatMatrix.
            local_k = np.array([[float(native_k[i, j]) for j in range(12)] for i in range(12)])
            local_m = np.array([[float(native_m[i, j]) for j in range(12)] for i in range(12)])
            material = plan['materials'][row['material'] - 1]
            section = plan['sections'][row['section'] - 1]
            length = row['frame']['lengthM']
            local_m += _bending_rotary_mass(np, length, material, section)
            local_k = _symmetric(np, local_k, 'native element stiffness')
            local_m = _symmetric(np, local_m, 'native plus rotary element mass')
            frame = np.array([row['frame'][axis] for axis in ('x', 'y', 'z')])
            if np.max(np.abs(frame @ frame.T - np.eye(3))) > 1e-10 or np.linalg.det(frame) < 0:
                raise ValueError('modal-frame: frame must be right-handed orthonormal')
            transform = np.kron(np.eye(4), frame)
            indices = [6 * (number - 1) + dof for number in row['nodes'] for dof in range(6)]
            stiffness[np.ix_(indices, indices)] += transform.T @ local_k @ transform
            mass[np.ix_(indices, indices)] += transform.T @ local_m @ transform
            total_mass += material['densityKgM3'] * section['areaM2'] * length
        result = _solve_modal_system(np, plan, stiffness, mass, total_mass)
        return json.dumps(result, allow_nan=False)
    finally:
        # Keep problem/domain/material/element wrappers alive through extraction.
        problem.terminateAnalysis()


def _buckling_symmetric(np, matrix, label):
    if not np.isfinite(matrix).all():
        raise ValueError(f'buckling-numeric: non-finite {label}')
    norm = float(np.linalg.norm(matrix))
    if not math.isfinite(norm) or np.linalg.norm(matrix - matrix.T) > norm * 1e-11:
        raise ValueError(f'buckling-symmetry: invalid {label}')
    return (matrix + matrix.T) / 2


def _buckling_reduction(np, plan, stiffness):
    free = np.array([6 * index + axis for index, node in enumerate(plan['nodes'])
                     for axis in range(6) if not node['restrained'][axis]], dtype=int)
    if free.size < plan['modeCount']:
        raise ValueError('buckling-supports: insufficient free degrees of freedom')
    reduced = _buckling_symmetric(np, stiffness[np.ix_(free, free)], 'restrained stiffness')
    diagonal = np.diag(reduced)
    if np.any(diagonal <= 0):
        raise ValueError('buckling-mechanism: nonpositive stiffness diagonal')
    scaling = 1 / np.sqrt(diagonal)
    equilibrated = _buckling_symmetric(np, scaling[:, None] * reduced * scaling[None, :],
                                      'equilibrated stiffness')
    factor = _positive_factor(np, equilibrated,
        'buckling-mechanism: supports leave an unstable or unresolved mechanism')
    # A finite Cholesky result alone does not exclude a numerically unresolved
    # rigid mechanism in a rounded assembled matrix.
    values = np.linalg.eigvalsh(equilibrated)
    threshold = np.finfo(float).eps * free.size * np.linalg.norm(equilibrated, ord=np.inf) * 64
    if not np.isfinite(values).all() or values[0] <= threshold:
        raise ValueError('buckling-mechanism: numerically unresolved restrained stiffness')
    return free, scaling, equilibrated, factor


def _solve_buckling_system(np, plan, stiffness, geometric, equilibrium):
    free, scaling, scaled_k, factor = _buckling_reduction(np, plan, stiffness)
    # Native Kg is positive in tension. Loss of stability: (K + lambda Kg)q=0.
    reduced_g = -geometric[np.ix_(free, free)]
    scaled_g = _buckling_symmetric(np, scaling[:, None] * reduced_g * scaling[None, :],
                                  'compression geometric stiffness')
    left = np.linalg.solve(factor, scaled_g)
    operator = _buckling_symmetric(np, np.linalg.solve(factor, left.T).T,
                                  'stiffness-whitened geometric stiffness')
    reciprocal, vectors = np.linalg.eigh(operator)
    resolution = np.finfo(float).eps * free.size * np.linalg.norm(operator, ord=np.inf) * 64
    selected = np.flatnonzero(reciprocal > resolution)[::-1][:plan['modeCount']]
    if selected.size != plan['modeCount']:
        raise ValueError('buckling-no-positive-mode: no resolved positive load factors for requested modes')
    modes = np.linalg.solve(factor.T, vectors[:, selected])
    orthogonality = float(np.max(np.abs(modes.T @ scaled_k @ modes - np.eye(selected.size))))
    if not math.isfinite(orthogonality) or orthogonality > 1e-8:
        raise ValueError('buckling-orthogonality: stiffness orthogonality exceeded 1e-8')
    results = []
    for index, column in enumerate(selected):
        load_factor = float(1 / reciprocal[column])
        vector = modes[:, index]
        k_vector, g_vector = scaled_k @ vector, scaled_g @ vector
        denominator = np.linalg.norm(k_vector) + load_factor * np.linalg.norm(g_vector)
        residual = float(np.linalg.norm(k_vector - load_factor * g_vector) / denominator)
        if not math.isfinite(load_factor) or load_factor <= 0 or not math.isfinite(residual) or residual > 1e-8:
            raise ValueError('buckling-residual: invalid factor or normalized residual exceeded 1e-8')
        full = np.zeros(stiffness.shape[0])
        full[free] = scaling * vector
        full.reshape((-1, 6))[:, :3] /= plan['normalizationLengthM']
        amplitude = max(float(np.linalg.norm(full[offset:offset + 3])) for offset in range(0, full.size, 3))
        if not math.isfinite(amplitude) or amplitude <= 0:
            raise ValueError('buckling-shape: invalid mode amplitude')
        sign = 1 if full[int(np.argmax(np.abs(full)))] >= 0 else -1
        full *= sign / amplitude
        results.append({'number': index + 1, 'loadFactor': load_factor, 'normalizedResidual': residual,
            'nodes': [{'number': row['number'], 'translation': full[6 * i:6 * i + 3].tolist(),
                       'rotation': full[6 * i + 3:6 * i + 6].tolist()}
                      for i, row in enumerate(plan['nodes'])]})
    return {'schema': 'pointercad-oofem-buckling-result/1', 'modes': results,
        'normalizationLengthM': plan['normalizationLengthM'], 'meshNodes': len(plan['nodes']),
        'meshElements': len(plan['members']), 'freeDofs': int(free.size),
        'referenceEquilibriumResidual': equilibrium,
        'maximumStiffnessOrthogonalityError': orthogonality}


def run_beam_buckling():
    """Native Beam3d K and axial-prestress Kg; explicit symmetric eigensolve.

    OOFEM214b161 beam3d.C830-897 adds artificial axial/torsion Kg entries
    minVal/1000 solely to regularize the full initial-stress matrix. This
    flexural formulation zeroes those local rows/columns and retains every
    native bending/shear entry. K is unchanged. There is no torsional,
    lateral-torsional, follower-load, plastic or local-wall buckling claim.
    Non-axial reference end actions are explicitly unsupported, not ignored.
    """
    import numpy as np
    import oofem as fem
    from oofem import util

    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('Unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    if plan['schema'] != 'pointercad-oofem-buckling-plan/1' or not 2 <= len(plan['nodes']) <= 128:
        raise ValueError('Unsupported bounded buckling numeric plan')
    problem = fem.linearStatic(nSteps=1, outFile='/pcad_fem/buckling-reference.out', suppress_output=True)
    domain = fem.domain(1, 1, problem, fem.domainType._3dShellMode,
                        tstep_all=True, dofman_all=True, element_all=True)
    problem.setDomain(1, domain, True)
    function = fem.peakFunction(1, domain, t=1, f_t=1)
    boundary = [fem.boundaryCondition(1, domain, loadTimeFunction=1, prescribedValue=0.0)]
    nodes = []
    for row in plan['nodes']:
        number = len(boundary) + 1
        boundary.append(fem.nodalLoad(number, domain, loadTimeFunction=1, components=tuple(row['load'])))
        nodes.append(fem.node(row['number'], domain, coords=tuple(row['positionM']),
            bc=tuple(1 if value else 0 for value in row['restrained']), load=(number,)))
    materials = [fem.isoLE(row['number'], domain, d=row['densityKgM3'], E=row['youngPa'],
                          n=row['poisson'], tAlpha=0.0) for row in plan['materials']]
    sections = [fem.simpleCS(row['number'], domain, area=row['areaM2'], Iy=row['iyM4'],
                            Iz=row['izM4'], Ik=row['torsionM4'], beamShearCoeff=row['shearFactor'])
                for row in plan['sections']]
    elements = [fem.beam3d(row['number'], domain, nodes=tuple(row['nodes']), mat=row['material'],
                          crossSect=row['section'], zaxis=tuple(row['frame']['z'])) for row in plan['members']]
    util.setupDomain(domain, nodes, elements, sections, materials, boundary, (), (function,), ())
    primary_error = None
    try:
        # Only solveYourself starts the analysis timer that terminateAnalysis stops (engngm.C:578, 2027).
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        if problem.checkProblemConsistency() != 1:
            raise ValueError('OOFEM rejected buckling reference consistency')
        problem.init()
        problem.postInitialize()
        problem.setRenumberFlag()
        step = problem.giveNextStep()
        size = 6 * len(nodes)
        stiffness, geometric = np.zeros((size, size)), np.zeros((size, size))
        transforms, locations = [], []
        for row, element in zip(plan['members'], elements, strict=True):
            native = fem.FloatMatrix()
            element.giveCharacteristicMatrix(native, fem.CharType.TangentStiffnessMatrix, step)
            local = np.array([[float(native[i, j]) for j in range(12)] for i in range(12)])
            local = _buckling_symmetric(np, local, 'native element stiffness')
            frame = np.array([row['frame'][axis] for axis in ('x', 'y', 'z')])
            if np.max(np.abs(frame @ frame.T - np.eye(3))) > 1e-10 or np.linalg.det(frame) < 0:
                raise ValueError('buckling-frame: invalid local frame')
            transform = np.kron(np.eye(4), frame)
            indices = [6 * (number - 1) + axis for number in row['nodes'] for axis in range(6)]
            stiffness[np.ix_(indices, indices)] += transform.T @ local @ transform
            transforms.append(transform)
            locations.append(indices)
        free, _, _, _ = _buckling_reduction(np, plan, stiffness)
        # Validate supports before calling the native static linear solver.
        problem.solveYourselfAt(step)
        assembled = np.zeros(size)
        load = np.array([value for row in plan['nodes'] for value in row['load']])
        force_scale = max(np.linalg.norm(load.reshape((-1, 6))[:, :3]),
                          np.linalg.norm(load.reshape((-1, 6))[:, 3:]) / plan['normalizationLengthM'])
        if not math.isfinite(float(force_scale)) or force_scale <= 0:
            raise ValueError('buckling-load: zero or invalid reference load')
        for row, element, transform, indices in zip(plan['members'], elements, transforms, locations, strict=True):
            forces = fem.FloatArray()
            element.giveCharacteristicVector(forces, fem.CharType.InternalForcesVector, fem.ValueModeType.VM_Total, step)
            end = np.array([float(value) for value in forces])
            if end.size != 12 or not np.isfinite(end).all():
                raise ValueError('buckling-prestress: invalid native end forces')
            other = end.copy().reshape((2, 6))
            other[:, 0] = 0
            other[:, 3:] /= row['frame']['lengthM']
            if np.linalg.norm(other) > force_scale * 1e-8:
                raise ValueError('buckling-prestress: bending/shear/torsional reference actions unsupported')
            assembled[indices] += transform.T @ end
            native = fem.FloatMatrix()
            element.giveCharacteristicMatrix(native, fem.CharType.InitialStressMatrix, step)
            local = np.array([[float(native[i, j]) for j in range(12)] for i in range(12)])
            local = _buckling_symmetric(np, local, 'native initial stress matrix')
            local[[0, 3, 6, 9], :] = 0
            local[:, [0, 3, 6, 9]] = 0
            geometric[np.ix_(indices, indices)] += transform.T @ local @ transform
        units = np.tile([1, 1, 1, 1 / plan['normalizationLengthM'],
                         1 / plan['normalizationLengthM'], 1 / plan['normalizationLengthM']], len(nodes))
        equilibrium = float(np.linalg.norm(((assembled - load) * units)[free]) / force_scale)
        if not math.isfinite(equilibrium) or equilibrium > 1e-8:
            raise ValueError('buckling-equilibrium: native reference residual exceeded 1e-8')
        return json.dumps(_solve_buckling_system(np, plan, stiffness, geometric, equilibrium), allow_nan=False)
    except BaseException as error:
        primary_error = error
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except BaseException as cleanup_error:
            if primary_error is None:
                raise
            primary_error.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')


# Provisional work bound (step count x free DOFs^2), identical in transientTranslation.ts. Each step costs
# six dense matrix-vector products; the value is NOT a measured performance claim and must be confirmed or
# replaced from Root's bounded benchmark (transientBenchmark.testSupport.ts) without changing accuracy.
TRANSIENT_WORK_LIMIT = 400_000_000
TRANSIENT_HISTORY_FIELDS = {'timeStepS', 'stepCount', 'outputEvery', 'loadFactor', 'damping', 'initialConditions'}


def _transient_symmetric(np, matrix, label):
    if not np.isfinite(matrix).all():
        raise ValueError(f'transient-numeric: non-finite {label}')
    norm = float(np.linalg.norm(matrix))
    if not math.isfinite(norm) or norm <= 0 or np.linalg.norm(matrix - matrix.T) > norm * 1e-11:
        raise ValueError(f'transient-symmetry: invalid {label}')
    return (matrix + matrix.T) / 2


def _transient_load_factor(samples, time):
    """Piecewise-linear interpolation of the validated, strictly increasing samples."""
    for left, right in zip(samples, samples[1:]):
        if left['timeS'] <= time <= right['timeS']:
            width = right['timeS'] - left['timeS']
            fraction = (time - left['timeS']) / width
            return left['factor'] + fraction * (right['factor'] - left['factor'])
    if abs(time - samples[-1]['timeS']) <= abs(samples[-1]['timeS']) * 1e-12:
        return samples[-1]['factor']
    raise ValueError('transient-history: time outside the load-factor samples')


def _transient_number(value):
    """JSON numbers only: bool is an int subclass in Python and is rejected explicitly, as in TS."""
    if not isinstance(value, float | int) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # Python JSON can retain an arbitrarily large integer; TS Number cannot.
        return False


def _transient_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_transient_history(history):
    """Same acceptance, order and error prefixes as readHistory in transientTranslation.ts."""
    if not isinstance(history, dict) or set(history) != TRANSIENT_HISTORY_FIELDS:
        raise ValueError('transient-shape: history')
    damping = history['damping']
    if damping != 'none' and (not isinstance(damping, dict)
            or set(damping) != {'kind', 'massCoefficientPerS', 'stiffnessCoefficientS'}
            or damping['kind'] != 'rayleigh'
            or not _transient_number(damping['massCoefficientPerS']) or damping['massCoefficientPerS'] < 0
            or not _transient_number(damping['stiffnessCoefficientS']) or damping['stiffnessCoefficientS'] < 0):
        raise ValueError('transient-damping: expected none or explicit nonnegative finite Rayleigh coefficients')
    if history['initialConditions'] != 'zero-at-rest':
        raise ValueError('transient-initial: only zero displacement and velocity are supported')
    step, count, every = history['timeStepS'], history['stepCount'], history['outputEvery']
    if not _transient_number(step):
        raise ValueError('transient-number: history.timeStepS')
    if step <= 0:
        raise ValueError('transient-step: time step must be positive')
    if not _transient_integer(count) or not 1 <= count <= 4000:
        raise ValueError('transient-steps: step count must be an integer from 1 to 4000')
    # Returned samples: time 0, every n-th step and the last step once = 1 + ceil(count / every) <= 101.
    if not _transient_integer(every) or not 1 <= every <= count or -(-count // every) > 100:
        raise ValueError('transient-output: at most 101 output samples are returned')
    duration = step * count
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('transient-step: total duration must be finite and positive')
    # Newmark coefficients 4/dt^2, 4/dt and dt/2 must be finite and nonzero before native work starts.
    try:
        coefficients = (4 / (step * step), 4 / step, step / 2)
    except (OverflowError, ZeroDivisionError):
        coefficients = (math.inf,)
    if not all(math.isfinite(value) and value > 0 for value in coefficients):
        raise ValueError('transient-step: Newmark coefficients overflow or underflow')
    samples = history['loadFactor']
    if not isinstance(samples, list) or not 2 <= len(samples) <= 256:
        raise ValueError('transient-history: two to 256 load-factor samples are required')
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict) or set(sample) != {'timeS', 'factor'}:
            raise ValueError(f'transient-shape: history.loadFactor[{index}]')
        if not _transient_number(sample['factor']):
            raise ValueError(f'transient-number: history.loadFactor[{index}].factor')
        if abs(sample['factor']) > 1e6:
            raise ValueError('transient-history: load factor magnitude exceeds 1e6')
        if not _transient_number(sample['timeS']):
            raise ValueError(f'transient-number: history.loadFactor[{index}].timeS')
    if any(right['timeS'] <= left['timeS'] for left, right in zip(samples, samples[1:])):
        raise ValueError('transient-history: sample times must be strictly increasing')
    if samples[0]['timeS'] != 0:
        raise ValueError('transient-history: the first sample must be at time 0')
    if samples[-1]['timeS'] < duration * (1 - 1e-12) or samples[-1]['timeS'] > duration * (1 + 1e-12):
        raise ValueError('transient-history: the last sample must be at the analysis duration')
    return step, count, every, samples


def _solve_transient_system(np, plan, stiffness, mass):
    """Average-acceleration Newmark (beta=1/4, gamma=1/2), zero initial state.

    Matrices are the native OOFEM beam3d stiffness and mass (plus the documented
    rotary-inertia correction), assembled in the global frame. The time integration
    is this explicit NumPy procedure, not an OOFEM transient engine. For a linear
    system C=alpha*M+beta*K is positive semidefinite for nonnegative coefficients.
    The discrete external work equals the change in kinetic + strain energy plus
    dt*v_mid.T*C*v_mid exactly in exact arithmetic. Equilibrium M*a+C*v+K*u=f
    holds at every step. Stability does not imply time-resolution accuracy.
    """
    step, count, every, samples = _validate_transient_history(plan['history'])
    nodes = plan['nodes']
    size = 6 * len(nodes)
    length = plan['normalizationLengthM']
    free = np.array([6 * index + axis for index, node in enumerate(nodes)
                     for axis in range(6) if not node['restrained'][axis]], dtype=int)
    if free.size == 0:
        raise ValueError('transient-restraints: no free degrees of freedom')
    # u = D q with D=L for translations and 1 for rotations, as in the modal path.
    diagonal = np.tile([length, length, length, 1, 1, 1], len(nodes))
    stiffness = _transient_symmetric(np, stiffness, 'global stiffness')
    mass = _transient_symmetric(np, mass, 'global mass')
    scaled_k = _transient_symmetric(np, (diagonal[:, None] * stiffness * diagonal[None, :])[np.ix_(free, free)],
                                    'restrained stiffness')
    scaled_m = _transient_symmetric(np, (diagonal[:, None] * mass * diagonal[None, :])[np.ix_(free, free)],
                                    'restrained mass')
    k_diagonal = np.diag(scaled_k)
    if np.any(k_diagonal <= 0):
        raise ValueError('transient-mechanism: nonpositive stiffness diagonal')
    equilibration = 1 / np.sqrt(k_diagonal)
    equilibrated = _transient_symmetric(np, equilibration[:, None] * scaled_k * equilibration[None, :],
                                        'equilibrated stiffness')
    _positive_factor(np, equilibrated, 'transient-mechanism: supports leave an unstable or unresolved mechanism')
    values = np.linalg.eigvalsh(equilibrated)
    threshold = np.finfo(float).eps * free.size * np.linalg.norm(equilibrated, ord=np.inf) * 64
    if not np.isfinite(values).all() or values[0] <= threshold:
        raise ValueError('transient-mechanism: numerically unresolved restrained stiffness')
    mass_factor = _positive_factor(np, scaled_m, 'transient-mass: mass is not positive definite')
    reference = (diagonal * np.array([value for row in nodes for value in row['load']]))[free]
    if not np.isfinite(reference).all():
        raise ValueError('transient-load: non-finite reference load')
    if count * free.size * free.size > TRANSIENT_WORK_LIMIT:
        raise ValueError('transient-budget: step count x free DOFs^2 exceeds 4e8')
    c0, c1 = 4 / (step * step), 4 / step
    damping_spec = plan['history']['damping']
    rayleigh = damping_spec != 'none'
    alpha = damping_spec['massCoefficientPerS'] if rayleigh else 0.0
    beta = damping_spec['stiffnessCoefficientS'] if rayleigh else 0.0
    # Congruence D.T*C*D commutes with this linear combination of the same K/M.
    # Preserve the original arithmetic path for none and for explicit zero coefficients.
    damping = None
    effective = scaled_k + c0 * scaled_m
    if alpha != 0 or beta != 0:
        damping = _transient_symmetric(np, alpha * scaled_m + beta * scaled_k, 'Rayleigh damping')
        effective = effective + (2 / step) * damping
    effective = _transient_symmetric(np, effective, 'effective stiffness')
    effective_factor = _positive_factor(np, effective, 'transient-effective: effective stiffness is not positive definite')

    def solve(factor, right):
        return np.linalg.solve(factor.T, np.linalg.solve(factor, right))

    # NumPy 2.2.5 in the pinned runtime has no triangular solver and SciPy is not shipped. The Cholesky
    # factor L of Keff = L L^T is therefore inverted once against the identity (one O(n^3) solve), and each
    # step applies Keff^-1 r = W^T (W r) with W = L^-1: two dense O(n^2) triangular-matrix products and no
    # per-step refactorization. The per-step equilibrium residual below verifies every solution.
    inverse_factor = np.tril(np.linalg.solve(effective_factor, np.eye(free.size)))
    if not np.isfinite(inverse_factor).all() or np.any(np.diag(inverse_factor) <= 0):
        raise ValueError('transient-effective: invalid inverse Cholesky factor')
    q = np.zeros(free.size)
    v = np.zeros(free.size)
    f_previous = _transient_load_factor(samples, 0.0) * reference
    a = solve(mass_factor, f_previous)
    work = 0.0
    dissipated = 0.0
    maximum_equilibrium = 0.0
    energy_scale = 0.0
    maximum_energy_gap = 0.0

    def record(time, factor, q, v, a):
        full = np.zeros((3, size))
        full[0, free], full[1, free], full[2, free] = q, v, a
        full *= diagonal[None, :]
        rows = []
        for index, node in enumerate(nodes[:plan['originalNodeCount']]):
            block = full[:, 6 * index:6 * index + 6]
            rows.append({'number': node['number'],
                'displacementM': block[0, :3].tolist(), 'rotationRad': block[0, 3:].tolist(),
                'velocityMPerS': block[1, :3].tolist(), 'angularVelocityRadPerS': block[1, 3:].tolist(),
                'accelerationMPerS2': block[2, :3].tolist(), 'angularAccelerationRadPerS2': block[2, 3:].tolist()})
        return {'timeS': time, 'loadFactor': factor, 'nodes': rows}

    output = [record(0.0, _transient_load_factor(samples, 0.0), q, v, a)]
    # Peak magnitudes: the Euclidean norm of each node's vector at every step, sampled or not; the maximum is
    # kept with its step time and solver node. Component-wise maxima of different times are never combined.
    peak = {'displacement': (0.0, 0.0, nodes[0]['number']), 'rotation': (0.0, 0.0, nodes[0]['number'])}
    for index in range(1, count + 1):
        time = step * index
        factor = _transient_load_factor(samples, min(time, samples[-1]['timeS']))
        f_next = factor * reference
        right = f_next + scaled_m @ (c0 * q + c1 * v + a)
        if damping is not None:
            right = right + damping @ ((2 / step) * q + v)
        q_next = inverse_factor.T @ (inverse_factor @ right)
        a_next = c0 * (q_next - q) - c1 * v - a
        v_next = v + step / 2 * (a + a_next)
        if not (np.isfinite(q_next).all() and np.isfinite(v_next).all() and np.isfinite(a_next).all()):
            raise ValueError('transient-numeric: non-finite response')
        work += float((q_next - q) @ (f_previous + f_next) / 2)
        m_a, k_q = scaled_m @ a_next, scaled_k @ q_next
        c_v = np.zeros(free.size) if damping is None else damping @ v_next
        if damping is not None:
            midpoint_velocity = (v + v_next) / 2
            loss = float(step * (midpoint_velocity @ (damping @ midpoint_velocity)))
            if not math.isfinite(loss) or loss < 0:
                raise ValueError('transient-energy: invalid viscous dissipation')
            dissipated += loss
        energy = float(v_next @ (scaled_m @ v_next) / 2 + q_next @ k_q / 2)
        if not all(math.isfinite(value) for value in (work, dissipated, energy)):
            raise ValueError('transient-energy: non-finite energy or work')
        denominator = float(np.linalg.norm(m_a) + np.linalg.norm(k_q) + np.linalg.norm(f_next)
                            + np.linalg.norm(c_v))
        if not math.isfinite(denominator) or not np.isfinite(c_v).all():
            raise ValueError('transient-equilibrium: non-finite dynamic forces')
        if denominator > 0:
            maximum_equilibrium = max(maximum_equilibrium,
                                      float(np.linalg.norm(m_a + k_q + c_v - f_next)) / denominator)
        energy_scale = max(energy_scale, abs(energy), abs(work), dissipated)
        maximum_energy_gap = max(maximum_energy_gap, abs(energy + dissipated - work))
        blocks = np.zeros(size)
        blocks[free] = q_next
        blocks = (blocks * diagonal).reshape(len(nodes), 6)
        for name, part in (('displacement', blocks[:, :3]), ('rotation', blocks[:, 3:])):
            magnitudes = np.linalg.norm(part, axis=1)
            position = int(np.argmax(magnitudes))
            if float(magnitudes[position]) > peak[name][0]:
                peak[name] = (float(magnitudes[position]), time, nodes[position]['number'])
        q, v, a, f_previous = q_next, v_next, a_next, f_next
        if index % every == 0 or index == count:
            output.append(record(time, factor, q, v, a))
    energy_error = maximum_energy_gap / energy_scale if energy_scale > 0 else 0.0
    if not math.isfinite(maximum_equilibrium) or maximum_equilibrium > 1e-8:
        raise ValueError('transient-equilibrium: normalized dynamic equilibrium residual exceeded 1e-8')
    if not math.isfinite(energy_error) or energy_error > 1e-8:
        raise ValueError('transient-energy: energy balance error exceeded 1e-8')
    damping_metadata = ({'damping': dict(damping_spec), 'dissipatedEnergyJ': dissipated} if rayleigh else {})
    return {'schema': 'pointercad-oofem-transient-result/2' if rayleigh else 'pointercad-oofem-transient-result/1',
        **damping_metadata, 'samples': output,
        'normalizationLengthM': length, 'meshNodes': len(nodes), 'meshElements': len(plan['members']),
        'freeDofs': int(free.size), 'maximumEquilibriumResidual': maximum_equilibrium,
        'maximumEnergyBalanceError': energy_error,
        'peakDisplacementM': peak['displacement'][0], 'peakDisplacementTimeS': peak['displacement'][1],
        'peakDisplacementSolverNode': peak['displacement'][2],
        'peakRotationRad': peak['rotation'][0], 'peakRotationTimeS': peak['rotation'][1],
        'peakRotationSolverNode': peak['rotation'][2]}


def _native_beam3d_problem(fem, out_file):
    """Only the OOFEM problem, created before the caller's try so that its finally can always terminate it."""
    return fem.linearStatic(nSteps=1, outFile=out_file, suppress_output=True)


def _native_beam3d_matrices(np, fem, util, problem, plan, consistency_message):
    """Domain setup, initialization and native beam3d K and M (+ rotary inertia), exactly as run_beam_transient
    assembled them. Call only inside the caller's try whose finally terminates `problem`."""
    domain = fem.domain(1, 1, problem, fem.domainType._3dShellMode,
                        tstep_all=True, dofman_all=True, element_all=True)
    problem.setDomain(1, domain, True)
    function = fem.peakFunction(1, domain, t=1, f_t=1)
    boundary = [fem.boundaryCondition(1, domain, loadTimeFunction=1, prescribedValue=0.0)]
    nodes = [fem.node(row['number'], domain, coords=tuple(row['positionM']),
                      bc=tuple(1 if value else 0 for value in row['restrained'])) for row in plan['nodes']]
    materials = [fem.isoLE(row['number'], domain, d=row['densityKgM3'], E=row['youngPa'],
                           n=row['poisson'], tAlpha=0.0) for row in plan['materials']]
    sections = [fem.simpleCS(row['number'], domain, area=row['areaM2'], Iy=row['iyM4'],
                             Iz=row['izM4'], Ik=row['torsionM4'], beamShearCoeff=row['shearFactor'])
                for row in plan['sections']]
    elements = [fem.beam3d(row['number'], domain, nodes=tuple(row['nodes']), mat=row['material'],
                           crossSect=row['section'], zaxis=tuple(row['frame']['z'])) for row in plan['members']]
    util.setupDomain(domain, nodes, elements, sections, materials, boundary, (), (function,), ())
    # Only solveYourself starts the analysis timer that terminateAnalysis stops (engngm.C:578, 2027).
    problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
    if problem.checkProblemConsistency() != 1:
        raise ValueError(consistency_message)
    problem.init()
    problem.postInitialize()
    problem.setRenumberFlag()
    step = problem.giveNextStep()
    size = 6 * len(nodes)
    stiffness, mass = np.zeros((size, size)), np.zeros((size, size))
    for row, element in zip(plan['members'], elements, strict=True):
        native_k, native_m = fem.FloatMatrix(), fem.FloatMatrix()
        element.giveCharacteristicMatrix(native_k, fem.CharType.TangentStiffnessMatrix, step)
        element.giveCharacteristicMatrix(native_m, fem.CharType.MassMatrix, step)
        local_k = np.array([[float(native_k[i, j]) for j in range(12)] for i in range(12)])
        local_m = np.array([[float(native_m[i, j]) for j in range(12)] for i in range(12)])
        material = plan['materials'][row['material'] - 1]
        section = plan['sections'][row['section'] - 1]
        local_m += _bending_rotary_mass(np, row['frame']['lengthM'], material, section)
        local_k = _transient_symmetric(np, local_k, 'native element stiffness')
        local_m = _transient_symmetric(np, local_m, 'native plus rotary element mass')
        frame = np.array([row['frame'][axis] for axis in ('x', 'y', 'z')])
        if np.max(np.abs(frame @ frame.T - np.eye(3))) > 1e-10 or np.linalg.det(frame) < 0:
            raise ValueError('transient-frame: frame must be right-handed orthonormal')
        transform = np.kron(np.eye(4), frame)
        indices = [6 * (number - 1) + axis for number in row['nodes'] for axis in range(6)]
        stiffness[np.ix_(indices, indices)] += transform.T @ local_k @ transform
        mass[np.ix_(indices, indices)] += transform.T @ local_m @ transform
    return stiffness, mass


def run_beam_transient():
    """Native Beam3d K and M (+ rotary inertia) with explicit NumPy Newmark integration.

    This is not OOFEM DIIDynamic/NlDEIDynamic and does not claim their solvers.
    Linear elastic, small displacement, undamped, zero initial state, nodal loads only.
    No impact/contact, plasticity, fatigue or capacity claim.
    """
    import numpy as np
    import oofem as fem
    from oofem import util

    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('Unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    if plan['schema'] != 'pointercad-oofem-transient-plan/1' or not 2 <= len(plan['nodes']) <= 128:
        raise ValueError('Unsupported bounded transient numeric plan')
    _validate_transient_history(plan['history'])
    problem = _native_beam3d_problem(fem, '/pcad_fem/transient-matrices.out')
    primary_error = None
    try:
        stiffness, mass = _native_beam3d_matrices(np, fem, util, problem, plan,
                                                  'OOFEM rejected transient structural consistency')
        return json.dumps(_solve_transient_system(np, plan, stiffness, mass), allow_nan=False)
    except BaseException as error:
        primary_error = error
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except BaseException as cleanup_error:
            if primary_error is None:
                raise
            primary_error.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')
