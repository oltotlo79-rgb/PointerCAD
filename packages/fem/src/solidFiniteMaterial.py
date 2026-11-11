"""Finite-strain J2 plasticity at one integration point (EX-09 W33 candidate; not wired to any product route).

Model (isotropic only): multiplicative split F = Fe Fp with det Fp = 1, Hencky (logarithmic) elastic energy of
be = Fe Fe^T, von Mises yield on the Kirchhoff stress with linear isotropic hardening, associative flow and the
exponential-map return of Simo (1992, CMAME 99:61-112; Simo and Hughes 1998, Computational Inelasticity, ch. 9).
The history variable is the Lagrangian Cp^-1 = Fp^-1 Fp^-T, so the update is exactly invariant under superposed
rotations of the current configuration. This is not the additive Lagrangian log-strain split of OOFEM lsmastermat
(see the W33 root-question) and is not MisesMat evaluated at Green-Lagrange strain. The small-strain route
(solidPlasticAnalysis.py, MAXIMUM_STRAIN 0.05) is separate and unchanged.

Per step, with be_tr = F Cp^-1_n F^T and eps_tr = 1/2 ln be_tr (spatial):
  tau_tr = K tr(eps_tr) I + 2 G dev(eps_tr),  q_tr = sqrt(3/2) |dev tau_tr|,  f = q_tr - (sigma_y + H alpha_n)
  f <= 0: elastic.  f > 0: dgamma = f / (3 G + H), eps = eps_tr - dgamma 3/2 dev(tau_tr) / q_tr, alpha += dgamma
  tau = K tr(eps) I + 2 G dev(eps),  P = tau F^-T,  S = F^-1 tau F^-T,  Cp^-1_{n+1} = F^-1 exp(2 eps) F^-T.
The consistent tangent dP/dF is the exact derivative of this update, evaluated by forward-mode dual numbers through
the same arithmetic (matrix log by inverse scaling and squaring with Denman-Beavers square roots and the atanh
series, matrix exp by scaling and squaring): only + - * / sqrt are used, so the derivative is smooth through repeated
principal stretches (no eigenvectors are differentiated). Units N-mm-MPa. Pure Python: runs under CPython and Pyodide.
"""
import math

# OOFEM 9-component order [11, 22, 33, 23, 13, 12, 32, 31, 21] (floatmatrixf.h to_voigt_form_33) as row-major 3x3 indices.
OOFEM9 = (0, 4, 8, 5, 2, 1, 7, 6, 3)
SCHEMA = 'pointercad-finite-j2-point/1'


class Dual:
    """Value with 9 directional derivatives (one per entry of F, row-major)."""
    __slots__ = ('v', 'g')

    def __init__(self, v, g):
        self.v, self.g = v, g

    def __add__(self, o):
        if isinstance(o, Dual):
            return Dual(self.v + o.v, [a + b for a, b in zip(self.g, o.g)])
        return Dual(self.v + o, self.g)

    __radd__ = __add__

    def __sub__(self, o):
        if isinstance(o, Dual):
            return Dual(self.v - o.v, [a - b for a, b in zip(self.g, o.g)])
        return Dual(self.v - o, self.g)

    def __rsub__(self, o):
        return Dual(o - self.v, [-a for a in self.g])

    def __neg__(self):
        return Dual(-self.v, [-a for a in self.g])

    def __mul__(self, o):
        if isinstance(o, Dual):
            return Dual(self.v * o.v, [self.v * b + o.v * a for a, b in zip(self.g, o.g)])
        return Dual(self.v * o, [a * o for a in self.g])

    __rmul__ = __mul__

    def __truediv__(self, o):
        if isinstance(o, Dual):
            inv = 1.0 / o.v
            q = self.v * inv
            return Dual(q, [(a - q * b) * inv for a, b in zip(self.g, o.g)])
        return Dual(self.v / o, [a / o for a in self.g])

    def __rtruediv__(self, o):
        inv = 1.0 / self.v
        q = o * inv
        return Dual(q, [-q * inv * a for a in self.g])


def _val(x):
    return x.v if isinstance(x, Dual) else x


