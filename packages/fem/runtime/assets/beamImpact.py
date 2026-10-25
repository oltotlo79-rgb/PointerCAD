"""Elastic compliant frictionless normal-contact dynamics on given M, K, C (task66 design d5dcd918, kernel only).

numerics-r3 successor of numerics-r2 e010d66a (Astra68 7e107ff7): there is no per-entry magnitude gate. Positive
products and quotients (energies, contact forces and tangents) are evaluated with exact exponent arithmetic, so no
intermediate underflow or overflow; an overflowing result is refused with impact-range. A strictly positive energy
contribution that is not representable to full precision is refused unless it is below half an ulp of a total of at
least 2**-1000; a nonzero velocity always needs a representable positive kinetic energy. Energy and momentum defects are
normalized by their largest finite term before adding, so finite terms cannot overflow the scale. The step matrix,
right-hand side, contact tangent, Jacobian, impulses, gaps and states are checked finite. Max-abs residual comparisons,
separate M and K validation scales and the admission bounds on sizes, steps and work are kept from bea83e8c.

Midpoint linear dynamics with the discrete-gradient contact force of phi(g) = k*min(g, 0)^2/2 per contact row, so that
E1 - E0 = fbar . (u1 - u0) for every step. Gaps g = g_initial + C u in m; k in N/m; u, v in the DOF units of M and K.
This module does not assemble native matrices and does not establish native free-body support. No damping, no
restitution. Exhausted caps and unrepresentable quantities raise; they never return success.
"""
import math

ENERGY_TOLERANCE = 1e-8          # normalized energy balance and discrete momentum residual (existing criterion)
SYMMETRY_TOLERANCE = 1e-12       # relative to each matrix's own largest magnitude
MAX_NEWTON_ITERATIONS = 50       # per step
MAX_BACKTRACKS = 30              # per Newton iteration, halving the step
MAX_FACTORIZATIONS = 200_000     # per analysis upper limit for the caller's cap
MAX_DOFS = 768                   # 128 nodes x 6 DOF, as the native contact/transient plans
MAX_CONTACT_ROWS = 64
MAX_STEPS = 4000                 # as the transient history
SMALLEST_NORMAL = 2.0 ** -1022   # below it a positive binary64 value has lost relative precision
NEGLIGIBLE_TOTAL = 2.0 ** -1000  # a total this large makes an imprecise term smaller than 2**-74 of it


