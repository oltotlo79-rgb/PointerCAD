"""Bounded frictionless unilateral contact for the small-displacement linear 3D beam (first contact slice).

Scope (FEM-PLASTIC-CONTACT-JOINT, first slice only; NOT all contact): static, linear elastic, small displacement
Beam3d frames under nodal loads, with frictionless one-sided contact on node TRANSLATIONS only:
  node-plane  a solver node and a fixed rigid plane: g = g0 + n . u_P
  node-pair   two explicitly paired solver nodes:   g = g0 + n . (u_B - u_A)
where n is a global unit normal, g0 >= 0 is the declared unloaded gap in m and u are the global nodal translations in
m. Pair orientation: when the pair nodes are apart (|x_B - x_A| > 1e-9 m, the model's minimum member length,
analysisValidation.ts) n must point from A towards B (n . (x_B - x_A) > 0), otherwise the pair is refused
(contact-orientation): a reversed normal would turn separation into "closing" and report a tensile tie as a
compressive contact. For coincident pair nodes the orientation comes from the declaration alone. g0 is the declared
gap between the contacting surfaces; it is not derived from or checked against the centerline distance.
With C the constraint rows (plane: n at P; pair: -n at A, +n at B) the solution satisfies
  equilibrium      K u = f + C^T lambda          (N, N m; lambda in N pushes P away from the plane, A and B apart)
  non-penetration  g = g0 + C u >= 0
  no adhesion      lambda >= 0
  complementarity  lambda_i g_i = 0
Refused explicitly: friction or tangential stiffness, arbitrary or deformable surface geometry, surface-to-surface
search, two-sided stops (opposite normals at one node or one pair, contact-two-sided), large displacement or
rotation, impact and dynamics, plasticity and any material assumption beyond the validated linear elastic Beam3d.
A structure that is a mechanism without its contacts is refused: contacts must not be the only support.

Native source: K is the native OOFEM Beam3d tangent stiffness (OOFEM commit 214b161ed, bindings/python/oofem.cpp,
src/sm/Elements/Beams/beam3d.C), assembled exactly as run_beam_transient in beamAnalysis.py. The contact solve is
this explicit NumPy procedure, NOT an OOFEM contact capability: the pinned OOFEM contact
(src/sm/Contact/structuralpenaltycontactbc.h) is a penalty boundary condition between finite-element contact
surfaces (StructuralContactElement_LineLin, upstream example tests/sm/contact2d.in in PlaneStrain), has no node-plane
or node-pair form for beams, states "Currently, only normal contact is working" and has no Python binding.

Method: the free response u0 = K^-1 f and the contact flexibility G = C K^-1 C^T (symmetric positive definite when
the contact rows are independent) reduce the problem to the linear complementarity problem
  g = h + G lambda, h = g0 + C u0, lambda >= 0, g >= 0, lambda . g = 0,
solved by Murty's least-index principal pivoting (K. G. Murty, Linear Complementarity, Linear and Nonlinear
Programming, ch. 4, Principal Pivoting Method I and its finite-termination theorem for P-matrices). The method is
finite but NOT polynomial: symmetric positive definite families exist that need 2^n - 1 pivots. The explicit pivot
limit is therefore a practical bound; reaching it means the unique solution has not been found within the limit,
never that no solution exists (contact-pivot-limit). Each load factor is solved from the unloaded state: the
frictionless linear elastic static solution is unique and path independent, so separation and re-contact between
load factors are exact within this scope.

Force scale: rotational load and residual components (N m) are divided by the moment length L_m (m), the largest
member length of the plan, so every component of the force-like vectors is in N before a norm is taken.
"""
import json
import math
from importlib.metadata import version

CONTACT_PLAN_SCHEMA = 'pointercad-oofem-contact-plan/1'
CONTACT_RESULT_SCHEMA = 'pointercad-oofem-contact-result/1'
CONTACT_PLAN_FIELDS = {'schema', 'nodes', 'materials', 'sections', 'members', 'originalNodeCount', 'contacts',
                       'loadFactors'}
