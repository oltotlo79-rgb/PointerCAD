"""Quasi-static Coulomb friction for the node-plane and node-pair Beam3d contacts (CANDIDATE core, EX-09.02).

Scope: the small-displacement linear elastic Beam3d frames and the contact kinematics of beamContact.py, which this
module imports read-only (that module, its frictionless route, the contact plan schema and its result schema are
unchanged). This is an internal numerical core: no plan field, result schema, TypeScript union, saved file, UI or
help content uses it yet.

Kinematics. Each contact i keeps the global unit normal n of beamContact (its sign, its declared gap g0 >= 0 in m and
the pair orientation A -> B). Two tangents complete a right-handed orthonormal frame: t1 is the unit projection
orthogonal to n of the global axis least aligned with n (lowest index on ties), t2 = n x t1. With the rows
(plane: the vector at P; pair: minus the vector at A, plus the vector at B, the same rows as constraint_rows)
  g = g0 + n . u_rel,   s = (t1 . u_rel, t2 . u_rel)     u_rel = u_P or u_B - u_A   (m)
and the contact force p = (lambda, t_1, t_2) (N) acting on P (plane) or on B (pair; the opposite force on A),
  equilibrium  K u = f + R^T p.

Laws at the end of each load step k, with the step increment delta_s = s_k - s_{k-1} (backward Euler along the load
path; the first step starts from the unloaded state u = 0):
  normal       g >= 0, lambda >= 0, lambda g = 0                                   (unchanged from beamContact)
  stick        delta_s = 0 and |t| <= mu lambda
  slip         t = -mu lambda delta_s / |delta_s|,  delta_s != 0
mu is the explicit coefficient of each contact, a finite number >= 0; there is no default and no material lookup.
For mu = 0 the tangential rows are omitted, so the problem is exactly the frictionless one of beamContact.
The law is NON-ASSOCIATED: slip does not change the normal gap. An associated flow rule on the Coulomb cone would open
the contact by mu |delta_s| while it slips (a false normal dilatancy); that is not Coulomb friction and is not
produced here (P. Wriggers, Computational Contact Mechanics, 2nd ed., Springer 2006, the chapter on constitutive
equations for contact interfaces; A. Klarbring, Ing.-Arch. 60 (1990) 529-541, examples of non-uniqueness and
non-existence of quasi-static frictional solutions).

Reduction. With u0 = K^-1 f, the contact flexibility W = R K^-1 R^T (normal and tangential rows of all contacts, so the
normal-tangential coupling of K is kept) and the previous step's s_{k-1}, every step is the finite-dimensional
problem y = h + W p, y = (g, delta_s) per contact, h = (g0 + n.u0_rel, t.u0_rel - s_{k-1}), under the laws above
(the local-global form of M. Jean, Comput. Methods Appl. Mech. Engrg. 177 (1999) 235-257, and of V. Acary and
B. Brogliato, Numerical Methods for Nonsmooth Dynamical Systems, Springer 2008). W must be positive definite (independent rows): two frictional contacts on the same translations are refused.

Two solvers, selectable, never mixed:
  'newton'  semi-smooth Newton on the Alart-Curnier augmented Lagrangian equations (P. Alart and A. Curnier, Comput.
            Methods Appl. Mech. Engrg. 92 (1991) 353-375; the semi-smooth Newton / primal-dual active set reading of
            S. Hueeber, G. Stadler and B. Wohlmuth, SIAM J. Sci. Comput. 30 (2008) 572-596, doi:10.1137/060671061)
            with an Armijo
            backtracking on |Phi|^2; the normal radius is mu [lambda - r g]_+, the non-associated form.
  'nsgs'    nonlinear block Gauss-Seidel over contacts with an exact local Coulomb solution (F. Jourdan, P. Alart and
            M. Jean, Comput. Methods Appl. Mech. Engrg. 155 (1998) 31-47, doi:10.1016/S0045-7825(97)00137-0).
            The local problem is solved by cases: open; stick (3x3 linear solve); slip, a one-dimensional root in
            the slip angle located by periodic sampling and refined by bisection. A tangential (double) root without
            a sign change is not found; then no local solution is reported and the step fails.
Neither solver is the acceptance test. After a solver stops, check_step evaluates from the displacement itself and
independently: force equilibrium, non-penetration, no adhesion, normal complementarity, the friction cone, the slip
direction law (or a zero increment in stick) and the non-negative dissipation of the step. Reaching an iteration or
sweep limit, a singular Newton matrix, a failed line search, a missing or ambiguous local solution or any residual
above its threshold raises ValueError; no approximate state is ever returned as converged.

Scales. Normal and tangential directions are measured separately, each contact in its own physical units, so a soft
direction is converted through its own flexibility. Each contact uses its own fixed step force scale F_i (N):
max(max(0, -h_n) / W_nn, |M^-1 h_t|), with 1 N only if both demands are exactly zero. Positive free gap is not a
closing force. A different, mechanically uncoupled contact cannot change F_i. Here F below means F_i, W_nn (m/N)
is this contact's normal flexibility and M (m/N, 2x2) its tangential block of W. These scales depend on the prescribed
load and previous accepted displacement, never on a trial reaction or displacement. They can be conservative when
contacts couple; a failed independent check remains a failure, not a reason to increase F_i.
forceScaleN and gapScaleM are aggregate reporting values only; neither controls acceptance or contact status.
Equilibrium is checked per free DOF against its own absolute K u, f and R^T p contributions, so an unrelated loaded
DOF cannot hide a force imbalance. The contact checks use:
  normal       a gap g is converted to the force that closes it, g / W_nn; penetration is max(0, -g) / W_nn <= tol F
               and complementarity |lambda g| <= tol F max(W_nn F, |g|)
  tangential   a slip increment delta_s is converted to the force that produces it, |M^-1 delta_s| (N), invariant under
               the choice of t1, t2; it is a zero increment (stick) when |M^-1 delta_s| <= tol F
  Newton       separate augmentation radii r_n = 1 / W_nn and r_t = 2 / trace M (S. Hueeber, G. Stadler and
               B. Wohlmuth use separate c_n and c_tau); the stopping test, the condition check and the linear solve
               use the same force-equivalent rows (a row transform: the Newton step itself is unchanged).
A single radius or gap scale built from the largest flexibility of all rows (the previous candidate) let a soft,
unloaded tangent hide a 10 N normal penetration and a wrong 2 N sliding friction (review counterexamples 2026-10-29).

Known limits (not handled, refused or reported, never approximated): large mu can make the quasi-static problem
non-unique or without solution (Klarbring 1990); the solvers report the solution they find and do not prove
uniqueness. Within one load step the contact status is the end-of-step status (backward Euler): a contact that
closes during a step sticks to the position it had at the start of the step. Corner contacts (several frictional
contacts on one node) are refused as dependent rows. Large displacement, rate effects, static/kinetic mu, anisotropic
friction and dynamics are outside this core.

Units: m, N, N m, J. Rotational force components are divided by the moment length L_m (m) before norms, as in
beamContact.py.
"""
import math