def _sqrt(x):
    if isinstance(x, Dual):
        r = math.sqrt(x.v)
        return Dual(r, [a / (2.0 * r) for a in x.g])
    return math.sqrt(x)


# 3x3 matrices are row-major lists of 9 scalars (float or Dual).
IDENTITY = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


def mm(a, b):
    return [a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j] for i in range(3) for j in range(3)]


def mt(a):
    return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]


def madd(a, b):
    return [x + y for x, y in zip(a, b)]


def msub(a, b):
    return [x - y for x, y in zip(a, b)]


def mscale(a, s):
    return [x * s for x in a]


def trace(a):
    return a[0] + a[4] + a[8]


def det(a):
    return (a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6])
            + a[2] * (a[3] * a[7] - a[4] * a[6]))


def inv(a):
    d = det(a)
    if not _val(d) != 0:
        raise ValueError('finite-j2: singular matrix')
    c = [a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
         a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
         a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]]
    return [x / d for x in c]


def norm_real(a):
    return math.sqrt(sum(_val(x) ** 2 for x in a))


def symmetrize(a):
    return [(a[3 * i + j] + a[3 * j + i]) * 0.5 for i in range(3) for j in range(3)]


def dev(a):
    m = trace(a) / 3.0
    return [a[0] - m, a[1], a[2], a[3], a[4] - m, a[5], a[6], a[7], a[8] - m]


def ddot(a, b):
    return sum(x * y for x, y in zip(a, b))


def sqrtm_spd(a):
    """Principal square root of a symmetric positive definite matrix (Denman-Beavers, rational iteration)."""
    y, z = list(a), list(IDENTITY)
    scale = max(norm_real(a), 1e-300)
    settled = 0
    for _ in range(100):
        y_next = mscale(madd(y, inv(z)), 0.5)
        z = mscale(madd(z, inv(y)), 0.5)
        change = norm_real(msub(y_next, y))
        y = y_next
        if change <= 1e-15 * scale:
            settled += 1
            if settled >= 2:  # two more passes after convergence so the derivative also settles
                return symmetrize(y)
    raise ValueError('finite-j2: matrix square root did not converge')


def logm_spd(a):
    """Matrix logarithm of a symmetric positive definite matrix by inverse scaling and squaring."""
    k = 0
    x = list(a)
    while norm_real(msub(x, IDENTITY)) > 0.25:
        x = sqrtm_spd(x)
        k += 1
        if k > 60:
            raise ValueError('finite-j2: logarithm argument out of range')
    z = mm(msub(x, IDENTITY), inv(madd(x, IDENTITY)))
    z2 = mm(z, z)
    term, total = list(z), list(z)
    for j in range(1, 16):  # |z| <= 0.125: the remaining series is below 1e-30 relative
        term = mm(term, z2)
        total = madd(total, mscale(term, 1.0 / (2 * j + 1)))
    return symmetrize(mscale(total, 2.0 * 2 ** k))


def expm_sym(a):
    """Matrix exponential (scaling and squaring with a Taylor series); used for symmetric arguments."""
    s = 0
    n = norm_real(a)
    while n > 0.5 * 2 ** s:
        s += 1
    x = mscale(a, 1.0 / 2 ** s)
    term, total = list(IDENTITY), list(IDENTITY)
    for j in range(1, 20):
        term = mscale(mm(term, x), 1.0 / j)
        total = madd(total, term)
    for _ in range(s):
        total = mm(total, total)
    return symmetrize(total)


def read_parameters(value):
    """Validated parameters: youngMPa > 0, 0 <= poisson < 0.5, yieldStressMPa > 0, hardeningModulusMPa >= 0."""
    if not isinstance(value, dict) or set(value) != {'youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa'}:
        raise ValueError('finite-j2: parameters must have exactly youngMPa, poisson, yieldStressMPa, hardeningModulusMPa')
    numbers = {}
    for key in ('youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa'):
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise ValueError(f'finite-j2: {key} must be a finite number')
        numbers[key] = float(item)
    if not numbers['youngMPa'] > 0:
        raise ValueError('finite-j2: youngMPa must be positive')
    if not 0 <= numbers['poisson'] < 0.5:
        raise ValueError('finite-j2: poisson must be in [0, 0.5)')
    if not numbers['yieldStressMPa'] > 0:
        raise ValueError('finite-j2: yieldStressMPa must be positive')
    if not numbers['hardeningModulusMPa'] >= 0:
        raise ValueError('finite-j2: hardeningModulusMPa must not be negative (softening is not supported)')
    e, nu = numbers['youngMPa'], numbers['poisson']
    return {**numbers, 'bulk': e / (3 * (1 - 2 * nu)), 'shear': e / (2 * (1 + nu))}