CONTACT_PLANE_FIELDS = {'id', 'kind', 'node', 'normal', 'gapM'}
CONTACT_PAIR_FIELDS = {'id', 'kind', 'nodeA', 'nodeB', 'normal', 'gapM'}
NODE_FIELDS = {'number', 'positionM', 'restrained', 'load'}
MATERIAL_FIELDS = {'number', 'youngPa', 'poisson', 'densityKgM3'}
SECTION_FIELDS = {'number', 'areaM2', 'iyM4', 'izM4', 'torsionM4', 'shearFactor'}
MEMBER_REQUIRED = {'number', 'nodes', 'material', 'section', 'frame'}
MEMBER_OPTIONAL = {'id', 'componentId', 'occurrencePath'}
FRAME_FIELDS = {'x', 'y', 'z', 'lengthM'}
MAX_NODES = 128
MAX_CONTACTS = 64
MAX_LOAD_FACTORS = 32
MAX_GAP_M = 1e3
MAX_LOAD_FACTOR = 1e6
# Same ranges as analysisTranslation.ts finitePositive (normalized stiffness and section values) and coordinates.
POSITIVE_RANGE = (1e-30, 1e30)
MAX_COORDINATE_M = 1e9
MAX_LOAD_COMPONENT = 1e30
# The model's minimum member length (analysisValidation.ts: "Beam length must exceed 1 nm").
COINCIDENT_LENGTH_M = 1e-9
# Member frame against the actual node positions (contact-qualification-r1): the same 1e-10 as the frame
# orthonormality check of the native assembly (beamAnalysis.py run_beam_transient), plus a floor of 64 machine
# epsilons of the coordinate magnitudes, because analysisValidation.beamFrame derives x and lengthM from the
# unscaled delta while the plan positions are scaled separately. The contact-r2 checks (1e-9) stay in force too,
# so no case accepted now was refused by contact-r2.
FRAME_TOLERANCE = 1e-10
LENGTH_TOLERANCE = 1e-12
ROUNDING_FLOOR = 64 * 2.220446049250313e-16
# Thresholds fixed before any execution. All are dimensionless and multiply the physical scales of each load factor:
# the force scale F (N) and the gap scale L (m) defined in _scales. Unchanged from contact-r1.
UNIT_NORMAL_TOLERANCE = 1e-9      # | |n| - 1 |, and the duplicate / two-sided normal comparison
PIVOT_TOLERANCE = 1e-10           # sign decisions inside the pivoting: lambda < -tol F, g < -tol L
EQUILIBRIUM_TOLERANCE = 1e-9      # |D (K u - f - C^T lambda)| / (|D K u| + |D f| + |C^T lambda|)
FEASIBILITY_TOLERANCE = 1e-9      # min g >= -tol L, min lambda >= -tol F
COMPLEMENTARITY_TOLERANCE = 1e-9  # max |lambda_i g_i| <= tol F L


def _number(value):
    """JSON numbers only; bool is an int subclass in Python and is refused explicitly."""
    return isinstance(value, float | int) and not isinstance(value, bool) and math.isfinite(value)


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _positive(value):
    return _number(value) and POSITIVE_RANGE[0] < value <= POSITIVE_RANGE[1]


def _vector(value, size=3):
    return isinstance(value, list) and len(value) == size and all(_number(item) for item in value)