from beamContact import (
    MAX_LOAD_COMPONENT,
    MAX_LOAD_FACTORS,
    UNIT_NORMAL_TOLERANCE,
    _number,
    _positive,
    _positive_factor,
    _symmetric,
    _vector,
    constraint_rows,
    validate_contacts,
    validate_load_factors,
    validate_nodes,
)

FRICTION_RESULT_KIND = 'pointercad-internal-friction-contact-candidate'
SOLVERS = ('newton', 'nsgs')
DEFAULT_NEWTON_ITERATIONS = 64
DEFAULT_NSGS_SWEEPS = 20000
# Acceptance thresholds, dimensionless, fixed before any execution; they multiply the force scale F (N) of each step
# (_scales) and the per-contact normal and tangential flexibilities (see Scales above). Same values as beamContact.py.
EQUILIBRIUM_TOLERANCE = 1e-9
FEASIBILITY_TOLERANCE = 1e-9   # max(0, -g) / W_nn <= tol F, max(0, -lambda) <= tol F
COMPLEMENTARITY_TOLERANCE = 1e-9
CONE_TOLERANCE = 1e-9          # |t| - mu lambda <= tol F
SLIP_LAW_TOLERANCE = 1e-9      # |t + mu lambda delta_s/|delta_s|| <= tol F when the increment is not zero
STICK_TOLERANCE = 1e-9         # |M^-1 delta_s| <= tol F is a zero increment (stick)
DISSIPATION_TOLERANCE = 1e-9   # -t . delta_s >= -tol F max(|delta_s|, lambda_max(M) F)
# Solver stopping thresholds (stricter than the acceptance thresholds above, which are checked afterwards).
NEWTON_TOLERANCE = 1e-11       # max force-equivalent |Phi| <= tol F
NSGS_TOLERANCE = 1e-13         # max change of p in one sweep <= tol F
SINGULAR_CONDITION = 1e12      # condition number of the (dimensionless) Newton matrix
SLIP_SAMPLES = 2048
LOCAL_DUPLICATE_ANGLE = 1e-7


def validate_friction(friction, contacts):
    """One explicit coefficient per contact id: finite, >= 0, not bool. No default and no extra ids."""
    if not isinstance(friction, dict) or set(friction) != {contact['id'] for contact in contacts}:
        raise ValueError('friction-coefficient: exactly one explicit coefficient per contact id is required (no default)')
    for key, value in friction.items():
        if not _number(value) or value < 0:
            raise ValueError(f'friction-coefficient: {key} must be a finite number >= 0')
    return [float(friction[contact['id']]) for contact in contacts]