def _is_real(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_count(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _require_finite(np, array, label):
    if not np.isfinite(array).all():
        raise ValueError('impact-number: ' + label + ' is not finite')


def _finite(value, label):
    if not math.isfinite(value):
        raise ValueError('impact-number: ' + label + ' is not finite')
    return value


def _scaled(numerators, denominators=()):
    """prod(numerators) / prod(denominators) for finite nonnegative numerators and finite positive denominators, with
    exponents added exactly so that no intermediate overflows or underflows. Overflow is refused; a final underflow
    returns the correctly rounded subnormal or zero, which callers needing a positive value check themselves."""
    mantissa, exponent = 1.0, 0
    for factor in numerators:
        if factor == 0:
            return 0.0
        part, power = math.frexp(factor)
        mantissa, extra = math.frexp(mantissa * part)
        exponent += power + extra
    for factor in denominators:
        part, power = math.frexp(factor)
        mantissa, extra = math.frexp(mantissa / part)
        exponent += extra - power
    try:
        value = math.ldexp(mantissa, exponent)
    except OverflowError as error:
        raise ValueError('impact-range: a positive energy, force or scale overflows binary64') from error
    if not math.isfinite(value):
        raise ValueError('impact-range: a positive energy, force or scale overflows binary64')
    return value


def _product(*factors):
    return _scaled(factors)


def _quadratic(np, matrix, vector):
    """(0.5 x^T A x, imprecise) for symmetric PSD A, evaluated on max-normalized A and x and rescaled exactly. An exact
    zero form (a K null mode) is a legitimate zero; imprecise marks a positive form that fell below SMALLEST_NORMAL."""
    scale_a = float(np.max(np.abs(matrix))) if matrix.size else 0.0
    scale_x = float(np.max(np.abs(vector))) if vector.size else 0.0
    if scale_a == 0 or scale_x == 0:
        return 0.0, False
    normalized = vector / scale_x
    q = float(normalized @ (matrix / scale_a) @ normalized)
    if not math.isfinite(q) or q < 0:
        raise ValueError('impact-number: quadratic form is not finite and nonnegative')
    if q == 0:
        return 0.0, False
    value = _product(0.5, q, scale_a, scale_x, scale_x)
    return value, value < SMALLEST_NORMAL


def potential(k, g):
    return _product(0.5, k, -g, -g) if g < 0 else 0.0


def endpoint_force(k, g):
    return _product(k, -g) if g < 0 else 0.0


def _crossing(negative, positive):
    """(scale, sum / scale) of negative + positive > 0 without overflow; sum / scale lies in [1, 2]."""
    scale = max(negative, positive)
    return scale, negative / scale + positive / scale


def secant_force(k, g0, g1):
    """lambdaBar = -(phi(g1) - phi(g0)) / (g1 - g0) (lambda(g0) for equal gaps), without overflow of sums or differences
    and without underflow before the final rounding. Crossing: k * n^2 / (2 (n + p)) for n = -min, p = max."""
    if g0 == g1:
        return endpoint_force(k, g0)
    if g0 >= 0 and g1 >= 0:
        return 0.0
    if g0 <= 0 and g1 <= 0:
        return _product(k, -(g0 / 2 + g1 / 2))
    negative, positive = (-g0, g1) if g0 < 0 else (-g1, g0)
    return _scaled((k, negative, negative, 0.5), _crossing(negative, positive))


def secant_derivative(k, g0, g1):
    """d lambdaBar / d g1 (nonpositive). g0 = 0 uses the one-sided branch selected by g1. Opening (g0 < 0 < g1):
    -(k/2) r^2; closing (g1 < 0 < g0): -(k/2) r (2 - r); r = n / (n + p) evaluated as an exact-exponent quotient."""
    if g0 == g1:
        return -k / 2 if g0 < 0 else 0.0
    if g0 <= 0 and g1 <= 0:
        return -k / 2
    if g0 >= 0 and g1 >= 0:
        return 0.0
    if g0 < 0 < g1:
        scale, total = _crossing(-g0, g1)
        return -_scaled((k, 0.5, -g0, -g0), (scale, total, scale, total))
    scale, total = _crossing(-g1, g0)
    r = _scaled((-g1,), (scale, total))
    return -_scaled((k, 0.5, -g1, 2 - r), (scale, total))


def balance_ratio(values):
    """|sum(values)| / sum(|values|) for finite values, on values divided by their largest magnitude so that finite
    terms never overflow the sum; None when every value is zero."""
    values = [_finite(float(value), 'balance term') for value in values]
    scale = max(abs(value) for value in values)
    if scale == 0:
        return None
    scaled = [value / scale for value in values]
    return abs(math.fsum(scaled)) / math.fsum(abs(value) for value in scaled)


def _vector_balance_ratio(np, terms):
    """||sum(terms)||_inf / sum(||term||_inf) with every term divided by the largest norm first; None when all zero."""
    norms = [_inf_norm(np, term) for term in terms]
    scale = max(norms)
    if scale == 0:
        return None
    residual = _inf_norm(np, sum(term / scale for term in terms))
    return residual / math.fsum(norm / scale for norm in norms)


def _inf_norm(np, vector):
    value = float(np.max(np.abs(vector))) if vector.size else 0.0
    return _finite(value, 'norm')


def _validate_matrix(np, matrix, label, definite):
    scale = float(np.max(np.abs(matrix)))
    if scale == 0:
        if definite:
            raise ValueError('impact-mass: mass is not positive definite')
        return
    normalized = matrix / scale
    if float(np.max(np.abs(normalized - normalized.T))) > SYMMETRY_TOLERANCE:
        raise ValueError('impact-matrix: ' + label + ' must be symmetric')
    symmetric = (normalized + normalized.T) / 2
    if definite:
        try:
            factor = np.linalg.cholesky(symmetric)
        except np.linalg.LinAlgError as error:
            raise ValueError('impact-mass: mass is not positive definite') from error
        if not np.isfinite(factor).all() or float(np.min(np.abs(np.diag(factor)))) <= 0:
            raise ValueError('impact-mass: mass is not positive definite')
    else:
        values = np.linalg.eigvalsh(symmetric)
        if not np.isfinite(values).all() or float(np.min(values)) < -SYMMETRY_TOLERANCE:
            raise ValueError('impact-stiffness-matrix: K is not positive semidefinite')


def validate_system(np, mass, stiffness, rows, gaps, k):
    mass, stiffness = np.asarray(mass, dtype=float), np.asarray(stiffness, dtype=float)
    rows, gaps = np.asarray(rows, dtype=float), np.asarray(gaps, dtype=float)
    if mass.ndim != 2 or mass.shape[0] != mass.shape[1] or not 1 <= mass.shape[0] <= MAX_DOFS:
        raise ValueError('impact-shape: M must be square with 1 to 768 DOFs')
    size = mass.shape[0]
    if stiffness.shape != (size, size) or rows.ndim != 2 or rows.shape[1] != size or not 0 <= rows.shape[0] <= MAX_CONTACT_ROWS \
            or gaps.shape != (rows.shape[0],):
        raise ValueError('impact-shape: K, contact rows and gaps differ from the DOFs')
    if not (_is_real(k) and math.isfinite(k) and k > 0):
        raise ValueError('impact-stiffness: contact stiffness must be finite and positive in N/m')
    for array, label in ((mass, 'mass'), (stiffness, 'stiffness'), (rows, 'contact rows'), (gaps, 'initial gaps')):
        _require_finite(np, array, label)
    _validate_matrix(np, mass, 'M', True)
    _validate_matrix(np, stiffness, 'K', False)
    return (mass + mass.T) / 2, (stiffness + stiffness.T) / 2, rows, gaps


def step(np, mass, stiffness, rows, gaps0, k, u0, v0, fbar, h, budget):
    """One midpoint step. budget is a one-element list holding the remaining factorizations (decremented)."""
    a_matrix = 4 * mass / (h * h) + stiffness
    rhs = (4 * mass / (h * h) - stiffness) @ u0 + (4 * mass / h) @ v0 + 2 * fbar
    for array, label in ((a_matrix, 'step matrix'), (rhs, 'step right-hand side')):
        if not np.isfinite(array).all():
            raise ValueError('impact-range: ' + label + ' is not representable')
    g0 = gaps0 + rows @ u0

    def residual(u1):
        g1 = gaps0 + rows @ u1
        lam = np.array([secant_force(k, a, b) for a, b in zip(g0, g1)], dtype=float).reshape(rows.shape[0])
        value = a_matrix @ u1 - rhs - 2 * rows.T @ lam
        if not (np.isfinite(g1).all() and np.isfinite(value).all()):
            raise ValueError('impact-number: nonfinite step residual')
        return value, g1, lam

    def converged(u1, value, lam):
        scale = max(_inf_norm(np, a_matrix @ u1), _inf_norm(np, rhs), _inf_norm(np, 2 * rows.T @ lam))
        norm = _inf_norm(np, value)
        return norm == 0.0 or (scale > 0 and norm <= 1e-14 * scale), norm

    u1 = u0 + h * v0
    value, g1, lam = residual(u1)
    for iteration in range(MAX_NEWTON_ITERATIONS + 1):
        done, norm = converged(u1, value, lam)
        if done:
            return u1, 2 * (u1 - u0) / h - v0, g1, lam, iteration
        if iteration == MAX_NEWTON_ITERATIONS:
            break
        if budget[0] <= 0:
            raise ValueError('impact-work: the factorization cap is exhausted')
        budget[0] -= 1
        slope = np.array([secant_derivative(k, a, b) for a, b in zip(g0, g1)], dtype=float).reshape(rows.shape[0])
        jacobian = a_matrix - 2 * rows.T @ (slope[:, None] * rows)
        if not np.isfinite(jacobian).all():
            raise ValueError('impact-range: step Jacobian is not representable')
        try:
            delta = np.linalg.solve(jacobian, -value)
        except np.linalg.LinAlgError as error:
            raise ValueError('impact-conditioning: singular step Jacobian') from error
        if not np.isfinite(delta).all():
            raise ValueError('impact-conditioning: nonfinite Newton step')
        length = 1.0
        for _ in range(MAX_BACKTRACKS):
            trial = u1 + length * delta
            trial_value, trial_g, trial_lam = residual(trial)
            if _inf_norm(np, trial_value) < norm:
                break
            length /= 2
        else:
            raise ValueError('impact-convergence: no residual reduction along the Newton step')
        u1, value, g1, lam = trial, trial_value, trial_g, trial_lam
    raise ValueError('impact-convergence: Newton iteration cap reached')


def energy(np, mass, stiffness, rows, gaps0, k, u, v):
    """Total energy; refuses an unrepresentable positive kinetic, structural or contact contribution (never a false 0)."""
    g = gaps0 + rows @ u
    if not np.isfinite(g).all():
        raise ValueError('impact-number: gap is not finite')
    kinetic, kinetic_imprecise = _quadratic(np, mass, v)
    # M is positive definite: any nonzero velocity has strictly positive kinetic energy, which must be representable.
    if kinetic == 0 and float(np.max(np.abs(v))) > 0:
        raise ValueError('impact-range: a nonzero velocity has no representable positive kinetic energy')
    structural, structural_imprecise = _quadratic(np, stiffness, u)
    contacts = [potential(k, item) for item in g]
    contact_imprecise = any(item < 0 and value < SMALLEST_NORMAL for item, value in zip(g, contacts))
    total = kinetic + structural + sum(contacts)
    if not math.isfinite(total):
        raise ValueError('impact-range: the total energy overflows binary64')
    if (kinetic_imprecise or structural_imprecise or contact_imprecise) and total < NEGLIGIBLE_TOTAL:
        raise ValueError('impact-range: a positive energy contribution is not representable to full precision')
    return total


def integrate(np, mass, stiffness, rows, gaps0, k, v0, force_at, h, steps, factorization_cap=MAX_FACTORIZATIONS):
    """Integrate from u = 0 with initial velocity v0; force_at(t) gives the external force vector of exact shape (n,).
    Returns every step and the all-step maxima of the normalized energy and momentum defects."""
    if not (_is_count(steps) and 1 <= steps <= MAX_STEPS):
        raise ValueError('impact-step: the step count must be an integer from 1 to 4000')
    if not (_is_count(factorization_cap) and 0 <= factorization_cap <= MAX_FACTORIZATIONS):
        raise ValueError('impact-budget: the factorization cap must be an integer from 0 to 200000')
    if not (_is_real(h) and math.isfinite(h) and h > 0):
        raise ValueError('impact-step: time step must be finite and positive')
    if not all(math.isfinite(value) and value > 0 for value in (h * h, 4 / (h * h), 4 / h, h / 2, steps * h)):
        raise ValueError('impact-step: time step coefficients or horizon are not representable')
    mass, stiffness, rows, gaps0 = validate_system(np, mass, stiffness, rows, gaps0, k)
    size = mass.shape[0]
    v0 = np.asarray(v0, dtype=float)
    if v0.shape != (size,):
        raise ValueError('impact-shape: initial velocity differs from the DOFs')
    _require_finite(np, v0, 'initial velocity')

    def force(time):
        value = np.asarray(force_at(time), dtype=float)
        if value.shape != (size,):
            raise ValueError('impact-shape: force vector differs from the DOFs')
        _require_finite(np, value, 'force')
        return value

    budget = [factorization_cap]
    u, v = np.zeros(size), v0.copy()
    f_previous = force(0.0)
    initial_energy = energy(np, mass, stiffness, rows, gaps0, k, u, v)   # refuses an unrepresentable positive E0
    states = [{'timeS': 0.0, 'u': u.copy(), 'v': v.copy(), 'gaps': gaps0 + rows @ u, 'intervalForce': None,
               'impulse': None, 'energy': initial_energy, 'work': 0.0}]
    work, energy_error, momentum_error = 0.0, 0.0, 0.0
    for index in range(1, steps + 1):
        time = _finite(index * h, 'time')
        f_next = force(time)
        fbar = f_previous / 2 + f_next / 2
        u_next, v_next, g_next, lam, _ = step(np, mass, stiffness, rows, gaps0, k, u, v, fbar, h, budget)
        if not (np.isfinite(u_next).all() and np.isfinite(v_next).all()):
            raise ValueError('impact-number: nonfinite state')
        impulse = h * lam
        for array, label in ((g_next, 'gaps'), (lam, 'contact force'), (impulse, 'impulse')):
            _require_finite(np, array, label)
        work = _finite(work + float(fbar @ (u_next - u)), 'work')
        e_next = energy(np, mass, stiffness, rows, gaps0, k, u_next, v_next)
        ratio = balance_ratio((e_next, -initial_energy, -work))
        if ratio is None:
            if float(np.max(np.abs(u_next))) != 0 or float(np.max(np.abs(v_next))) != 0:
                raise ValueError('impact-range: nonzero motion with no representable energy')
        else:
            energy_error = max(energy_error, ratio)
        terms = (mass @ (v_next - v) / h, stiffness @ (u / 2 + u_next / 2), -(rows.T @ lam), -fbar)
        balance = _vector_balance_ratio(np, terms)
        if balance is not None:
            momentum_error = max(momentum_error, balance)
        u, v, f_previous = u_next, v_next, f_next
        states.append({'timeS': time, 'u': u.copy(), 'v': v.copy(), 'gaps': g_next, 'intervalForce': lam,
                       'impulse': impulse, 'energy': e_next, 'work': work})
    if energy_error > ENERGY_TOLERANCE or momentum_error > ENERGY_TOLERANCE:
        raise ValueError('impact-balance: normalized energy or momentum defect exceeds 1e-8')
    return {'states': states, 'maximumEnergyBalanceError': energy_error, 'maximumMomentumResidual': momentum_error,
            'initialEnergyJ': initial_energy, 'externalWorkJ': work, 'factorizationsUsed': factorization_cap - budget[0]}


IMPACT_PLAN_SCHEMA = 'pointercad-oofem-impact-plan/1'
IMPACT_RESULT_SCHEMA = 'pointercad-oofem-impact-result/1'
IMPACT_FIELDS = {'timeStepS', 'stepCount', 'outputEvery', 'contactStiffnessNPerM', 'initialVelocity', 'contacts'}
CONTACT_FIELDS = {'node', 'directionUnit', 'gapM'}
MAX_IMPACT_SAMPLES = 101


def _real_list(value, length):
    return isinstance(value, list) and len(value) == length and all(_is_real(item) and math.isfinite(item) for item in value)


def validate_impact_plan(plan):
    """Strict impact section of an impact plan. No external load exists in this schema: the response is driven only by
    the initial velocity, and the buckling/transient load rules are not involved (no dummy load)."""
    if plan.get('schema') != IMPACT_PLAN_SCHEMA or not isinstance(plan.get('nodes'), list) or not 2 <= len(plan['nodes']) <= 128:
        raise ValueError('Unsupported bounded impact numeric plan')
    impact = plan.get('impact')
    if not isinstance(impact, dict) or set(impact) != IMPACT_FIELDS:
        raise ValueError('impact-plan: the impact section must have exactly the documented fields')
    step_s, count, every = impact['timeStepS'], impact['stepCount'], impact['outputEvery']
    if not (_is_real(step_s) and math.isfinite(step_s) and step_s > 0):
        raise ValueError('impact-step: time step must be finite and positive')
    if not (_is_count(count) and 1 <= count <= MAX_STEPS and _is_count(every) and 1 <= every <= count):
        raise ValueError('impact-step: step count 1 to 4000 and output interval 1 to the step count')
    if -(-count // every) + 1 > MAX_IMPACT_SAMPLES:
        raise ValueError('impact-step: at most 101 output samples')
    k = impact['contactStiffnessNPerM']
    if not (_is_real(k) and math.isfinite(k) and k > 0):
        raise ValueError('impact-stiffness: contact stiffness must be finite and positive in N/m')
    nodes = plan['nodes']
    velocity = impact['initialVelocity']
    if not (isinstance(velocity, list) and len(velocity) == len(nodes) and all(_real_list(row, 6) for row in velocity)):
        raise ValueError('impact-velocity: one finite six-component initial velocity per plan node')
    for node, row in zip(nodes, velocity):
        if any(restrained and value != 0 for restrained, value in zip(node['restrained'], row)):
            raise ValueError('impact-velocity: a restrained DOF has a nonzero initial velocity')
    contacts = impact['contacts']
    if not (isinstance(contacts, list) and 1 <= len(contacts) <= MAX_CONTACT_ROWS):
        raise ValueError('impact-contact: 1 to 64 contacts')
    for contact in contacts:
        if not (isinstance(contact, dict) and set(contact) == CONTACT_FIELDS and _is_count(contact['node'])
                and 1 <= contact['node'] <= len(nodes) and _real_list(contact['directionUnit'], 3)
                and _is_real(contact['gapM']) and math.isfinite(contact['gapM']) and contact['gapM'] >= 0):
            raise ValueError('impact-contact: node number, finite unit direction and nonnegative initial gap')
        if abs(math.hypot(*contact['directionUnit']) - 1) > 1e-12:
            raise ValueError('impact-contact: contact direction must be a unit vector')
    return impact


def _disjoint_element_plan(plan):
    """Every plan member with its own two nodes (same positions and restraint flags, numbered 2i+1 and 2i+2). The
    native matrices of this plan from _native_beam3d_matrices are block diagonal: block i is exactly member i's global
    12 x 12 element stiffness T^T k T, extracted by the same native element and frame as the assembled K."""
    by_number = {node['number']: node for node in plan['nodes']}
    nodes, members = [], []
    for index, member in enumerate(plan['members']):
        pair = []
        for end, number in enumerate(member['nodes']):
            source = by_number[number]
            nodes.append({'number': 2 * index + end + 1, 'positionM': list(source['positionM']),
                          'restrained': list(source['restrained'])})
            pair.append(2 * index + end + 1)
        members.append({**member, 'number': index + 1, 'nodes': pair})
    return {'nodes': nodes, 'materials': plan['materials'], 'sections': plan['sections'], 'members': members}


def _element_blocks(np, stiffness, plan, element_stiffness):
    """Validated per-member global element stiffness blocks; they must reassemble the native K they came from."""
    members = plan['members']
    blocks = [np.asarray(block, dtype=float) for block in element_stiffness]
    if len(blocks) != len(members) or any(block.shape != (12, 12) for block in blocks):
        raise ValueError('impact-element: one 12 x 12 global element stiffness per plan member')
    assembled = np.zeros(stiffness.shape)
    for member, block in zip(members, blocks):
        _require_finite(np, block, 'element stiffness')
        indices = [6 * (number - 1) + axis for number in member['nodes'] for axis in range(6)]
        assembled[np.ix_(indices, indices)] += block
    scale = max(float(np.max(np.abs(stiffness))), 1e-300)
    if float(np.max(np.abs(assembled - stiffness))) > 1e-12 * scale:
        raise ValueError('impact-element: element blocks do not reassemble the native stiffness')
    return blocks


def solve_impact_plan(np, plan, stiffness, mass, element_stiffness=None):
    """Restricted, D-normalized impact response from global native K and M (6 DOFs per node, global frame).

    With element_stiffness (one global 12 x 12 block per plan member that reassembles K) every sample also carries the
    displacement and rotation of every mesh node ('mesh', plan order, SI, global axes) and the reply carries the blocks
    ('elements'), so the elastic element end forces K_e u_e of this solution can be recovered at the emitted samples.
    Without it the reply is unchanged.

    Gap of contact c: g = gapM - directionUnit . u(node), u = D q with D = diag(L, L, L, 1, 1, 1) per node as in the
    transient path, so the kernel row is -directionUnit * L on the node's free translations. Energies in q are the
    physical energies (q^T D M D q). Restraints must leave no mechanism: no native free-body claim is made."""
    impact = validate_impact_plan(plan)
    nodes = plan['nodes']
    size = 6 * len(nodes)
    stiffness, mass = np.asarray(stiffness, dtype=float), np.asarray(mass, dtype=float)
    if stiffness.shape != (size, size) or mass.shape != (size, size):
        raise ValueError('impact-shape: native matrices differ from 6 DOFs per plan node')
    _require_finite(np, stiffness, 'native stiffness')
    _require_finite(np, mass, 'native mass')
    blocks = None if element_stiffness is None else _element_blocks(np, stiffness, plan, element_stiffness)
    length = plan['normalizationLengthM']
    if not (_is_real(length) and math.isfinite(length) and length > 0):
        raise ValueError('impact-plan: normalization length must be finite and positive')
    free = np.array([6 * index + axis for index, node in enumerate(nodes)
                     for axis in range(6) if not node['restrained'][axis]], dtype=int)
    if free.size == 0:
        raise ValueError('impact-restraints: no free degrees of freedom')
    diagonal = np.tile([length, length, length, 1.0, 1.0, 1.0], len(nodes))
    scaled_k = (diagonal[:, None] * stiffness * diagonal[None, :])[np.ix_(free, free)]
    scaled_m = (diagonal[:, None] * mass * diagonal[None, :])[np.ix_(free, free)]
    k_diagonal = np.diag(scaled_k)
    if np.any(k_diagonal <= 0):
        raise ValueError('impact-mechanism: nonpositive stiffness diagonal')
    equilibration = 1 / np.sqrt(k_diagonal)
    equilibrated = equilibration[:, None] * scaled_k * equilibration[None, :]
    values = np.linalg.eigvalsh((equilibrated + equilibrated.T) / 2)
    threshold = np.finfo(float).eps * free.size * np.linalg.norm(equilibrated, ord=np.inf) * 64
    if not np.isfinite(values).all() or values[0] <= threshold:
        raise ValueError('impact-mechanism: supports leave an unstable or unresolved mechanism')
    position = {int(dof): column for column, dof in enumerate(free)}
    rows = np.zeros((len(impact['contacts']), free.size))
    for index, contact in enumerate(impact['contacts']):
        base = 6 * (contact['node'] - 1)
        for axis, component in enumerate(contact['directionUnit']):
            if base + axis in position:
                rows[index, position[base + axis]] = -component * length
        if not np.any(rows[index] != 0):
            raise ValueError('impact-contact: the contact direction is fully restrained')
    gaps = np.array([contact['gapM'] for contact in impact['contacts']], dtype=float)
    v0 = (np.array([value for row in impact['initialVelocity'] for value in row], dtype=float) / diagonal)[free]
    if not np.any(v0 != 0):
        raise ValueError('impact-velocity: the initial velocity is zero on every free DOF')
    result = integrate(np, scaled_m, scaled_k, rows, gaps, impact['contactStiffnessNPerM'], v0,
                       lambda time: np.zeros(free.size), impact['timeStepS'], impact['stepCount'])
    every, count = impact['outputEvery'], impact['stepCount']

    def record(index, state):
        full = np.zeros((2, size))
        full[0, free], full[1, free] = state['u'], state['v']
        full *= diagonal[None, :]
        rows_out = []
        for node_index, node in enumerate(nodes[:plan['originalNodeCount']]):
            block = full[:, 6 * node_index:6 * node_index + 6]
            rows_out.append({'number': node['number'],
                             'displacementM': block[0, :3].tolist(), 'rotationRad': block[0, 3:].tolist(),
                             'velocityMPerS': block[1, :3].tolist(), 'angularVelocityRadPerS': block[1, 3:].tolist()})
        contacts = [{'gapM': float(gap),
                     'intervalForceN': None if state['intervalForce'] is None else float(state['intervalForce'][c]),
                     'impulseNs': None if state['impulse'] is None else float(state['impulse'][c])}
                    for c, gap in enumerate(state['gaps'])]
        sample = {'step': index, 'timeS': state['timeS'], 'energyJ': state['energy'], 'nodes': rows_out,
                  'contacts': contacts}
        if blocks is not None:
            sample['mesh'] = [{'number': node['number'], 'displacementM': full[0, 6 * i:6 * i + 3].tolist(),
                               'rotationRad': full[0, 6 * i + 3:6 * i + 6].tolist()} for i, node in enumerate(nodes)]
        return sample

    states = result['states']
    samples = [record(index, states[index]) for index in range(count + 1) if index % every == 0 or index == count]
    forces = np.array([state['intervalForce'] for state in states[1:]])
    peak_step = np.argmax(forces, axis=0)
    total_impulse = [math.fsum(float(state['impulse'][c]) for state in states[1:]) for c in range(rows.shape[0])]
    reply = {'schema': IMPACT_RESULT_SCHEMA, 'samples': samples, 'normalizationLengthM': length,
            'meshNodes': len(nodes), 'meshElements': len(plan['members']), 'freeDofs': int(free.size),
            'initialEnergyJ': result['initialEnergyJ'],
            'maximumEnergyBalanceError': result['maximumEnergyBalanceError'],
            'maximumMomentumResidual': result['maximumMomentumResidual'],
            'factorizationsUsed': result['factorizationsUsed'],
            'contactPeaks': [{'intervalForceN': float(forces[peak_step[c], c]),
                              'timeS': states[int(peak_step[c]) + 1]['timeS'], 'totalImpulseNs': total_impulse[c]}
                             for c in range(rows.shape[0])]}
    if blocks is not None:
        reply['elements'] = [{'number': member['number'], 'nodes': list(member['nodes']), 'globalStiffness': block.tolist()}
                             for member, block in zip(plan['members'], blocks)]
    return reply


def run_beam_impact():
    """Native Beam3d K and M (+ rotary inertia) from the shared extraction in beam_analysis, with the explicit NumPy
    midpoint/discrete-gradient contact integration above. Not an OOFEM contact or dynamics engine; frictionless
    compliant normal contact against fixed planes, undamped, no restitution, no external load, zero initial
    displacement. The problem is created before the try so that terminateAnalysis always runs."""
    import json
    import numpy as np
    import oofem as fem
    from oofem import util
    from importlib.metadata import version
    from beam_analysis import _native_beam3d_matrices, _native_beam3d_problem

    if version('oofem') != '3.1.dev5+g214b161ed' or np.__version__ != '2.2.5':
        raise ValueError('Unexpected fixed OOFEM/NumPy distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    validate_impact_plan(plan)
    # Per-element blocks first, in their own problem that is terminated before the assembled problem is created.
    element_problem = _native_beam3d_problem(fem, '/pcad_fem/impact-element-matrices.out')
    try:
        separated, _ = _native_beam3d_matrices(np, fem, util, element_problem, _disjoint_element_plan(plan),
                                               'OOFEM rejected impact element extraction')
    finally:
        element_problem.terminateAnalysis()
    element_stiffness = [separated[12 * i:12 * i + 12, 12 * i:12 * i + 12] for i in range(len(plan['members']))]
    problem = _native_beam3d_problem(fem, '/pcad_fem/impact-matrices.out')
    primary_error = None
    try:
        stiffness, mass = _native_beam3d_matrices(np, fem, util, problem, plan,
                                                  'OOFEM rejected impact structural consistency')
        return json.dumps(solve_impact_plan(np, plan, stiffness, mass, element_stiffness), allow_nan=False)
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