def validate_contacts(contacts, positions):
    """Shape, numbers, unit normals, gaps, node references, self pairs, pair orientation, duplicate constraints and
    two-sided stops. positions maps solver node number -> [x, y, z] in m."""
    if not isinstance(contacts, list) or not 1 <= len(contacts) <= MAX_CONTACTS:
        raise ValueError(f'contact-count: one to {MAX_CONTACTS} contacts are required')
    ids, seen = set(), []
    for index, contact in enumerate(contacts):
        if not isinstance(contact, dict) or contact.get('kind') not in ('node-plane', 'node-pair'):
            raise ValueError(f'contact-shape: contacts[{index}]')
        fields = CONTACT_PLANE_FIELDS if contact['kind'] == 'node-plane' else CONTACT_PAIR_FIELDS
        if set(contact) != fields:
            raise ValueError(f'contact-shape: contacts[{index}]')
        if not isinstance(contact['id'], str) or not 1 <= len(contact['id']) <= 64 or contact['id'] in ids:
            raise ValueError(f'contact-id: contacts[{index}].id must be a unique non-empty name')
        ids.add(contact['id'])
        normal = contact['normal']
        if not _vector(normal):
            raise ValueError(f'contact-number: contacts[{index}].normal')
        if abs(math.sqrt(sum(value * value for value in normal)) - 1) > UNIT_NORMAL_TOLERANCE:
            raise ValueError(f'contact-normal: contacts[{index}].normal must be a unit vector')
        if not _number(contact['gapM']) or not 0 <= contact['gapM'] <= MAX_GAP_M:
            raise ValueError(f'contact-gap: contacts[{index}].gapM must be from 0 to {MAX_GAP_M:g} m')
        members = [contact['node']] if contact['kind'] == 'node-plane' else [contact['nodeA'], contact['nodeB']]
        if not all(_integer(number) and number in positions for number in members):
            raise ValueError(f'contact-node: contacts[{index}] names an unknown solver node')
        if contact['kind'] == 'node-pair':
            if contact['nodeA'] == contact['nodeB']:
                raise ValueError(f'contact-self: contacts[{index}] pairs a node with itself')
            a, b = positions[contact['nodeA']], positions[contact['nodeB']]
            d = [b[axis] - a[axis] for axis in range(3)]
            if math.sqrt(sum(value * value for value in d)) > COINCIDENT_LENGTH_M:
                if sum(normal[axis] * d[axis] for axis in range(3)) <= 0:
                    raise ValueError(f'contact-orientation: contacts[{index}].normal must point from nodeA towards nodeB')
        # (A, B, n) and (B, A, -n) are the same constraint; a plane is identified by its node and normal.
        if contact['kind'] == 'node-plane':
            key = ('plane', contact['node'], tuple(normal))
        elif contact['nodeA'] < contact['nodeB']:
            key = ('pair', contact['nodeA'], contact['nodeB'], tuple(normal))
        else:
            key = ('pair', contact['nodeB'], contact['nodeA'], tuple(-value for value in normal))
        for other in seen:
            if other[:-1] != key[:-1]:
                continue
            if max(abs(a - b) for a, b in zip(other[-1], key[-1])) <= UNIT_NORMAL_TOLERANCE:
                raise ValueError(f'contact-duplicate: contacts[{index}] repeats an earlier contact constraint')
            if max(abs(a + b) for a, b in zip(other[-1], key[-1])) <= UNIT_NORMAL_TOLERANCE:
                raise ValueError(f'contact-two-sided: contacts[{index}] opposes an earlier contact on the same node(s); '
                                 'two-sided stops are not supported in this slice')
        seen.append(key)


def validate_load_factors(values):
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_LOAD_FACTORS:
        raise ValueError(f'contact-factors: one to {MAX_LOAD_FACTORS} load factors are required')
    for index, value in enumerate(values):
        if not _number(value) or abs(value) > MAX_LOAD_FACTOR:
            raise ValueError(f'contact-factors: loadFactors[{index}] must be finite with magnitude <= 1e6')


def validate_nodes(nodes):
    if not isinstance(nodes, list) or not 2 <= len(nodes) <= MAX_NODES:
        raise ValueError(f'contact-shape: two to {MAX_NODES} solver nodes are required')
    for index, node in enumerate(nodes):
        if (not isinstance(node, dict) or set(node) != NODE_FIELDS or not _integer(node['number'])
                or node['number'] != index + 1
                or not isinstance(node['restrained'], list) or len(node['restrained']) != 6
                or not all(isinstance(value, bool) for value in node['restrained'])
                or not _vector(node['load'], 6) or any(abs(value) > MAX_LOAD_COMPONENT for value in node['load'])
                or not _vector(node['positionM']) or any(abs(value) > MAX_COORDINATE_M for value in node['positionM'])):
            raise ValueError(f'contact-shape: nodes[{index}] (numbered 1..n in order, bool is not a number)')
    return {node['number']: node['positionM'] for node in nodes}