def initial_state():
    return {'cpInv': list(IDENTITY), 'alpha': 0.0}


def _check_f(f):
    if len(f) != 9 or any(not math.isfinite(_val(x)) for x in f):
        raise ValueError('finite-j2: F must be 9 finite numbers')
    j = _val(det(f))
    if not j > 0:
        raise ValueError(f'finite-j2: det F = {j!r} must be positive (inverted or collapsed element)')


def _update(f, state, p):
    """The update for a row-major F of floats or Duals; state holds floats only."""
    _check_f(f)
    cp_inv, alpha_n = state['cpInv'], state['alpha']
    be_tr = symmetrize(mm(mm(f, cp_inv), mt(f)))
    eps_tr = mscale(logm_spd(be_tr), 0.5)
    k, g, h, sy = p['bulk'], p['shear'], p['hardeningModulusMPa'], p['yieldStressMPa']
    dev_eps_tr = dev(eps_tr)
    vol = trace(eps_tr)
    dev_tau_tr = mscale(dev_eps_tr, 2.0 * g)
    q2_tr = ddot(dev_tau_tr, dev_tau_tr) * 1.5
    # The yield test uses the value only; sqrt is differentiated only when q_tr > sigma_y > 0 (plastic branch).
    if math.sqrt(_val(q2_tr)) - (sy + h * alpha_n) > 0:
        q_tr = _sqrt(q2_tr)
        dgamma = (q_tr - (sy + h * alpha_n)) / (3.0 * g + h)
        flow = mscale(dev_tau_tr, 1.5 / q_tr)
        eps = msub(eps_tr, mscale(flow, dgamma))
    else:
        dgamma = 0.0
        eps = eps_tr
    tau = madd(mscale(IDENTITY, k * vol), mscale(dev(eps), 2.0 * g))
    f_inv = inv(f)
    return {'tau': tau, 'P': mm(tau, mt(f_inv)), 'S': symmetrize(mm(mm(f_inv, tau), mt(f_inv))), 'epsTrial': eps_tr,
            'eps': eps, 'dgamma': dgamma, 'alpha': alpha_n + dgamma, 'fInv': f_inv}