def tangent_basis(normal):
    """t1, t2 with (n, t1, t2) right-handed orthonormal; deterministic in n."""
    length = math.sqrt(sum(value * value for value in normal))
    n = [value / length for value in normal]
    axis = min(range(3), key=lambda index: (abs(n[index]), index))
    raw = [(1.0 if index == axis else 0.0) - n[axis] * n[index] for index in range(3)]
    size = math.sqrt(sum(value * value for value in raw))
    t1 = [value / size for value in raw]
    t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]]
    return t1, t2


def validate_loads(loads, size):
    if not isinstance(loads, list) or not 1 <= len(loads) <= MAX_LOAD_FACTORS:
        raise ValueError(f'friction-loads: one to {MAX_LOAD_FACTORS} load steps are required')
    for index, load in enumerate(loads):
        if not _vector(load, size) or any(abs(value) > MAX_LOAD_COMPONENT for value in load):
            raise ValueError(f'friction-loads: loads[{index}] must be a bounded full nodal force vector ({size} values)')


class FrictionProblem:
    """Validated stiffness, contact rows and contact flexibility shared by every load step."""

    def __init__(self, np, plan, stiffness, moment_length_m, friction):
        self.np = np
        nodes, contacts = plan['nodes'], plan['contacts']
        positions = validate_nodes(nodes)
        validate_contacts(contacts, positions)
        self.mu = validate_friction(friction, contacts)
        if not _positive(moment_length_m):
            raise ValueError('contact-scale: the moment length must be a positive length in m')
        self.nodes, self.contacts = nodes, contacts
        self.size = 6 * len(nodes)
        if not hasattr(stiffness, 'shape') or stiffness.shape != (self.size, self.size):
            raise ValueError('friction-stiffness: a square global stiffness with 6 DOF per node is required')
        free = np.array([6 * index + axis for index, node in enumerate(nodes)
                         for axis in range(6) if not node['restrained'][axis]], dtype=int)
        if free.size == 0:
            raise ValueError('contact-restraints: no free degrees of freedom')
        self.free = free
        self.to_newton = np.tile([1.0, 1.0, 1.0, 1 / moment_length_m, 1 / moment_length_m, 1 / moment_length_m],
                                 len(nodes))[free]
        full = _symmetric(np, np.asarray(stiffness, dtype=float), 'global stiffness', allow_zero=True)
        k_free = _symmetric(np, full[np.ix_(free, free)], 'restrained stiffness', allow_zero=True)
        diagonal = np.diag(k_free)
        if np.any(diagonal <= 0):
            raise ValueError('contact-mechanism: nonpositive stiffness diagonal')
        self.equilibration = 1 / np.sqrt(diagonal)
        equilibrated = _symmetric(np, self.equilibration[:, None] * k_free * self.equilibration[None, :],
                                  'equilibrated stiffness')
        self.factor = _positive_factor(np, equilibrated,
                                       'contact-mechanism: without its contacts the structure is an unstable or '
                                       'unresolved mechanism')
        values = np.linalg.eigvalsh(equilibrated)
        threshold = np.finfo(float).eps * free.size * np.linalg.norm(equilibrated, ord=np.inf) * 64
        if not np.isfinite(values).all() or values[0] <= threshold:
            raise ValueError('contact-mechanism: numerically unresolved restrained stiffness')
        self.k_free = k_free
        # Rows: the normal rows are beamContact.constraint_rows; the tangential rows use the same function with the
        # tangent in place of the normal, so the pair sign convention (-A, +B) is identical.
        self.bases = [tangent_basis(contact['normal']) for contact in contacts]
        normal_rows = constraint_rows(np, nodes, contacts)[:, free]
        t1_rows = constraint_rows(np, nodes, [dict(contact, normal=basis[0])
                                              for contact, basis in zip(contacts, self.bases)])[:, free]
        t2_rows = constraint_rows(np, nodes, [dict(contact, normal=basis[1])
                                              for contact, basis in zip(contacts, self.bases)])[:, free]
        if np.any(np.linalg.norm(normal_rows, axis=1) <= UNIT_NORMAL_TOLERANCE):
            raise ValueError('contact-restrained: a contact acts only on restrained translations')
        rows, self.blocks = [], []
        for index, coefficient in enumerate(self.mu):
            start = len(rows)
            rows.append(normal_rows[index])
            if coefficient > 0:
                if (np.linalg.norm(t1_rows[index]) <= UNIT_NORMAL_TOLERANCE
                        or np.linalg.norm(t2_rows[index]) <= UNIT_NORMAL_TOLERANCE):
                    raise ValueError('friction-restrained: a frictional contact has a tangent acting only on '
                                     'restrained translations (its friction force would be indeterminate)')
                rows.extend([t1_rows[index], t2_rows[index]])
            self.blocks.append(list(range(start, len(rows))))
        self.rows = np.array(rows)
        self.tangent_rows = [np.array([t1_rows[index], t2_rows[index]]) for index in range(len(contacts))]
        self.compliance = self.solve(self.rows.T)
        flexibility = _symmetric(np, self.rows @ self.compliance, 'contact flexibility')
        degenerate = 'friction-degenerate: contact rows are dependent (several contacts on the same translations)'
        _positive_factor(np, flexibility, degenerate)
        scale = 1 / np.sqrt(np.diag(flexibility))
        spectrum = np.linalg.eigvalsh(scale[:, None] * flexibility * scale[None, :])
        if not np.isfinite(spectrum).all() or spectrum[0] <= np.finfo(float).eps * len(rows) * 64:
            raise ValueError(degenerate)
        self.flexibility = flexibility
        self.gaps = np.array([contact['gapM'] for contact in contacts], dtype=float)
        # Per-contact physical scales (m/N): W_nn of the normal row; the tangential block M, its inverse (N/m) and
        # its largest eigenvalue for frictional contacts (None for mu = 0, which has no tangential rows).
        self.normal_flexibility = np.array([flexibility[block[0], block[0]] for block in self.blocks])
        self.tangent_flexibility, self.tangent_stiffness, self.tangent_flexibility_max = [], [], []
        for block in self.blocks:
            if len(block) == 1:
                self.tangent_flexibility.append(None)
                self.tangent_stiffness.append(None)
                self.tangent_flexibility_max.append(None)
                continue
            local = flexibility[np.ix_(block[1:], block[1:])]
            self.tangent_flexibility.append(local)
            self.tangent_stiffness.append(np.linalg.inv(local))
            self.tangent_flexibility_max.append(float(np.linalg.eigvalsh(local)[-1]))

    def slip_force(self, index, increment):
        """|M^-1 delta_s| (N): the force that produces the tangential increment at contact index (frictional only)."""
        return float(self.np.linalg.norm(self.tangent_stiffness[index] @ increment))

    def solve(self, right):
        """K_free^-1 right through the equilibrated Cholesky factor (as beamContact._solve_contact_system)."""
        np = self.np
        scaled = self.equilibration[:, None] * right if right.ndim == 2 else self.equilibration * right
        result = np.linalg.solve(self.factor.T, np.linalg.solve(self.factor, scaled))
        return self.equilibration[:, None] * result if right.ndim == 2 else self.equilibration * result

    def offset(self, unconstrained, previous):
        """h of y = h + W p for a step: normal gap of the free response and its tangential increment."""
        h = self.rows @ unconstrained - self.rows @ previous
        for index, block in enumerate(self.blocks):
            h[block[0]] = self.gaps[index] + self.rows[block[0]] @ unconstrained
        return h