def validate_native_rows(plan, positions):
    """Material, section and member rows checked before any OOFEM object is built, with the ranges and references
    that analysisTranslation.ts guarantees for the static plan."""
    materials, sections, members = plan['materials'], plan['sections'], plan['members']
    for name, rows, fields in (('materials', materials, MATERIAL_FIELDS), ('sections', sections, SECTION_FIELDS)):
        if not isinstance(rows, list) or not rows:
            raise ValueError(f'contact-rows: {name} must be a non-empty list')
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or set(row) != fields or not _integer(row['number']) or row['number'] != index + 1:
                raise ValueError(f'contact-rows: {name}[{index}] shape or numbering')
    for index, row in enumerate(materials):
        # Isotropic linear elasticity needs -1 < nu < 0.5 for a positive definite constitutive matrix.
        if not (_positive(row['youngPa']) and _positive(row['densityKgM3']) and _number(row['poisson'])
                and -1 < row['poisson'] < 0.5):
            raise ValueError(f'contact-rows: materials[{index}] values out of range')
    for index, row in enumerate(sections):
        if not all(_positive(row[key]) for key in SECTION_FIELDS - {'number'}):
            raise ValueError(f'contact-rows: sections[{index}] values out of range')
    if not isinstance(members, list) or not members:
        raise ValueError('contact-rows: members must be a non-empty list')
    for index, row in enumerate(members):
        if (not isinstance(row, dict) or not MEMBER_REQUIRED <= set(row) <= MEMBER_REQUIRED | MEMBER_OPTIONAL
                or not _integer(row['number']) or row['number'] != index + 1):
            raise ValueError(f'contact-rows: members[{index}] shape or numbering')
        ends = row['nodes']
        if (not isinstance(ends, list) or len(ends) != 2 or not all(_integer(end) and end in positions for end in ends)
                or ends[0] == ends[1]):
            raise ValueError(f'contact-rows: members[{index}].nodes must name two distinct solver nodes')
        if not (_integer(row['material']) and 1 <= row['material'] <= len(materials)
                and _integer(row['section']) and 1 <= row['section'] <= len(sections)):
            raise ValueError(f'contact-rows: members[{index}] material or section reference')
        frame = row['frame']
        if (not isinstance(frame, dict) or set(frame) != FRAME_FIELDS or not all(_vector(frame[axis]) for axis in 'xyz')
                or not _number(frame['lengthM'])):
            raise ValueError(f'contact-rows: members[{index}].frame')
        if any(abs(value) > 1 + FRAME_TOLERANCE for axis in 'xyz' for value in frame[axis]):
            raise ValueError(f'contact-rows: members[{index}].frame axes must be unit vectors')
        a, b = positions[ends[0]], positions[ends[1]]
        d = [b[axis] - a[axis] for axis in range(3)]
        length = math.sqrt(sum(value * value for value in d))
        if length <= COINCIDENT_LENGTH_M or abs(frame['lengthM'] - length) > 1e-9 * length:
            raise ValueError(f'contact-rows: members[{index}].frame.lengthM must equal the node distance (> 1 nm)')
        if abs(sum(frame['x'][axis] * d[axis] for axis in range(3)) / length - 1) > 1e-9:
            raise ValueError(f'contact-rows: members[{index}].frame.x must point from the first to the second node')
        magnitude = math.sqrt(sum(value * value for value in a)) + math.sqrt(sum(value * value for value in b))
        if abs(frame['lengthM'] - length) > LENGTH_TOLERANCE * max(1.0, length) + ROUNDING_FLOOR * magnitude:
            raise ValueError(f'contact-rows: members[{index}].frame.lengthM differs from the node distance')
        if max(abs(frame['x'][axis] - d[axis] / length) for axis in range(3)) > FRAME_TOLERANCE + ROUNDING_FLOOR * magnitude / length:
            raise ValueError(f'contact-rows: members[{index}].frame.x differs from the unit node direction')
        axes = [frame[axis] for axis in 'xyz']
        gram = max(abs(sum(axes[i][k] * axes[j][k] for k in range(3)) - (1.0 if i == j else 0.0))
                   for i in range(3) for j in range(3))
        x, y, z = axes
        handed = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
        if gram > FRAME_TOLERANCE or max(abs(handed[k] - z[k]) for k in range(3)) > FRAME_TOLERANCE:
            raise ValueError(f'contact-rows: members[{index}].frame must be right-handed orthonormal')
    return max(row['frame']['lengthM'] for row in members)