def evaluate(f, state, parameters, tangent=False):
    """Stress update at F (row-major 9 floats) from the committed state; returns floats and the trial state.

    Work-conjugate pairs (per reference volume unless noted): P with F (P : dF), S with the Green-Lagrange strain
    E = (C - I) / 2 (S : dE), Kirchhoff tau with the rate of deformation d (tau : d), Cauchy sigma = tau / J with d per
    current volume. The returned 'state' is the trial state for this F; the caller commits it only after equilibrium.
    tangent=True adds 'dPdF' as a 9x9 row-major list A[3i+j][3k+l] = dP_ij / dF_kl (exact algorithmic tangent).
    """
    p = parameters
    f = [float(x) for x in f]
    out = _update(f, state, p)
    tau, eps = out['tau'], out['eps']
    cp_inv_new = symmetrize(mm(mm(out['fInv'], expm_sym(mscale(eps, 2.0))), mt(out['fInv'])))
    j = det(f)
    q = math.sqrt(1.5 * ddot(dev(tau), dev(tau)))
    alpha_old, alpha_new, dgamma = state['alpha'], float(out['alpha']), float(out['dgamma'])
    plastic_work = ddot(tau, msub(out['epsTrial'], eps))
    stored = 0.5 * p['hardeningModulusMPa'] * (alpha_new ** 2 - alpha_old ** 2)
    result = {'schema': SCHEMA, 'F': f, 'J': j, 'tau': tau, 'sigma': mscale(tau, 1.0 / j), 'P': out['P'], 'S': out['S'],
              'epsTrial': out['epsTrial'], 'eps': eps, 'q': q, 'dgamma': dgamma,
              'plastic': dgamma > 0, 'state': {'cpInv': cp_inv_new, 'alpha': alpha_new},
              # Energy per reference volume (N mm / mm^3) of one step, hardening energy psi_h = H alpha^2 / 2:
              # plasticWork: discrete work of the endpoint Kirchhoff stress on the plastic log-strain increment,
              #   tau_{n+1} : (eps_tr - eps_{n+1}) = q_{n+1} dgamma;
              # storedHardeningIncrement: exact psi_h(alpha_{n+1}) - psi_h(alpha_n) = H / 2 (alpha_{n+1}^2 - alpha_n^2);
              # dissipation: backward-Euler (endpoint) dissipation plasticWork - H alpha_{n+1} dgamma = sigma_y dgamma >= 0,
              #   i.e. the thermodynamic hardening force is taken at alpha_{n+1}; it is NOT plasticWork minus the exact
              #   stored increment, which is sigma_y dgamma + H dgamma^2 / 2 ('workMinusStoredHardening', also >= 0).
              'plasticWork': plastic_work, 'storedHardeningIncrement': stored,
              'workMinusStoredHardening': plastic_work - stored,
              'dissipation': plastic_work - p['hardeningModulusMPa'] * alpha_new * dgamma}
    if tangent:
        duals = [Dual(f[i], [1.0 if j == i else 0.0 for j in range(9)]) for i in range(9)]
        p_dual = _update(duals, state, p)['P']
        result['dPdF'] = [list(entry.g) if isinstance(entry, Dual) else [0.0] * 9 for entry in p_dual]
    return result


# OOFEM 6-component order [11, 22, 33, 23, 13, 12]; strains carry engineering shear (gamma = 2 E_ij).
VOIGT6 = ((0, 0), (1, 1), (2, 2), (1, 2), (0, 2), (0, 1))


def _c_from_voigt_strain(e6):
    c = list(IDENTITY)
    for k, (i, j) in enumerate(VOIGT6):
        if i == j:
            c[3 * i + i] = c[3 * i + i] + 2.0 * e6[k]
        else:  # 2 E_ij = gamma_ij
            c[3 * i + j] = c[3 * i + j] + e6[k]
            c[3 * j + i] = c[3 * j + i] + e6[k]
    return c


def evaluate_lagrangian(e6, state, parameters, tangent=False):
    """The same law driven by the Green-Lagrange strain only (OOFEM Voigt, engineering shear).

    Valid because the law is objective and isotropic with the Lagrangian history Cp^-1: S depends on C = I + 2E alone,
    so S is evaluated at the right stretch U = C^(1/2) (any F = R U gives the same S, checked by the tests).
    Returns S (6), the trial state and, with tangent=True, dSdE[i][j] = dS_i / dE_j (j engineering, OOFEM Voigt).
    """
    if len(e6) != 6 or any(not math.isfinite(float(x)) for x in e6):
        raise ValueError('finite-j2: Green-Lagrange strain must be 6 finite numbers')
    e6 = [float(x) for x in e6]
    c = _c_from_voigt_strain(e6)
    u = sqrtm_spd(c)
    result = evaluate(u, state, parameters)
    result['S6'] = [result['S'][3 * i + j] for i, j in VOIGT6]
    result['E6'] = e6
    if tangent:
        duals = [Dual(e6[k], [1.0 if m == k else 0.0 for m in range(6)]) for k in range(6)]
        s_dual = _update(sqrtm_spd(_c_from_voigt_strain(duals)), state, parameters)['S']
        result['dSdE'] = [list(s_dual[3 * i + j].g) if isinstance(s_dual[3 * i + j], Dual) else [0.0] * 6
                          for i, j in VOIGT6]
    return result


def to_oofem9(m):
    return [m[i] for i in OOFEM9]


def from_oofem9(v):
    m = [0.0] * 9
    for k, i in enumerate(OOFEM9):
        m[i] = float(v[k])
    return m