def _contact_force_scales(np, problem, h):
    """Fixed local demands in N; an open positive gap is not a closing demand. No other contact contributes."""
    if not np.isfinite(h).all():
        raise ValueError('contact-numeric: non-finite step offset')
    scales = []
    for index, block in enumerate(problem.blocks):
        closing = max(0.0, -float(h[block[0]])) / float(problem.normal_flexibility[index])
        tangent = 0.0 if len(block) == 1 else problem.slip_force(index, h[block[1:]])
        if not (math.isfinite(closing) and math.isfinite(tangent)):
            raise ValueError('contact-numeric: non-finite local force scale')
        demand = max(closing, tangent)
        scales.append(demand if demand > 0 else 1.0)
    return np.array(scales)


def _scales(np, problem, h, force_n):
    """Reporting only: F = max(|D f|, max F_i), L = max(|h_n|, max W_nn F).
    Solvers, independent acceptance and contact status use F_i, never these aggregate values."""
    if not (np.isfinite(h).all() and np.isfinite(force_n).all()):
        raise ValueError('contact-numeric: non-finite step offset or load')
    force_scale = max(float(np.linalg.norm(force_n)), float(np.max(_contact_force_scales(np, problem, h))))
    normal = [block[0] for block in problem.blocks]
    gap_scale = max(float(np.max(np.abs(h[normal]))), float(np.max(problem.normal_flexibility)) * force_scale)
    if not (math.isfinite(force_scale) and math.isfinite(gap_scale) and gap_scale > 0):
        raise ValueError('contact-numeric: non-finite or zero contact scales')
    return force_scale, gap_scale