def constraint_rows(np, nodes, contacts):
    """C (contacts x 6 nodes): translations only, global frame."""
    position = {node['number']: index for index, node in enumerate(nodes)}
    rows = np.zeros((len(contacts), 6 * len(nodes)))
    for row, contact in enumerate(contacts):
        normal = np.array(contact['normal'], dtype=float)
        if contact['kind'] == 'node-plane':
            start = 6 * position[contact['node']]
            rows[row, start:start + 3] = normal
        else:
            a, b = 6 * position[contact['nodeA']], 6 * position[contact['nodeB']]
            rows[row, a:a + 3] -= normal
            rows[row, b:b + 3] += normal
    return rows


def _positive_factor(np, matrix, failure):
    """Cholesky with a finite, strictly positive diagonal factor (same contract as beamAnalysis.py)."""
    if not np.isfinite(matrix).all() or np.any(np.diag(matrix) <= 0):
        raise ValueError(failure)
    try:
        factor = np.linalg.cholesky(matrix)
    except np.linalg.LinAlgError as error:
        raise ValueError(failure) from error
    if not np.isfinite(factor).all() or np.any(np.diag(factor) <= 0):
        raise ValueError(failure)
    return factor


def _symmetric(np, matrix, label, allow_zero=False):
    """Finite and symmetric within 1e-11 of its norm. allow_zero admits only an exactly zero matrix, which is
    symmetric; the caller must then refuse it physically (a zero stiffness is a mechanism, not a symmetry error)."""
    if not np.isfinite(matrix).all():
        raise ValueError(f'contact-numeric: non-finite {label}')
    norm = float(np.linalg.norm(matrix))
    if allow_zero and norm == 0 and not np.any(matrix):
        return matrix.copy()
    if not math.isfinite(norm) or norm <= 0 or np.linalg.norm(matrix - matrix.T) > norm * 1e-11:
        raise ValueError(f'contact-symmetry: invalid {label}')
    return (matrix + matrix.T) / 2


def _scales(np, flexibility, gaps, force_n):
    """Force scale F (N): the larger of |D f| (moments divided by the moment length) and the force that closes any
    single free gap on its own. Gap scale L (m): the larger of the free gaps and the displacement F produces at any
    single contact. Both are strictly positive."""
    diagonal = np.diag(flexibility)
    force_scale = max(float(np.linalg.norm(force_n)), float(np.max(np.abs(gaps) / diagonal)))
    if force_scale <= 0:
        # Unloaded with all gaps exactly closed: lambda = 0 and g = 0 is the solution; any positive scale decides it.
        force_scale = 1.0
    gap_scale = max(float(np.max(np.abs(gaps))), float(np.max(diagonal)) * force_scale)
    if not (math.isfinite(force_scale) and math.isfinite(gap_scale) and gap_scale > 0):
        raise ValueError('contact-numeric: non-finite or zero contact scales')
    return force_scale, gap_scale


def pivot_limit(contact_count):
    """Practical pivot bound (not a worst-case bound: Murty's method can need 2^m - 1 pivots on SPD matrices)."""
    return 4 * contact_count * contact_count + 16