def make_oofem_material(fem, number, domain, parameters):
    """Inject this law into the pinned OOFEM 214b161 through its Python material trampoline.

    Binding facts that fix the design (bundled bindings/python/oofem.cpp):
      * a Python giveFirstPKStressVector_3d is not callable: 659-661 forward the fixed-size FloatArrayF<9> without
        converting it to FloatArray (compare giveRealStressVector_3d at 605-607) and FloatArrayF has no Python type;
      * StructuralMaterialStatus.updateYourself has a trampoline (473) but its native base is not exposed (1384-1390),
        so a Python override would drop the native temp -> committed copy of strain, stress, F and P;
      * letTempFVectorBe / giveTempFVector are not exposed, so Python can neither restore nor read the native temp F.
    The adapter overrides only giveRealStressVector_3d (E -> S, 605) and give3dMaterialStiffnessMatrix (dS/dE, 701);
    the native StructuralMaterial defaults form P = F S, the temp F/P record and dP/dF = I x S + F F (dS/dE)
    (structuralmaterial.C:330-351, 431-436, 693-702), and the native status commits its own records.

    Step/attempt ownership: begin_step(step) opens one attempt, discards every point's trial caches and returns its
    token; stress and tangent callbacks are only valid inside an open attempt and a cached trial is only used by the
    attempt that produced it. commit_accepted(step, token, residual) commits all points or none, and only for the open
    attempt of that step, with the driver's separately verified free-DOF residual within FREE_RESIDUAL_BOUND, after the
    native update (native committed strain equal to the trial strain is a consistency check, not the acceptance).
    abandon_step(token) closes a rejected attempt; afterwards every begin_step is refused (fail closed, no retry): the
    native temp F of the rejected trial cannot be restored from Python, and the native dP/dF would use it.
    """
    p = read_parameters(parameters)

    def as_float_array(values):
        answer = fem.FloatArray(len(values))
        for k, value in enumerate(values):
            answer[k] = value
        return answer

    class FiniteJ2Status(fem.StructuralMaterialStatus):
        def __init__(self, gp):
            fem.StructuralMaterialStatus.__init__(self, gp)
            self.committed, self.committedE, self.converged = initial_state(), [0.0] * 6, None
            self.trial, self.trialE, self.last, self.trialToken = None, None, None, None
            self.commits = 0

        def giveClassName(self):
            return 'PointerCadFiniteJ2Status'

        def discard_trial(self):
            self.trial, self.trialE, self.last, self.trialToken = None, None, None, None

    class FiniteJ2Material(fem.StructuralMaterial):
        def __init__(self):
            fem.StructuralMaterial.__init__(self, number, domain)
            self.statuses, self.refusedCommits, self.acceptedSteps, self.abandonedSteps = [], [], [], []
            self.stressCalls, self.tangentCalls = 0, 0
            self.attempt, self.attempts = None, 0

        def begin_step(self, step_number):
            step = int(step_number)
            if self.attempt is not None:
                raise ValueError(f'finite-j2: step {self.attempt[0]} attempt {self.attempt[1]} is still open')
            if self.abandonedSteps:
                raise ValueError(f'finite-j2: step {self.abandonedSteps[0]} was rejected; no further attempt is accepted '
                                 'because the native temp F of the rejected trial cannot be restored from Python')
            if step in self.acceptedSteps:
                raise ValueError(f'finite-j2: step {step} was already accepted')
            self.attempts += 1
            self.attempt = (step, self.attempts)
            for status in self.statuses:
                status.discard_trial()
            return f'{step}:{self.attempts}'

        def abandon_step(self, token):
            if self.attempt is None or token != f'{self.attempt[0]}:{self.attempt[1]}':
                raise ValueError(f'finite-j2: no open attempt {token!r} to abandon')
            self.abandonedSteps.append(self.attempt[0])
            for status in self.statuses:
                status.discard_trial()
            self.attempt = None

        def _token(self):
            return None if self.attempt is None else f'{self.attempt[0]}:{self.attempt[1]}'

        def commit_accepted(self, step_number, token, free_residual_ratio):
            """Commit every point's trial history for the open, accepted and natively updated attempt (all or nothing)."""
            step = int(step_number)

            def refuse(reason):
                self.refusedCommits.append({'step': step, 'token': token, 'reason': reason})
                raise ValueError(f'finite-j2: commit of step {step} refused ({reason})')
            if self.attempt is None or token != self._token() or step != self.attempt[0]:
                refuse(f'token {token!r} is not the open attempt {self._token()!r}')
            if not (isinstance(free_residual_ratio, float) and 0.0 <= free_residual_ratio <= FREE_RESIDUAL_BOUND):
                refuse(f'free-DOF residual {free_residual_ratio!r} is not within {FREE_RESIDUAL_BOUND}')
            for status in self.statuses:
                if status.trial is None or status.trialToken != token:
                    refuse('a point has no trial of this attempt')
                if [float(v) for v in status.giveStrainVector()] != status.trialE:
                    refuse('native committed strain differs from the trial strain (native update missing)')
            for status in self.statuses:
                status.committed, status.committedE, status.converged = status.trial, status.trialE, status.last
                status.discard_trial()
                status.commits += 1
            self.acceptedSteps.append(step)
            self.attempt = None

        def giveClassName(self):
            return 'PointerCadFiniteJ2Material'

        def giveInputRecordName(self):
            return 'pointercadfinitej2'

        def hasMaterialModeCapability(self, mode):
            return mode == fem.MaterialMode._3dMat

        def giveStatus(self, gp):
            if not gp.hasMaterialStatus():
                status = FiniteJ2Status(gp)
                self.statuses.append(status)
                gp.setMaterialStatus(status, fem.IntegrationPointStatusIDType.IPSID_Default)
            return gp.giveMaterialStatus()

        def giveRealStressVector_3d(self, strain, gp, tStep):
            token = self._token()
            if token is None:
                raise ValueError('finite-j2: stress requested outside an open step attempt (call begin_step first)')
            self.stressCalls += 1
            status = self.giveStatus(gp)
            e6 = [float(strain[k]) for k in range(6)]
            result = evaluate_lagrangian(e6, status.committed, p, tangent=True)
            status.trial, status.trialE, status.last, status.trialToken = result['state'], e6, result, token
            s6 = as_float_array(result['S6'])
            # The native default giveFirstPKStressVector_3d / dPdF and the native commit read these temp records.
            status.letTempStrainVectorBe(as_float_array(e6))
            status.letTempStressVectorBe(s6)
            return s6

        def give3dMaterialStiffnessMatrix(self, mode, gp, tStep):
            token = self._token()
            if token is None:
                raise ValueError('finite-j2: tangent requested outside an open step attempt (call begin_step first)')
            self.tangentCalls += 1
            status = self.giveStatus(gp)
            last = status.last if status.trialToken == token else None
            if last is None:  # start of an attempt: tangent of the update at the committed strain and state
                last = evaluate_lagrangian(status.committedE, status.committed, p, tangent=True)
            answer = fem.FloatMatrix(6, 6)
            for r in range(6):
                for c in range(6):
                    answer[r, c] = last['dSdE'][r][c]
            return answer

    return FiniteJ2Material()