def _alart_curnier(np, problem, h, p, radius_factor):
    """Phi(p), one element J of its generalized Jacobian, and the force-equivalent system T Phi, T J.

    radius_factor[i] = (r_n, r_t) in N/m: r_n y_n and r_t y_t are forces like p. Every Phi row is a force except
    r_t y_t of a sticking contact, whose size depends on the mean r_t; T (piecewise constant, block diagonal) is
    M^-1 / r_t on those two rows and the identity elsewhere, so T Phi there is M^-1 y_t, the force that produces the
    tangential increment in each of the contact's own directions. T Phi is the stopping residual; T J s = -T Phi
    gives the same Newton step s as J s = -Phi, without the r_t M spread of an anisotropic tangent."""
    flexibility = problem.flexibility
    y = h + flexibility @ p
    count = p.size
    phi = np.zeros(count)
    jacobian = np.zeros((count, count))
    identity = np.eye(count)
    residual = np.zeros(count)
    scaled = np.zeros((count, count))
    for index, block in enumerate(problem.blocks):
        r_n, r_t = radius_factor[index]
        normal = block[0]
        augmented = p[normal] - r_n * y[normal]
        if augmented > 0:
            phi[normal] = r_n * y[normal]
            jacobian[normal] = r_n * flexibility[normal]
        else:
            phi[normal] = p[normal]
            jacobian[normal] = identity[normal]
        residual[normal], scaled[normal] = phi[normal], jacobian[normal]
        if len(block) == 1:
            continue
        tangent = block[1:]
        mu = problem.mu[index]
        trial = p[tangent] - r_t * y[tangent]
        radius = mu * max(0.0, augmented)
        size = float(np.linalg.norm(trial))
        if radius > 0 and size <= radius:
            phi[tangent] = r_t * y[tangent]
            jacobian[tangent] = r_t * flexibility[tangent]
            residual[tangent] = problem.tangent_stiffness[index] @ y[tangent]
            scaled[tangent] = problem.tangent_stiffness[index] @ flexibility[tangent]
            continue
        if radius <= 0:
            phi[tangent] = p[tangent]
            jacobian[tangent] = identity[tangent]
        else:
            unit = trial / size
            phi[tangent] = p[tangent] - radius * unit
            d_trial = identity[tangent] - r_t * flexibility[tangent]
            d_unit = (np.eye(2) - np.outer(unit, unit)) / size @ d_trial
            d_radius = mu * (identity[normal] - r_n * flexibility[normal])
            jacobian[tangent] = identity[tangent] - np.outer(unit, d_radius) - radius * d_unit
        residual[tangent], scaled[tangent] = phi[tangent], jacobian[tangent]
    return phi, residual, scaled


def solve_newton(np, problem, h, contact_scales, max_iterations):
    """Semi-smooth Newton with Armijo backtracking. Returns (p, iterations) or raises."""
    # Separate radii per contact (N/m): r_n = 1 / W_nn, so r_n g is the force that closes the gap g; r_t = 2 / trace M,
    # the inverse mean tangential flexibility (a scalar keeps the isotropic Coulomb slip direction of the fixed point).
    radius_factor = [(1 / float(problem.normal_flexibility[index]),
                      None if len(block) == 1 else 2 / float(np.trace(problem.tangent_flexibility[index])))
                     for index, block in enumerate(problem.blocks)]
    row_scales = np.empty(h.size)
    for index, block in enumerate(problem.blocks):
        row_scales[block] = contact_scales[index]
    p = np.zeros(h.size)
    phi, residual, scaled = _alart_curnier(np, problem, h, p, radius_factor)
    for iteration in range(max_iterations + 1):
        if not (np.isfinite(phi).all() and np.isfinite(residual).all()):
            raise ValueError('friction-numeric: non-finite Newton residual')
        if float(np.max(np.abs(residual) / row_scales)) <= NEWTON_TOLERANCE:
            return p, iteration
        if iteration == max_iterations:
            break
        if not np.isfinite(scaled).all() or np.linalg.cond(scaled) > SINGULAR_CONDITION:
            raise ValueError('friction-singular: the Newton matrix is singular or ill-conditioned')
        step = np.linalg.solve(scaled, -residual)
        # Armijo on |Phi|^2 (continuous across the stick/slip switch; T Phi is not): J s = -Phi, a descent direction.
        merit = float(phi @ phi)
        alpha = 1.0
        while True:
            trial = p + alpha * step
            trial_phi, trial_residual, trial_scaled = _alart_curnier(np, problem, h, trial, radius_factor)
            if float(trial_phi @ trial_phi) <= (1 - 1e-4 * alpha) * merit:
                break
            alpha /= 2
            if alpha < 2.0 ** -40:
                raise ValueError('friction-line-search: no descent of the Alart-Curnier residual')
        p, phi, residual, scaled = trial, trial_phi, trial_residual, trial_scaled
    raise ValueError(f'friction-iteration-limit: Newton limit {max_iterations} reached before convergence '
                     '(no approximate state is returned)')