def solve_complementarity(np, flexibility, gaps, force_scale, gap_scale, max_pivots):
    """Murty's least-index principal pivoting for g = h + G lambda, lambda >= 0, g >= 0, lambda . g = 0.

    G must be symmetric positive definite (checked by the caller), so exactly one solution exists. Returns
    (lambda, g, active, pivots). Raises contact-pivot-limit when max_pivots is reached before that solution is found;
    this is the practical limit of the method, not a statement that no solution exists."""
    count = gaps.size
    active = np.zeros(count, dtype=bool)
    lam_tolerance, gap_tolerance = PIVOT_TOLERANCE * force_scale, PIVOT_TOLERANCE * gap_scale
    for pivots in range(max_pivots + 1):
        lam = np.zeros(count)
        if active.any():
            block = flexibility[np.ix_(active, active)]
            factor = _positive_factor(np, block, 'contact-degenerate: active contact flexibility is not positive definite')
            lam[active] = np.linalg.solve(factor.T, np.linalg.solve(factor, -gaps[active]))
        gap = gaps + flexibility @ lam
        gap[active] = 0.0
        if not (np.isfinite(lam).all() and np.isfinite(gap).all()):
            raise ValueError('contact-numeric: non-finite complementarity iterate')
        wrong = [index for index in range(count)
                 if (active[index] and lam[index] < -lam_tolerance) or (not active[index] and gap[index] < -gap_tolerance)]
        if not wrong:
            return lam, gap, active, pivots
        if pivots == max_pivots:
            break
        active[wrong[0]] = not active[wrong[0]]
    raise ValueError(f'contact-pivot-limit: pivot limit {max_pivots} reached; the unique solution was not found '
                     'within the limit (this does not mean that no solution exists)')