NATIVE_SCHEMA = 'pointercad-finite-j2-native-tet/1'
FREE_RESIDUAL_BOUND = 1e-8
# Domain.setMaterial (oofem.cpp:1185, domain.C:459 materialList[i-1].reset(obj)) stores the Python-owned trampoline
# object in the domain's unique_ptr. Releasing the problem and the Python material afterwards deletes the same native
# object twice: RUN 20261030-054958 reproduced 'null function or function signature mismatch' as-is and none when only
# the lifetime was extended. Each native run therefore keeps its problem and material until the runtime ends (a
# bounded per-run leak; a binding that transfers ownership is the proper fix).
_NATIVE_LIFETIME = []


def _native_deck(path, nodes, prescribed, nsteps, force_scale, young, poisson):
    def n(value):
        return format(float(value), '.17g')
    scale = (f' forcescale 3 {n(force_scale)} {n(force_scale)} {n(force_scale)} forcescaledofs 3 1 2 3'
             if force_scale is not None else '')
    lines = [path + '.out', 'PointerCAD internal finite J2 single tet (EX-09 W33 candidate)',
             f'StaticStructural nsteps {nsteps} rtolf 1e-10 maxiter 50 manrmsteps 1 nmodules 0{scale}', 'domain 3d',
             'OutputManager']
    records, functions = [], []
    for (node, dof) in sorted(prescribed):
        values = prescribed[(node, dof)]
        number = len(records) + 1
        records.append(f'BoundaryCondition {number} loadTimeFunction {number} dofs 1 {dof + 1} values 1 1.0 set {node + 2}')
        functions.append(f'PiecewiseLinFunction {number} t {nsteps + 1} ' + ' '.join(n(t) for t in range(nsteps + 1))
                         + f' f(t) {nsteps + 1} ' + ' '.join(n(v) for v in [0.0] + list(values)))
    lines.append(f'ndofman 4 nelem 1 ncrosssect 1 nmat 1 nbc {len(records)} nltf {len(functions)} nic 0 nset 5')
    lines += [f'node {i + 1} coords 3 ' + ' '.join(n(v) for v in point) for i, point in enumerate(nodes)]
    # IsoLE is only the deck placeholder of material 1; the injected law replaces it before consistency and init.
    lines += ['ltrspace 1 nodes 4 1 2 3 4 nlgeo 1', 'SimpleCS 1 material 1 set 1', f'IsoLE 1 d 1.0 tAlpha 0.0 E {n(young)} n {n(poisson)}']
    lines += records + functions
    lines.append('Set 1 elementranges {(1 1)}')
    lines += [f'Set {i + 2} nodes 1 {i + 1}' for i in range(4)]
    lines.append('')
    return '\n'.join(lines)