def _local_slip_candidates(np, local, b, mu):
    """Roots in the slip angle of the local slip equations y = b + W p, p = lambda (1, -mu d), g = 0,
    delta_s = alpha d, alpha > 0, lambda > 0. Returns [(lambda, d)] for every valid root."""
    angles = np.linspace(0.0, 2 * math.pi, SLIP_SAMPLES + 1)

    def evaluate(theta):
        d = np.array([math.cos(theta), math.sin(theta)])
        denominator = local[0, 0] - mu * float(local[0, 1:] @ d)
        if denominator <= 0:
            return None
        lam = -b[0] / denominator
        slip = b[1:] + lam * (local[1:, 0] - mu * local[1:, 1:] @ d)
        return lam, d, float(d[0] * slip[1] - d[1] * slip[0]), float(d @ slip)

    # Periodic: the end sample 2 pi reuses the value at 0, so a root next to 0 is bracketed exactly once even when
    # cos/sin of 2 pi and of 0 round to different signs of the tiny residual there.
    samples = [evaluate(float(theta)) for theta in angles[:-1]]
    samples.append(samples[0])
    roots = []
    for left_angle, right_angle, left, right in zip(angles[:-1], angles[1:], samples[:-1], samples[1:]):
        if left is None or right is None:
            continue
        if left[2] == 0:
            candidate = (float(left_angle), left)
        elif left[2] * right[2] < 0:
            low, high, low_value = float(left_angle), float(right_angle), left[2]
            for _ in range(200):
                middle = (low + high) / 2
                value = evaluate(middle)
                if value is None:
                    break
                if value[2] == 0 or high - low <= 1e-15:
                    low = high = middle
                    break
                if (value[2] < 0) == (low_value < 0):
                    low, low_value = middle, value[2]
                else:
                    high = middle
            final = evaluate((low + high) / 2)
            if final is None:
                continue
            candidate = ((low + high) / 2, final)
        else:
            continue
        theta, (lam, d, _, along) = candidate
        if lam > 0 and along > 0 and not any(abs(math.remainder(theta - other, 2 * math.pi)) <= LOCAL_DUPLICATE_ANGLE
                                             for other, _, _ in roots):
            roots.append((theta, lam, d))
    return [(lam, d) for _, lam, d in roots]


def local_coulomb(np, local, b, mu):
    """Exact solution of one contact with y = b + local p (local: 1x1 or 3x3 positive definite block).
    Returns (p, state)."""
    if b[0] >= 0:
        return np.zeros(b.size), 'open'
    if b.size == 1:
        return np.array([-b[0] / local[0, 0]]), 'closed'
    stick = np.linalg.solve(local, -b)
    if stick[0] >= 0 and float(np.linalg.norm(stick[1:])) <= mu * stick[0]:
        return stick, 'stick'
    candidates = _local_slip_candidates(np, local, b, mu)
    if len(candidates) != 1:
        raise ValueError(f'friction-local: {len(candidates)} local slip solutions (expected exactly one)')
    lam, d = candidates[0]
    return np.concatenate(([lam], -mu * lam * d)), 'slip'


def solve_nsgs(np, problem, h, contact_scales, max_sweeps):
    """Nonlinear block Gauss-Seidel with exact local solutions. Returns (p, sweeps) or raises."""
    flexibility = problem.flexibility
    p = np.zeros(h.size)
    for sweep in range(1, max_sweeps + 1):
        change = 0.0
        for index, block in enumerate(problem.blocks):
            local = flexibility[np.ix_(block, block)]
            b = h[block] + flexibility[block] @ p - local @ p[block]
            updated, _ = local_coulomb(np, local, b, problem.mu[index])
            if not np.isfinite(updated).all():
                raise ValueError('friction-numeric: non-finite local solution')
            change = max(change, float(np.max(np.abs(updated - p[block]))) / contact_scales[index])
            p[block] = updated
        if change <= NSGS_TOLERANCE:
            return p, sweep
    raise ValueError(f'friction-iteration-limit: Gauss-Seidel limit {max_sweeps} sweeps reached before convergence '
                     '(no approximate state is returned)')


def _finite_vector(np, value, size, name):
    if (not isinstance(value, np.ndarray) or value.dtype.kind not in 'fi' or value.shape != (size,)
            or not np.isfinite(value).all()):
        raise ValueError(f'contact-numeric: {name} must be a finite real vector of {size} values')


def _worst(values):
    """Largest value; a non-finite value is never hidden by max() (max(0.0, nan) is 0.0 in Python)."""
    for value in values:
        if not math.isfinite(value):
            return math.nan
    return max(values)