def _solve_contact_system(np, plan, stiffness, moment_length_m, max_pivots=None, *, constant_force=None):
    """Static frictionless unilateral contact on the given global stiffness (N/m, N, N m units, 6 DOF per node).
    moment_length_m (m, > 0) converts rotational components (N m) to N for every norm.
    Internal constant_force is an optional full nodal force vector (N, N m), e.g. the
    negative initial resisting force of prescribed shank strain. It is never scaled
    by the external load factor. Public contact plans and the default route are unchanged."""
    nodes, contacts, factors = plan['nodes'], plan['contacts'], plan['loadFactors']
    positions = validate_nodes(nodes)
    validate_contacts(contacts, positions)
    validate_load_factors(factors)
    if not _positive(moment_length_m):
        raise ValueError('contact-scale: the moment length must be a positive length in m')
    size = 6 * len(nodes)
    free = np.array([6 * index + axis for index, node in enumerate(nodes)
                     for axis in range(6) if not node['restrained'][axis]], dtype=int)
    if free.size == 0:
        raise ValueError('contact-restraints: no free degrees of freedom')
    # D: 1 for translations, 1 / L_m for rotations, so D times a force-like vector is in N.
    to_newton = np.tile([1.0, 1.0, 1.0, 1 / moment_length_m, 1 / moment_length_m, 1 / moment_length_m], len(nodes))[free]
    stiffness = _symmetric(np, stiffness, 'global stiffness', allow_zero=True)
    k_free = _symmetric(np, stiffness[np.ix_(free, free)], 'restrained stiffness', allow_zero=True)
    k_diagonal = np.diag(k_free)
    if np.any(k_diagonal <= 0):
        raise ValueError('contact-mechanism: nonpositive stiffness diagonal')
    equilibration = 1 / np.sqrt(k_diagonal)
    equilibrated = _symmetric(np, equilibration[:, None] * k_free * equilibration[None, :], 'equilibrated stiffness')
    factor = _positive_factor(np, equilibrated,
                              'contact-mechanism: without its contacts the structure is an unstable or unresolved mechanism')
    values = np.linalg.eigvalsh(equilibrated)
    threshold = np.finfo(float).eps * free.size * np.linalg.norm(equilibrated, ord=np.inf) * 64
    if not np.isfinite(values).all() or values[0] <= threshold:
        raise ValueError('contact-mechanism: numerically unresolved restrained stiffness')

    def solve(right):
        """K_free^-1 right through the equilibrated Cholesky factor (right may be a matrix)."""
        scaled = equilibration[:, None] * right if right.ndim == 2 else equilibration * right
        result = np.linalg.solve(factor.T, np.linalg.solve(factor, scaled))
        return equilibration[:, None] * result if right.ndim == 2 else equilibration * result

    rows = constraint_rows(np, nodes, contacts)[:, free]
    if np.any(np.linalg.norm(rows, axis=1) <= UNIT_NORMAL_TOLERANCE):
        raise ValueError('contact-restrained: a contact acts only on restrained translations')
    compliance = solve(rows.T)
    flexibility = _symmetric(np, rows @ compliance, 'contact flexibility')
    degenerate = 'contact-degenerate: contact constraints are dependent (redundant pairs or planes)'
    _positive_factor(np, flexibility, degenerate)
    # Cholesky can succeed on an exactly singular G through rounding; the equilibrated spectrum decides, as for K.
    g_scale = 1 / np.sqrt(np.diag(flexibility))
    g_values = np.linalg.eigvalsh(g_scale[:, None] * flexibility * g_scale[None, :])
    if not np.isfinite(g_values).all() or g_values[0] <= np.finfo(float).eps * len(contacts) * 64:
        raise ValueError(degenerate)
    reference = np.array([value for node in nodes for value in node['load']], dtype=float)[free]
    free_reference = solve(reference)
    if constant_force is not None:
        if not _vector(constant_force, size) or any(abs(value) > MAX_LOAD_COMPONENT for value in constant_force):
            raise ValueError('contact-initial-force: bounded full nodal force vector required')
        initial_force = np.array(constant_force, dtype=float)[free]
    initial_gaps = np.array([contact['gapM'] for contact in contacts], dtype=float)
    budget = max_pivots if max_pivots is not None else pivot_limit(len(contacts))
    states = []
    for factor_value in factors:
        force = factor_value * reference
        unconstrained = factor_value * free_reference
        if constant_force is not None:
            force = force + initial_force
            if np.any(initial_force):
                unconstrained = solve(force)
        gaps = initial_gaps + rows @ unconstrained
        force_scale, gap_scale = _scales(np, flexibility, gaps, to_newton * force)
        lam, _, active, pivots = solve_complementarity(np, flexibility, gaps, force_scale, gap_scale, budget)
        displacement = unconstrained + compliance @ lam
        gap = initial_gaps + rows @ displacement
        contact_force = rows.T @ lam
        internal = to_newton * (k_free @ displacement)
        applied, reacting = to_newton * force, to_newton * contact_force
        denominator = float(np.linalg.norm(internal) + np.linalg.norm(applied) + np.linalg.norm(reacting))
        equilibrium = float(np.linalg.norm(internal - applied - reacting)) / denominator if denominator > 0 else 0.0
        penetration = max(0.0, -float(np.min(gap))) / gap_scale
        tension = max(0.0, -float(np.min(lam))) / force_scale
        complementarity = float(np.max(np.abs(lam * gap))) / (force_scale * gap_scale)
        if not math.isfinite(equilibrium) or equilibrium > EQUILIBRIUM_TOLERANCE:
            raise ValueError('contact-equilibrium: normalized equilibrium residual exceeded 1e-9')
        if not math.isfinite(penetration) or penetration > FEASIBILITY_TOLERANCE:
            raise ValueError('contact-penetration: a contact gap is negative beyond 1e-9 of the gap scale')
        if not math.isfinite(tension) or tension > FEASIBILITY_TOLERANCE:
            raise ValueError('contact-tension: a contact reaction is tensile beyond 1e-9 of the force scale')
        if not math.isfinite(complementarity) or complementarity > COMPLEMENTARITY_TOLERANCE:
            raise ValueError('contact-complementarity: lambda * gap exceeded 1e-9 of the force x gap scale')
        full = np.zeros(size)
        full[free] = displacement
        records = []
        for index, node in enumerate(nodes[:plan['originalNodeCount']]):
            block = full[6 * index:6 * index + 6]
            records.append({'number': node['number'], 'displacementM': block[:3].tolist(),
                            'rotationRad': block[3:].tolist()})
        states.append({'loadFactor': factor_value, 'pivots': int(pivots), 'nodes': records,
            'contacts': [{'id': contact['id'], 'state': 'closed' if bool(active[index]) else 'open',
                          'normalReactionN': float(lam[index]), 'gapM': float(gap[index])}
                         for index, contact in enumerate(contacts)],
            'forceScaleN': force_scale, 'gapScaleM': gap_scale, 'equilibriumResidual': equilibrium,
            'penetration': penetration, 'tension': tension, 'complementarity': complementarity})
    return {'schema': CONTACT_RESULT_SCHEMA, 'method': 'murty-least-index-lcp-on-native-beam3d-stiffness',
            'freeDofs': int(free.size), 'meshNodes': len(nodes), 'meshElements': len(plan['members']),
            'momentLengthM': moment_length_m, 'pivotLimit': budget, 'states': states}