def prepare_native_tet(fem, nodes, prescribed, nsteps, parameters, force_scale=None, path='/pcad_fem/finite-j2-tet'):
    """Build the native single-tet problem with the injected law (kept alive, see _NATIVE_LIFETIME)."""
    read_parameters(parameters)
    if len(nodes) != 4 or any(len(x) != 3 for x in nodes):
        raise ValueError('finite-j2: one tetrahedron needs 4 nodes of 3 coordinates')
    if not isinstance(nsteps, int) or not 1 <= nsteps <= 200:
        raise ValueError('finite-j2: nsteps must be an integer from 1 to 200')
    for key, values in prescribed.items():
        if key[0] not in range(4) or key[1] not in range(3) or len(values) != nsteps:
            raise ValueError('finite-j2: prescribed keys are (node 0..3, dof 0..2) with one value per step')
    with open(path + '.in', 'w', encoding='utf-8') as stream:
        stream.write(_native_deck(path, nodes, prescribed, nsteps, force_scale, parameters['youngMPa'], parameters['poisson']))
    problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(path + '.in'), fem.problemMode.processor, 0, None, False)
    if problem is None:
        raise ValueError('finite-j2: OOFEM rejected the generated deck')
    domain = problem.giveDomain(1)
    material = make_oofem_material(fem, 1, domain, parameters)
    domain.setMaterial(1, material)
    _NATIVE_LIFETIME.append((problem, material))
    if domain.giveMaterial(1) is not material or problem.checkProblemConsistency() != 1:
        raise ValueError('finite-j2: the injected material was not accepted by the native domain')
    problem.init()
    problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
    problem.initMetaStepAttributes(problem.giveMetaStep(1))
    free = [(node, dof) for node in range(4) for dof in range(3) if (node, dof) not in prescribed]
    return problem, domain, material, free


def free_residual_ratio(fem, element, step, free):
    """Native free-DOF internal force over the largest element force (InternalForcesVector re-evaluates the trial).

    The 12 native forces must all be finite (checked before max/division); a zero scale gives 0 only for finite
    all-zero forces.
    """
    forces = fem.FloatArray()
    element.giveCharacteristicVector(forces, fem.CharType.InternalForcesVector, fem.ValueModeType.VM_Total, step)
    forces = [float(v) for v in forces]
    if len(forces) != 12 or any(not math.isfinite(v) for v in forces):
        raise ValueError(f'finite-j2: the native internal force must be 12 finite numbers, got {forces!r}')
    scale = max(abs(v) for v in forces)
    if scale == 0.0:
        return 0.0
    return max((abs(forces[3 * node + dof]) / scale for node, dof in free), default=0.0)