def check_step(np, problem, force, displacement, previous, p, force_scale):
    """Independent acceptance from the displacement: raises on any violated condition, returns the residuals.

    force, displacement and previous are free-DOF vectors, p the contact forces (lambda, t1, t2 per frictional
    contact), force_scale the positive reporting scale (N), validated but not used to relax any check. Local F_i
    are recomputed from the prescribed load and previous state, not supplied by the solver or its trial solution.
    Each contact uses its own flexibility and F_i (see Scales); equilibrium is componentwise."""
    size, count = problem.free.size, problem.rows.shape[0]
    _finite_vector(np, force, size, 'the step load')
    _finite_vector(np, displacement, size, 'the displacement')
    _finite_vector(np, previous, size, 'the previous displacement')
    _finite_vector(np, p, count, 'the contact forces')
    if not _number(force_scale) or force_scale <= 0:
        raise ValueError('contact-numeric: the force scale must be a finite positive number in N')
    increments = [rows @ (displacement - previous) for rows in problem.tangent_rows]
    dissipation = [-float(p[block[1:]] @ increments[index]) if len(block) == 3 else 0.0
                   for index, block in enumerate(problem.blocks)]
    if not all(math.isfinite(value) for value in dissipation):
        raise ValueError('friction-dissipation: non-finite frictional work in a step')
    contact_scales = _contact_force_scales(np, problem, problem.offset(problem.solve(force), previous))
    internal = problem.to_newton * (problem.k_free @ displacement)
    applied = problem.to_newton * force
    reacting = problem.to_newton * (problem.rows.T @ p)
    denominator = problem.to_newton * (np.abs(problem.k_free) @ np.abs(displacement)
                                      + np.abs(force) + np.abs(problem.rows.T) @ np.abs(p))
    balance = np.abs(internal - applied - reacting)
    ratios = np.zeros(size)
    np.divide(balance, denominator, out=ratios, where=denominator > 0)
    ratios[(denominator == 0) & (balance != 0)] = math.inf
    equilibrium = (_worst(ratios) if np.isfinite(denominator).all() and np.isfinite(balance).all()
                   else math.nan)
    normal = [block[0] for block in problem.blocks]
    lam = p[normal]
    gap = problem.gaps + problem.rows[normal] @ displacement
    # Normal: the force that closes a gap is g / W_nn (m over m/N) of the same contact.
    penetrations, complementarities, tensions = [], [], []
    for index in range(len(problem.blocks)):
        force_scale = float(contact_scales[index])
        own = float(problem.normal_flexibility[index])
        g, value = float(gap[index]), float(lam[index])
        penetrations.append(max(0.0, -g) / own / force_scale)
        tensions.append(max(0.0, -value) / force_scale)
        complementarities.append(abs(value * g) / (force_scale * max(own * force_scale, abs(g))))
    cones, slip_laws, works = [0.0], [0.0], [0.0]
    for index, block in enumerate(problem.blocks):
        force_scale = float(contact_scales[index])
        increment = increments[index]
        if len(block) == 1:
            continue
        traction = p[block[1:]]
        bound = problem.mu[index] * lam[index]
        cones.append((float(np.linalg.norm(traction)) - bound) / force_scale)
        length = float(np.linalg.norm(increment))
        # Tangential: the force that produces the increment in this contact's own directions, |M^-1 delta_s|.
        slipping = problem.slip_force(index, increment)
        if not math.isfinite(slipping) or slipping > STICK_TOLERANCE * force_scale:
            slip_laws.append(float(np.linalg.norm(traction + bound * increment / length)) / force_scale)
        work = dissipation[index]
        # A stick increment (|M^-1 delta_s| <= tol F) can do at most tol F lambda_max(M) F of work against |t| <= F;
        # a slip that obeys the slip law at most tol F |delta_s|. Both scales belong to this contact only.
        reach = max(length, problem.tangent_flexibility_max[index] * force_scale)
        works.append(max(0.0, -work) / (force_scale * reach) if math.isfinite(work) else math.nan)
    cone, slip_law = _worst(cones), _worst(slip_laws)
    checks = (
        (equilibrium, EQUILIBRIUM_TOLERANCE, 'contact-equilibrium: normalized equilibrium residual exceeded 1e-9'),
        (_worst(penetrations), FEASIBILITY_TOLERANCE, 'contact-penetration: a contact gap is negative beyond 1e-9'),
        (_worst(tensions), FEASIBILITY_TOLERANCE, 'contact-tension: a contact reaction is tensile beyond 1e-9'),
        (_worst(complementarities), COMPLEMENTARITY_TOLERANCE,
         'contact-complementarity: lambda * gap exceeded 1e-9'),
        (cone, CONE_TOLERANCE, 'friction-cone: |t| exceeded mu lambda beyond 1e-9'),
        (slip_law, SLIP_LAW_TOLERANCE, 'friction-slip-law: t differs from -mu lambda delta_s/|delta_s| beyond 1e-9'),
        (_worst(works), DISSIPATION_TOLERANCE, 'friction-dissipation: negative frictional work in a step'),
    )
    for value, tolerance, message in checks:
        if not math.isfinite(value) or value > tolerance:
            raise ValueError(message)
    return {'equilibriumResidual': equilibrium, 'penetration': _worst(penetrations), 'tension': _worst(tensions),
            'complementarity': _worst(complementarities), 'frictionConeExcess': max(0.0, cone),
            'slipLawResidual': slip_law, 'dissipation': dissipation}