def validate_contact_plan(plan):
    """Entry validation before any OOFEM object exists. Returns the moment length (largest member length, m)."""
    if not isinstance(plan, dict) or set(plan) != CONTACT_PLAN_FIELDS or plan['schema'] != CONTACT_PLAN_SCHEMA:
        raise ValueError('contact-shape: unsupported contact plan')
    positions = validate_nodes(plan['nodes'])
    count = plan['originalNodeCount']
    if not _integer(count) or not 1 <= count <= len(plan['nodes']):
        raise ValueError('contact-shape: originalNodeCount')
    moment_length = validate_native_rows(plan, positions)
    validate_contacts(plan['contacts'], positions)
    validate_load_factors(plan['loadFactors'])
    return moment_length


def run_beam_contact(plan=None, solve_system=None, *, solve_with_elements=None):
    """Native Beam3d K (as run_beam_transient) with the explicit contact solve above; no OOFEM contact engine."""
    import numpy as np
    import oofem as fem
    from oofem import util

    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('Unexpected fixed OOFEM/NumPy distribution')
    if plan is None:
        with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
            plan = json.load(stream)
    if solve_with_elements is not None and solve_system is not None:
        raise ValueError('contact-callback: choose one solver callback')
    if solve_system is None:
        solve_system = _solve_contact_system
    moment_length = validate_contact_plan(plan)
    problem = fem.linearStatic(nSteps=1, outFile='/pcad_fem/contact-matrices.out', suppress_output=True)
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
    primary_error = None
    try:
        # Only solveYourself starts the analysis timer that terminateAnalysis stops (engngm.C:578, 2027).
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        if problem.checkProblemConsistency() != 1:
            raise ValueError('OOFEM rejected contact structural consistency')
        problem.init()
        problem.postInitialize()
        problem.setRenumberFlag()
        step = problem.giveNextStep()
        size = 6 * len(nodes)
        stiffness = np.zeros((size, size))
        element_matrices = [] if solve_with_elements is not None else None
        for row, element in zip(plan['members'], elements, strict=True):
            native_k = fem.FloatMatrix()
            element.giveCharacteristicMatrix(native_k, fem.CharType.TangentStiffnessMatrix, step)
            local_k = _symmetric(np, np.array([[float(native_k[i, j]) for j in range(12)] for i in range(12)]),
                                 'native element stiffness')
            frame = np.array([row['frame'][axis] for axis in ('x', 'y', 'z')])
            if np.max(np.abs(frame @ frame.T - np.eye(3))) > 1e-10 or np.linalg.det(frame) < 0:
                raise ValueError('contact-frame: frame must be right-handed orthonormal')
            transform = np.kron(np.eye(4), frame)
            indices = [6 * (number - 1) + axis for number in row['nodes'] for axis in range(6)]
            stiffness[np.ix_(indices, indices)] += transform.T @ local_k @ transform
            if element_matrices is not None:
                element_matrices.append({'number': row['number'], 'indices': indices, 'localMatrix': local_k.copy()})
        if solve_with_elements is not None:
            return json.dumps(solve_with_elements(np, plan, stiffness, moment_length, element_matrices), allow_nan=False)
        return json.dumps(solve_system(np, plan, stiffness, moment_length), allow_nan=False)
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