def run_native_tet(fem, nodes, prescribed, nsteps, parameters, force_scale=None, path='/pcad_fem/finite-j2-tet'):
    """Internal native connection: one ltrspace nlgeo 1 tet solved by the native StaticStructural/NRSolver with this law.

    prescribed maps (node index, dof index 0..2) to the displacement at each of the nsteps steps; every other DOF is
    free and unloaded. force_scale (N) is the per-DOF-group reference force of nrsolver.C:754-756 (needed when free
    DOFs carry no load, otherwise the relative norm degenerates); rtolf stays 1e-10. Each step is one attempt: it is
    accepted only if the native free-DOF internal forces are within FREE_RESIDUAL_BOUND of the largest element force,
    then the native statuses are updated and the Python history committed; otherwise the attempt is abandoned and the
    run stops with nothing committed. An exception from the solve, the native update or the commit also abandons the
    still open attempt (one already closed by rejection or commit is not abandoned again) and is re-raised unchanged.
    Not a public route: no union, schema or persistence.
    """
    import copy
    import json
    problem, domain, material, free = prepare_native_tet(fem, nodes, prescribed, nsteps, parameters, force_scale, path)
    primary, records, token = None, [], None
    try:
        ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
        element = domain.giveElement(1)
        for index in range(nsteps):
            problem.preInitializeNextStep()
            step = problem.giveNextStep()
            problem.initializeYourself(step)
            token = material.begin_step(step.giveNumber())
            calls = (material.stressCalls, material.tangentCalls)
            before = copy.deepcopy(material.statuses[0].committed) if material.statuses else initial_state()
            problem.solveYourselfAt(step)
            ratio = free_residual_ratio(fem, element, step, free)
            if not ratio <= FREE_RESIDUAL_BOUND:
                material.abandon_step(token)
                raise ValueError(f'finite-j2: free-DOF residual {ratio!r} exceeds {FREE_RESIDUAL_BOUND} at step {index + 1}'
                                 ' (no converged equilibrium; nothing committed)')
            problem.updateYourself(step)
            material.commit_accepted(step.giveNumber(), token, float(ratio))
            gp = element.giveDefaultIntegrationRulePtr().getIntegrationPoint(0)
            native = {}
            for key, kind in (('F9', fem.InternalStateType.IST_DeformationGradientTensor),
                              ('P9', fem.InternalStateType.IST_FirstPKStressTensor),
                              ('S6', fem.InternalStateType.IST_StressTensor)):
                answer = fem.FloatArray()
                element.giveIPValue(answer, gp, kind, step)
                native[key] = [float(v) for v in answer]
            status = material.statuses[0]
            converged = status.converged
            records.append({'step': index + 1, 'freeResidualRatio': ratio,
                            'callbacks': [material.stressCalls - calls[0], material.tangentCalls - calls[1]],
                            'displacementMm': [[float(domain.giveDofManager(m + 1).giveDofWithID(d).giveUnknown(
                                fem.ValueModeType.VM_Total, step)) for d in ids] for m in range(4)],
                            'native': native, 'committedBefore': before, 'alpha': status.committed['alpha'],
                            'tau': converged['tau'], 'P': converged['P'], 'S': converged['S'], 'sigma': converged['sigma'],
                            'J': converged['J'], 'plastic': converged['plastic'], 'dissipation': converged['dissipation'],
                            'plasticWork': converged['plasticWork'],
                            'storedHardeningIncrement': converged['storedHardeningIncrement'],
                            'statusClass': str(gp.giveMaterialStatus().giveClassName())})
        return json.dumps({'schema': NATIVE_SCHEMA, 'records': records, 'refusedCommits': material.refusedCommits},
                          allow_nan=False)
    except Exception as error:
        primary = error
        if token is not None and material._token() == token:
            try:
                material.abandon_step(token)
            except Exception as cleanup_error:
                error.add_note(f'Additional abandon_step error: {cleanup_error!r}')
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except Exception as cleanup_error:
            if primary is None:
                raise
            primary.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')