def solve_friction_steps(np, plan, stiffness, moment_length_m, friction, loads, *, solver='newton',
                         max_iterations=None):
    """Sequential quasi-static Coulomb contact for full nodal load vectors loads[k] (N, N m; 6 per node).

    friction maps every contact id to its coefficient. solver is 'newton' or 'nsgs'; max_iterations is the Newton
    iteration limit or the Gauss-Seidel sweep limit of each step (positive integer)."""
    if solver not in SOLVERS:
        raise ValueError(f'friction-solver: one of {SOLVERS}')
    if max_iterations is None:
        max_iterations = DEFAULT_NEWTON_ITERATIONS if solver == 'newton' else DEFAULT_NSGS_SWEEPS
    if not isinstance(max_iterations, int) or isinstance(max_iterations, bool) or max_iterations < 1:
        raise ValueError('friction-limit: the iteration limit must be a positive integer')
    problem = FrictionProblem(np, plan, stiffness, moment_length_m, friction)
    validate_loads(loads, problem.size)
    previous = np.zeros(problem.free.size)
    accumulated = [np.zeros(3) for _ in problem.contacts]
    path_length = [0.0] * len(problem.contacts)
    work = [0.0] * len(problem.contacts)
    states = []
    for step_index, load in enumerate(loads):
        force = np.array(load, dtype=float)[problem.free]
        unconstrained = problem.solve(force)
        h = problem.offset(unconstrained, previous)
        force_scale, gap_scale = _scales(np, problem, h, problem.to_newton * force)
        contact_scales = _contact_force_scales(np, problem, h)
        if solver == 'newton':
            p, iterations = solve_newton(np, problem, h, contact_scales, max_iterations)
        else:
            p, iterations = solve_nsgs(np, problem, h, contact_scales, max_iterations)
        # Reconstruct from the combined load using the same factor: summing separately solved
        # responses can leave cancellation noise on otherwise unloaded interior DOFs.
        displacement = problem.solve(force + problem.rows.T @ p)
        if not np.isfinite(displacement).all():
            raise ValueError('contact-numeric: non-finite displacement')
        residuals = check_step(np, problem, force, displacement, previous, p, force_scale)
        full = np.zeros(problem.size)
        full[problem.free] = displacement
        records = []
        for index, node in enumerate(problem.nodes[:plan['originalNodeCount']]):
            block = full[6 * index:6 * index + 6]
            records.append({'number': node['number'], 'displacementM': block[:3].tolist(),
                            'rotationRad': block[3:].tolist()})
        contact_rows = []
        for index, (contact, block) in enumerate(zip(problem.contacts, problem.blocks)):
            t1, t2 = (np.array(vector) for vector in problem.bases[index])
            increment = problem.tangent_rows[index] @ (displacement - previous)
            increment_global = increment[0] * t1 + increment[1] * t2
            traction = p[block[1:]] if len(block) == 3 else np.zeros(2)
            lam = float(p[block[0]])
            gap = float(problem.gaps[index] + problem.rows[block[0]] @ displacement)
            size = float(np.linalg.norm(increment))
            local_scale = float(contact_scales[index])
            if lam <= FEASIBILITY_TOLERANCE * local_scale:
                state = 'open'
            elif len(block) == 1:
                state = 'closed'
            else:
                state = ('slip' if problem.slip_force(index, increment) > STICK_TOLERANCE * local_scale
                         else 'stick')
            if state != 'open':
                # Relative tangential motion of an open contact is not slip.
                accumulated[index] = accumulated[index] + increment_global
                path_length[index] += size
            work[index] += residuals['dissipation'][index]
            contact_rows.append({
                'id': contact['id'], 'state': state, 'frictionCoefficient': problem.mu[index],
                'normalReactionN': lam, 'gapM': gap,
                'frictionForceN': (traction[0] * t1 + traction[1] * t2).tolist(),
                'slipIncrementM': increment_global.tolist(), 'accumulatedSlipM': accumulated[index].tolist(),
                'slipPathLengthM': path_length[index], 'dissipatedWorkJ': work[index]})
        states.append({'step': step_index, 'iterations': int(iterations), 'nodes': records, 'contacts': contact_rows,
                       'forceScaleN': force_scale, 'gapScaleM': gap_scale,
                       **{key: value for key, value in residuals.items() if key != 'dissipation'}})
        previous = displacement
    return {'kind': FRICTION_RESULT_KIND, 'solver': solver, 'iterationLimit': max_iterations,
            'freeDofs': int(problem.free.size), 'states': states}


def solve_friction_contact_system(np, plan, stiffness, moment_length_m, friction, *, solver='newton',
                                  max_iterations=None):
    """The plan's proportional path: loads[k] = loadFactors[k] x the plan's nodal loads, applied in order."""
    validate_nodes(plan['nodes'])
    validate_load_factors(plan['loadFactors'])
    reference =[value for node in plan['nodes'] for value in node['load']]
    loads = [[factor * value for value in reference] for factor in plan['loadFactors']]
    result = solve_friction_steps(np, plan, stiffness, moment_length_m, friction, loads, solver=solver,
                                  max_iterations=max_iterations)
    for state, factor in zip(result['states'], plan['loadFactors'], strict=True):
        state['loadFactor'] = factor
    return result
