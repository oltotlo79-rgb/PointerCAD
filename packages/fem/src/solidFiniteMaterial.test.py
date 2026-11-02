"""Independent checks of solidFiniteMaterial.py (EX-09 W33): tension, shear and superposed-rotation histories.

Run: python -B -X utf8 solidFiniteMaterial.test.py -v   (host Python with NumPy, like beamFrictionContact.test.py)

Expectations are closed forms or an independent NumPy implementation; nothing is back-computed from the module.
Units N-mm-MPa; E 200000, nu 0.3, sigma_y 250, H 1000 (G = E / (2 (1 + nu)), K = E / (3 (1 - 2 nu))).

Closed forms (logarithmic strain, fixed principal axes, isotropic J2, linear isotropic hardening; for coaxial
proportional paths the exponential-map return is exact, so they hold step by step):
  isochoric tension F = diag(s, s^-1/2, s^-1/2), J = 1, plastic strain p along diag(1, -1/2, -1/2), hardening alpha:
    tau11 = 2 G (ln s - p), tau22 = tau33 = -tau11 / 2, q = |tau11 - tau22| = 3 G |ln s - p|;
    first loading:   p = alpha = (3 G ln s - sy) / (3 G + H)  when 3 G ln s > sy;
    elastic unloading: p, alpha frozen while 3 G |ln s - p| <= sy + H alpha;
    reverse yielding: p = (3 G ln s + sy + H (alpha_max + p_max)) / (3 G + H), alpha = alpha_max + p_max - p.
  P = tau F^-T, S = F^-1 tau F^-T, Cauchy sigma = tau / J; plastic incompressibility det Cp^-1 = 1.
  one-increment simple shear F = I + g e1 x e2 from the virgin state: b = F F^T has principal stretches
    l_+- = sqrt(1 + g^2 / 4) +- g / 2 (l_+ l_- = 1) with the major direction at theta = atan2(2, g) / 2, so
    eps_tr = ln(l_+) (n+ x n+ - n- x n-) (deviatoric), q_tr = 2 sqrt(3) G ln(l_+); if q_tr > sy the radial return gives
    dgamma = (q_tr - sy) / (3 G + H) and tau = 2 G (1 - 3 G dgamma / q_tr) eps_tr.
  objectivity: for F' = Q F with any rotation Q: tau' = Q tau Q^T, P' = Q P, S' = S, alpha' = alpha, Cp^-1' = Cp^-1,
    dP'/dF' (iJkL) = Q_ia Q_kb dP/dF (aJbL).
  work conjugacy: P : dF = S : dE (dE = sym(F^T dF)) = tau : sym(dF F^-1) = J sigma : sym(dF F^-1).
Tangent: the module's dP/dF and dS/dE (forward-mode derivative of its own rational matrix algorithms) are compared
with central differences of a separate NumPy implementation of the same law (eigen-decomposition log/exp) from the
same committed state.
"""
import copy
import importlib.util
import math
import pathlib
import sys
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('solid_finite_material',
                                              pathlib.Path(__file__).with_name('solidFiniteMaterial.py'))
fm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fm)

E, NU, SY, H = 200000.0, 0.3, 250.0, 1000.0
G = E / (2 * (1 + NU))
K = E / (3 * (1 - 2 * NU))
PARAMS = fm.read_parameters({'youngMPa': E, 'poisson': NU, 'yieldStressMPa': SY, 'hardeningModulusMPa': H})


def m3(values):
    return np.array(values, dtype=float).reshape(3, 3)


def rel(a, b, scale=None):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    s = scale if scale is not None else max(np.abs(b).max(), 1e-300)
    return float(np.abs(a - b).max() / s)


def rotation(axis, angle):
    a = np.asarray(axis, dtype=float)
    a = a / np.linalg.norm(a)
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * k @ k


# ---- separate NumPy implementation of the same law (spectral log/exp), used only as an independent reference ----
def spd_log(a):
    w, v = np.linalg.eigh(0.5 * (a + a.T))
    return v @ np.diag(np.log(w)) @ v.T


def sym_exp(a):
    w, v = np.linalg.eigh(0.5 * (a + a.T))
    return v @ np.diag(np.exp(w)) @ v.T


def reference_update(f, cp_inv, alpha):
    f = np.asarray(f, dtype=float).reshape(3, 3)
    be_tr = f @ np.asarray(cp_inv, dtype=float).reshape(3, 3) @ f.T
    eps_tr = 0.5 * spd_log(be_tr)
    dev_tr = eps_tr - np.trace(eps_tr) / 3 * np.eye(3)
    q_tr = math.sqrt(1.5) * 2 * G * np.linalg.norm(dev_tr)
    dgamma = 0.0
    eps = eps_tr
    if q_tr > SY + H * alpha:
        dgamma = (q_tr - SY - H * alpha) / (3 * G + H)
        eps = eps_tr - dgamma * 1.5 * (2 * G * dev_tr) / q_tr
    tau = K * np.trace(eps) * np.eye(3) + 2 * G * (eps - np.trace(eps) / 3 * np.eye(3))
    finv = np.linalg.inv(f)
    return {'tau': tau, 'P': tau @ finv.T, 'S': finv @ tau @ finv.T, 'alpha': alpha + dgamma,
            'cpInv': finv @ sym_exp(2 * eps) @ finv.T, 'eps': eps, 'epsTrial': eps_tr}


def reference_s_of_e(e6, cp_inv, alpha):
    e = np.array([[e6[0], e6[5] / 2, e6[4] / 2], [e6[5] / 2, e6[1], e6[3] / 2], [e6[4] / 2, e6[3] / 2, e6[2]]])
    c = np.eye(3) + 2 * e
    w, v = np.linalg.eigh(c)
    u = v @ np.diag(np.sqrt(w)) @ v.T
    s = reference_update(u, cp_inv, alpha)['S']
    return np.array([s[0, 0], s[1, 1], s[2, 2], s[1, 2], s[0, 2], s[0, 1]])


def run_history(fs, state=None):
    state = fm.initial_state() if state is None else state
    rows = []
    for f in fs:
        r = fm.evaluate(list(np.asarray(f, dtype=float).reshape(9)), state, PARAMS, tangent=True)
        rows.append((r, state))
        state = r['state']
    return rows, state


def isochoric(s):
    return np.diag([s, s ** -0.5, s ** -0.5])


def tension_closed_form(history):
    """Signed plastic strain p and accumulated alpha for isochoric uniaxial histories (closed forms above)."""
    p, alpha, out = 0.0, 0.0, []
    for s in history:
        e = math.log(s)
        q_signed = 3 * G * (e - p)
        if q_signed > SY + H * alpha:            # forward yielding: dp = dalpha > 0
            p_new = (3 * G * e - SY - H * alpha + H * p) / (3 * G + H)
            alpha += p_new - p
            p = p_new
        elif -q_signed > SY + H * alpha:         # reverse yielding: dp = -dalpha < 0
            p_new = (3 * G * e + SY + H * alpha + H * p) / (3 * G + H)
            alpha += p - p_new
            p = p_new
        out.append({'tau11': 2 * G * (e - p), 'alpha': alpha, 'p': p})
    return out


class Tension(unittest.TestCase):
    def test_isochoric_tension_unloading_and_reverse_yield_match_closed_form(self):
        # Elastic range after loading to 1.3: |ln s - p| <= (sy + H alpha) / (3 G), i.e. down to s ~ 1.2943; 1.2955 stays
        # elastic, then the path reverses into compressive yielding down to 0.85.
        history = list(np.linspace(1.0, 1.3, 31)[1:]) + list(np.linspace(1.3, 1.2955, 5)[1:]) \
            + list(np.linspace(1.2955, 0.85, 41)[1:])
        rows, _ = run_history([isochoric(s) for s in history])
        expected = tension_closed_form(history)
        saw = {'forward': False, 'elastic-unload': False, 'reverse': False}
        for s, (r, before), exp in zip(history, rows, expected):
            tau, scale = m3(r['tau']), SY + H * exp['alpha']
            self.assertLessEqual(abs(tau[0, 0] - exp['tau11']) / scale, 1e-10, (s, tau[0, 0], exp))
            self.assertLessEqual(rel(np.diag(tau)[1:], [-exp['tau11'] / 2] * 2, scale), 1e-10)
            self.assertLessEqual(np.abs(tau - np.diag(np.diag(tau))).max() / scale, 1e-10)
            self.assertLessEqual(abs(r['state']['alpha'] - exp['alpha']), 1e-12, s)
            f = isochoric(s)
            self.assertLessEqual(rel(r['P'], (tau @ np.linalg.inv(f).T).reshape(9), scale), 1e-12)
            self.assertLessEqual(rel(r['S'], (np.linalg.inv(f) @ tau @ np.linalg.inv(f).T).reshape(9), scale), 1e-12)
            self.assertLessEqual(abs(r['J'] - 1.0), 1e-14)
            self.assertLessEqual(rel(r['sigma'], r['tau'], scale), 1e-13)
            self.assertLessEqual(abs(np.linalg.det(m3(r['state']['cpInv'])) - 1.0), 1e-12)
            self.assertGreaterEqual(r['dissipation'], -1e-10)
            if r['plastic']:
                self.assertLessEqual(abs(r['q'] - (SY + H * r['state']['alpha'])) / scale, 1e-10)
            moved = r['state']['alpha'] - before['alpha']
            if moved > 0 and exp['p'] > 0 and s > 1.0 and history.index(s) < 30:
                saw['forward'] = True
            if moved == 0 and 1.2955 <= s < 1.3:
                saw['elastic-unload'] = True
            if moved > 0 and exp['tau11'] < 0:
                saw['reverse'] = True
        self.assertEqual(saw, {'forward': True, 'elastic-unload': True, 'reverse': True})
        self.assertGreater(rows[29][0]['state']['alpha'], 0.2)  # real plastic flow, not an elastic-only history


class Shear(unittest.TestCase):
    def test_one_increment_simple_shear_matches_closed_form_log_strain_and_radial_return(self):
        for g in (0.2, 0.6, 1.0):
            r = fm.evaluate([1.0, g, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], fm.initial_state(), PARAMS)
            lam = math.sqrt(1 + g * g / 4) + g / 2
            theta = 0.5 * math.atan2(2.0, g)
            n_major = np.array([math.cos(theta), math.sin(theta), 0.0])
            n_minor = np.array([-math.sin(theta), math.cos(theta), 0.0])
            eps_tr = math.log(lam) * (np.outer(n_major, n_major) - np.outer(n_minor, n_minor))
            self.assertLessEqual(rel(r['epsTrial'], eps_tr.reshape(9), math.log(lam)), 1e-12, g)
            q_tr = 2 * math.sqrt(3) * G * math.log(lam)
            self.assertGreater(q_tr, SY)
            dgamma = (q_tr - SY) / (3 * G + H)
            tau = 2 * G * (1 - 3 * G * dgamma / q_tr) * eps_tr
            self.assertLessEqual(rel(r['tau'], tau.reshape(9)), 1e-11, g)
            self.assertLessEqual(abs(r['dgamma'] - dgamma) / dgamma, 1e-11)
            self.assertAlmostEqual(r['q'], SY + H * dgamma, delta=1e-9 * SY)

    def test_simple_shear_history_with_unloading_keeps_invariants_and_matches_spectral_reference(self):
        # The elastic shear range at q ~ 750 MPa is about 2 q / (sqrt(3) G) ~ 0.011, so 1.0 -> 0.995 unloads elastically
        # and 0.995 -> 0.4 yields in reverse.
        gammas = list(np.linspace(0.0, 1.0, 101)[1:]) + list(np.linspace(1.0, 0.995, 5)[1:]) \
            + list(np.linspace(0.995, 0.4, 60)[1:])
        fs = [np.array([[1.0, g, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]) for g in gammas]
        rows, _ = run_history(fs)
        ref_cp, ref_alpha = np.eye(3), 0.0
        plastic_steps, unload_elastic = 0, 0
        for f, (r, before) in zip(fs, rows):
            ref = reference_update(f, ref_cp, ref_alpha)
            scale = SY + H * r['state']['alpha']
            self.assertLessEqual(rel(r['tau'], ref['tau'].reshape(9), scale), 1e-10)
            self.assertLessEqual(abs(r['state']['alpha'] - ref['alpha']), 1e-12)
            self.assertLessEqual(rel(r['state']['cpInv'], ref['cpInv'].reshape(9), 1.0), 1e-11)
            ref_cp, ref_alpha = ref['cpInv'], ref['alpha']
            self.assertLessEqual(abs(np.trace(m3(r['tau']))) / scale, 1e-10)      # J = 1 and det Fp = 1
            self.assertLessEqual(abs(np.linalg.det(m3(r['state']['cpInv'])) - 1.0), 1e-12)
            self.assertGreaterEqual(r['dissipation'], -1e-10)
            self.assertGreaterEqual(r['plasticWork'], -1e-10)
            self.assertGreaterEqual(r['state']['alpha'], before['alpha'])
            # Energy of the step (independent formulas): endpoint plastic work q_{n+1} dgamma, exact stored hardening
            # H/2 (alpha_{n+1}^2 - alpha_n^2), backward-Euler dissipation sigma_y dgamma, work - stored = sy dg + H dg^2/2.
            dg, a0, a1 = r['dgamma'], before['alpha'], r['state']['alpha']
            tol = 1e-9 * max(1.0, r['q'] * dg)
            self.assertAlmostEqual(r['plasticWork'], r['q'] * dg, delta=tol)
            self.assertAlmostEqual(r['storedHardeningIncrement'], 0.5 * H * (a1 * a1 - a0 * a0), delta=tol)
            self.assertAlmostEqual(r['workMinusStoredHardening'], SY * dg + 0.5 * H * dg * dg, delta=tol)
            self.assertGreaterEqual(r['workMinusStoredHardening'], -1e-10)
            if r['plastic']:
                plastic_steps += 1
                self.assertLessEqual(abs(r['q'] - scale) / scale, 1e-10)
                self.assertAlmostEqual(r['dissipation'], SY * r['dgamma'], delta=1e-9 * max(1.0, SY * r['dgamma']))
            elif before['alpha'] > 0:
                unload_elastic += 1
        self.assertGreater(plastic_steps, 50)
        self.assertGreaterEqual(unload_elastic, 4)


class SuperposedRotation(unittest.TestCase):
    def test_rotated_histories_are_objective_including_tangent(self):
        n = 40
        tension = [isochoric(s) for s in np.linspace(1.0, 1.25, n + 1)[1:]]
        shear = [np.array([[1.0, g, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]) for g in np.linspace(0.0, 0.8, n + 1)[1:]]
        for name, fs in (('tension', tension), ('shear', shear)):
            qs = [rotation((1.0, 2.0, 3.0), math.radians(200.0) * (k + 1) / n) for k in range(n)]
            base, _ = run_history(fs)
            turned, _ = run_history([q @ f for q, f in zip(qs, fs)])
            self.assertTrue(any(r['plastic'] for r, _ in base), name)
            for q, (a, _), (b, _) in zip(qs, base, turned):
                ta, tb = m3(a['tau']), m3(b['tau'])
                scale = np.abs(ta).max()
                self.assertLessEqual(rel(tb, q @ ta @ q.T, scale), 1e-8, name)
                self.assertLessEqual(rel(m3(b['sigma']), q @ m3(a['sigma']) @ q.T, scale), 1e-8, name)
                self.assertLessEqual(rel(m3(b['P']), q @ m3(a['P']), np.abs(a['P']).max()), 1e-8, name)
                self.assertLessEqual(rel(b['S'], a['S'], np.abs(a['S']).max()), 1e-8, name)
                self.assertLessEqual(abs(b['state']['alpha'] - a['state']['alpha']), 1e-12, name)
                self.assertLessEqual(rel(b['state']['cpInv'], a['state']['cpInv'], 1.0), 1e-8, name)
                aa = np.array(a['dPdF']).reshape(3, 3, 3, 3)
                bb = np.array(b['dPdF']).reshape(3, 3, 3, 3)
                rotated = np.einsum('ia,kb,aJbL->iJkL', q, q, aa)
                self.assertLessEqual(rel(bb, rotated, np.abs(aa).max()), 1e-8, name)


class Tangent(unittest.TestCase):
    def points(self):
        """(name, F, committed state) with elastic, first-yield, hardening, reverse and shear points."""
        out = []
        rows, _ = run_history([isochoric(s) for s in np.linspace(1.0, 1.3, 31)[1:]])
        out.append(('elastic step', isochoric(1.0005), fm.initial_state()))
        out.append(('first yield', isochoric(1.002), fm.initial_state()))
        out.append(('tension hardening', isochoric(1.3), rows[28][0]['state']))
        out.append(('reverse plastic', isochoric(0.95), rows[29][0]['state']))
        shear, _ = run_history([np.array([[1.0, g, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]) for g in np.linspace(0, 0.6, 31)[1:]])
        out.append(('shear plastic', np.array([[1.0, 0.62, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]), shear[-1][0]['state']))
        q = rotation((0.3, -1.0, 0.7), 2.4)
        general = q @ np.array([[1.12, 0.07, -0.03], [0.04, 0.93, 0.05], [-0.02, 0.06, 0.97]])
        out.append(('general rotated plastic', general, shear[-1][0]['state']))
        return out

    def test_dPdF_matches_central_difference_of_separate_reference(self):
        h = 1e-6
        for name, f, state in self.points():
            got = np.array(fm.evaluate(list(f.reshape(9)), state, PARAMS, tangent=True)['dPdF'])
            fd = np.zeros((9, 9))
            for k in range(9):
                fp, fmn = f.reshape(9).copy(), f.reshape(9).copy()
                fp[k] += h
                fmn[k] -= h
                fd[:, k] = (reference_update(fp, state['cpInv'], state['alpha'])['P'].reshape(9)
                            - reference_update(fmn, state['cpInv'], state['alpha'])['P'].reshape(9)) / (2 * h)
            self.assertLessEqual(rel(got, fd, np.abs(fd).max()), 1e-5, name)

    def test_dSdE_matches_central_difference_of_separate_reference(self):
        h = 1e-7
        for name, f, state in self.points():
            c = f.T @ f
            e = 0.5 * (c - np.eye(3))
            e6 = [e[0, 0], e[1, 1], e[2, 2], 2 * e[1, 2], 2 * e[0, 2], 2 * e[0, 1]]
            got = fm.evaluate_lagrangian(e6, state, PARAMS, tangent=True)
            self.assertLessEqual(rel(got['S'], reference_update(f, state['cpInv'], state['alpha'])['S'].reshape(9)), 1e-10, name)
            fd = np.zeros((6, 6))
            for k in range(6):
                ep, em = list(e6), list(e6)
                ep[k] += h
                em[k] -= h
                fd[:, k] = (reference_s_of_e(ep, state['cpInv'], state['alpha'])
                            - reference_s_of_e(em, state['cpInv'], state['alpha'])) / (2 * h)
            self.assertLessEqual(rel(got['dSdE'], fd, np.abs(fd).max()), 1e-5, name)


class StateAndConjugacy(unittest.TestCase):
    def test_trial_state_does_not_accumulate_and_rejected_steps_do_not_commit(self):
        rows, committed = run_history([isochoric(s) for s in (1.002, 1.01)])
        frozen = copy.deepcopy(committed)
        f_final = list(isochoric(1.02).reshape(9))
        first = fm.evaluate(f_final, committed, PARAMS)
        for s in (1.05, 1.015, 0.99, 1.03):   # Newton iterates / a rejected trial step, never committed
            fm.evaluate(list(isochoric(s).reshape(9)), committed, PARAMS, tangent=True)
        again = fm.evaluate(f_final, committed, PARAMS)
        self.assertEqual(committed, frozen)
        self.assertEqual(first['state'], again['state'])
        self.assertEqual(first['tau'], again['tau'])
        self.assertTrue(first['plastic'])
        self.assertGreater(first['state']['alpha'], committed['alpha'])

    def test_work_conjugate_measures(self):
        rng = np.random.default_rng(7)
        rows, _ = run_history([np.array([[1.0, g, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]) for g in np.linspace(0, 0.5, 26)[1:]])
        f = rotation((1, 1, 0), 0.7) @ np.array([[1.08, 0.5, 0.02], [0.01, 0.97, 0.03], [0.0, 0.02, 1.01]])
        r = fm.evaluate(list(f.reshape(9)), rows[-1][0]['state'], PARAMS)
        p, s, tau, sigma, j = m3(r['P']), m3(r['S']), m3(r['tau']), m3(r['sigma']), r['J']
        self.assertAlmostEqual(j, np.linalg.det(f), delta=1e-14)
        for _ in range(5):
            d_f = rng.normal(size=(3, 3))
            d_e = 0.5 * (f.T @ d_f + d_f.T @ f)
            d = 0.5 * (d_f @ np.linalg.inv(f) + (d_f @ np.linalg.inv(f)).T)
            work = np.sum(p * d_f)
            scale = np.abs(p).max() * np.abs(d_f).max()
            self.assertLessEqual(abs(np.sum(s * d_e) - work) / scale, 1e-12)
            self.assertLessEqual(abs(np.sum(tau * d) - work) / scale, 1e-12)
            self.assertLessEqual(abs(j * np.sum(sigma * d) - work) / scale, 1e-12)

    def test_invalid_input_is_refused(self):
        good = {'youngMPa': E, 'poisson': NU, 'yieldStressMPa': SY, 'hardeningModulusMPa': H}
        for key, value in (('youngMPa', 0.0), ('poisson', 0.5), ('poisson', -0.1), ('yieldStressMPa', 0.0),
                           ('hardeningModulusMPa', -1.0), ('youngMPa', True), ('youngMPa', math.nan), ('poisson', math.inf)):
            with self.assertRaises(ValueError):
                fm.read_parameters({**good, key: value})
        with self.assertRaises(ValueError):
            fm.read_parameters({k: v for k, v in good.items() if k != 'poisson'})
        for f in ([1, 0, 0, 0, 1, 0, 0, 0, -1], [1, 0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0, 0, 0, math.nan],
                  [1, 0, 0, 0, 1, 0, 0, 0]):
            with self.assertRaises(ValueError):
                fm.evaluate(f, fm.initial_state(), PARAMS)
        with self.assertRaises(ValueError):
            fm.evaluate_lagrangian([0.0] * 5, fm.initial_state(), PARAMS)


class _FakeArray(list):
    def __init__(self, n=0):
        super().__init__([0.0] * n)


class _FakeMatrix:
    def __init__(self, rows, cols):
        self.values = [[0.0] * cols for _ in range(rows)]

    def __setitem__(self, key, value):
        self.values[key[0]][key[1]] = value


class _FakeStatusBase:
    """Binding double of the native StructuralMaterialStatus records the adapter touches."""
    def __init__(self, gp):
        self.strain, self.tempStrain, self.stress, self.tempStress = [0.0] * 6, [0.0] * 6, [0.0] * 6, [0.0] * 6

    def letTempStrainVectorBe(self, values):
        self.tempStrain = [float(v) for v in values]

    def letTempStressVectorBe(self, values):
        self.tempStress = [float(v) for v in values]

    def giveStrainVector(self):
        return list(self.strain)

    def native_update(self):      # structuralms.C updateYourself: temp -> committed
        self.strain, self.stress = list(self.tempStrain), list(self.tempStress)

    def native_init_temp(self):   # structuralms.C initTempStatus: committed -> temp
        self.tempStrain, self.tempStress = list(self.strain), list(self.stress)


class _FakeFem:
    FloatArray = _FakeArray
    FloatMatrix = _FakeMatrix
    StructuralMaterialStatus = _FakeStatusBase

    class StructuralMaterial:
        def __init__(self, number, domain):
            pass

    class MaterialMode:
        _3dMat = '3d'

    class IntegrationPointStatusIDType:
        IPSID_Default = 0


class _FakeGp:
    def __init__(self):
        self.status = None

    def hasMaterialStatus(self):
        return self.status is not None

    def setMaterialStatus(self, status, key):
        self.status = status

    def giveMaterialStatus(self):
        return self.status


def _e6(f):
    e = 0.5 * (f.T @ f - np.eye(3))
    return [e[0, 0], e[1, 1], e[2, 2], 2 * e[1, 2], 2 * e[0, 2], 2 * e[0, 1]]


class AdapterOwnership(unittest.TestCase):
    """Adapter state contract on a binding double (not native evidence): attempts, stale caches, refused commits."""
    def test_attempt_ownership_stale_tangent_and_refused_commits(self):
        material = fm.make_oofem_material(_FakeFem, 1, None, {'youngMPa': E, 'poisson': NU, 'yieldStressMPa': SY,
                                                            'hardeningModulusMPa': H})
        gp = _FakeGp()
        with self.assertRaisesRegex(ValueError, 'outside an open step attempt'):
            material.giveRealStressVector_3d(_e6(isochoric(1.01)), gp, None)
        token1 = material.begin_step(1)
        material.giveRealStressVector_3d(_e6(isochoric(1.01)), gp, None)
        status = gp.status
        with self.assertRaisesRegex(ValueError, 'refused .*not the open attempt'):
            material.commit_accepted(1, '1:999', 0.0)
        with self.assertRaisesRegex(ValueError, 'refused .*not the open attempt'):
            material.commit_accepted(2, token1, 0.0)
        with self.assertRaisesRegex(ValueError, 'refused .*free-DOF residual'):
            material.commit_accepted(1, token1, 1e-6)
        with self.assertRaisesRegex(ValueError, 'refused .*native update missing'):
            material.commit_accepted(1, token1, 0.0)
        self.assertEqual((status.committed['alpha'], status.commits), (0.0, 0))
        status.native_update()
        material.commit_accepted(1, token1, 0.0)
        alpha1 = status.committed['alpha']
        self.assertGreater(alpha1, 0.0)
        with self.assertRaisesRegex(ValueError, 'not the open attempt'):
            material.commit_accepted(1, token1, 0.0)        # closed token
        with self.assertRaisesRegex(ValueError, 'already accepted'):
            material.begin_step(1)
        # A rejected large trial of step 2, native temps reset, then the stiffness asked before any stress.
        token2 = material.begin_step(2)
        material.giveRealStressVector_3d(_e6(isochoric(1.1)), gp, None)
        stale = [row[:] for row in status.last['dSdE']]
        material.abandon_step(token2)
        status.native_init_temp()
        self.assertIsNone(status.last)
        self.assertEqual(status.committed['alpha'], alpha1)
        with self.assertRaisesRegex(ValueError, 'no further attempt'):
            material.begin_step(2)
        with self.assertRaisesRegex(ValueError, 'no further attempt'):
            material.begin_step(3)
        # A fresh material: the first tangent of step 2 (before any stress) is the committed-point tangent, not the
        # cached step-1 trial tangent.
        fresh = fm.make_oofem_material(_FakeFem, 1, None, {'youngMPa': E, 'poisson': NU, 'yieldStressMPa': SY,
                                                         'hardeningModulusMPa': H})
        gp2 = _FakeGp()
        t1 = fresh.begin_step(1)
        fresh.giveRealStressVector_3d(_e6(isochoric(1.01)), gp2, None)
        cached = [row[:] for row in gp2.status.last['dSdE']]
        gp2.status.native_update()
        fresh.commit_accepted(1, t1, 0.0)
        fresh.begin_step(2)
        first = fresh.give3dMaterialStiffnessMatrix(None, gp2, None).values
        expected = fm.evaluate_lagrangian(gp2.status.committedE, gp2.status.committed, PARAMS, tangent=True)['dSdE']
        self.assertEqual(first, expected)
        self.assertGreater(rel(cached, expected), 1e-3)          # the step-1 trial tangent differs: it was discarded
        self.assertGreater(rel(stale, expected), 1e-3)


class _DriverFem(_FakeFem):
    class DofIDItem:
        D_u, D_v, D_w = 1, 2, 3

    class CharType:
        InternalForcesVector = 1

    class ValueModeType:
        VM_Total = 1


class _DriverStep:
    def giveNumber(self):
        return 1


class _DriverElement:
    """Element double: fixed native internal forces; any post-commit IP read fails."""
    def __init__(self, forces):
        self.forces = forces

    def giveCharacteristicVector(self, target, *args):
        target.extend(self.forces)

    def giveDefaultIntegrationRulePtr(self):
        raise RuntimeError('controlled post-commit read failure')


class _DriverDomain:
    def __init__(self, element):
        self.element = element

    def giveElement(self, number):
        return self.element


class _DriverProblem:
    """Problem double of the native step sequence; `fail` selects where it raises."""
    def __init__(self, material, gp, fail):
        self.material, self.gp, self.fail, self.terminated, self.raised = material, gp, fail, False, None

    def preInitializeNextStep(self):
        pass

    def giveNextStep(self):
        return _DriverStep()

    def initializeYourself(self, step):
        pass

    def solveYourselfAt(self, step):
        self.material.giveRealStressVector_3d(_e6(isochoric(1.1)), self.gp, step)
        if self.fail == 'solve':
            self.raised = RuntimeError('controlled non-convergence')
            raise self.raised

    def updateYourself(self, step):
        if self.fail == 'update':
            self.raised = RuntimeError('controlled update failure')
            raise self.raised
        if self.fail != 'skip-native-update':
            self.gp.status.native_update()

    def terminateAnalysis(self):
        self.terminated = True


class DriverBoundaries(unittest.TestCase):
    """run_native_tet / free_residual_ratio boundaries on binding doubles (review counterexamples; not native evidence)."""
    def drive(self, fail=None, forces=None, abandon_error=None):
        material = fm.make_oofem_material(_DriverFem, 1, None, {'youngMPa': E, 'poisson': NU, 'yieldStressMPa': SY,
                                                               'hardeningModulusMPa': H})
        gp = _FakeGp()
        problem = _DriverProblem(material, gp, fail)
        domain = _DriverDomain(_DriverElement([0.0] * 12 if forces is None else forces))
        if abandon_error is not None:
            def failing_abandon(token):
                raise abandon_error
            material.abandon_step = failing_abandon
        original = fm.prepare_native_tet
        fm.prepare_native_tet = lambda *args: (problem, domain, material, [(2, 1)])
        try:
            with self.assertRaises(Exception) as caught:
                fm.run_native_tet(_DriverFem, [], {}, 1, {})
        finally:
            fm.prepare_native_tet = original
        self.assertTrue(problem.terminated)
        return material, gp.status, problem, caught.exception

    def assertAbandoned(self, material, status):
        self.assertIsNone(material.attempt)
        self.assertEqual(material.abandonedSteps, [1])
        self.assertEqual((status.trial, status.trialE, status.last, status.trialToken), (None, None, None, None))
        self.assertEqual((status.committed, status.committedE, status.commits), (fm.initial_state(), [0.0] * 6, 0))
        with self.assertRaisesRegex(ValueError, 'no further attempt'):
            material.begin_step(2)

    def test_native_force_must_be_twelve_finite_numbers_before_the_ratio(self):
        def ratio(forces, free=((2, 1), (3, 2))):
            return fm.free_residual_ratio(_DriverFem, _DriverElement(forces), None, list(free))
        nan, inf = float('nan'), float('inf')
        for forces in ([nan] * 12, [0.0] * 11 + [nan], [1.0] * 11 + [inf], [0.0] * 5 + [-inf] + [0.0] * 6,
                       [0.0] * 11, [0.0] * 13, []):
            with self.assertRaisesRegex(ValueError, 'must be 12 finite numbers'):
                ratio(forces)
        self.assertEqual(ratio([0.0] * 12), 0.0)                 # zero scale: finite all-zero forces only
        forces = [0.0] * 12
        forces[3], forces[7], forces[11] = -4.0, 1e-9, -3e-9    # prescribed (1,0); free (2,1) and (3,2)
        self.assertAlmostEqual(ratio(forces), 7.5e-10, delta=1e-24)
        # Review counterexample: 12 NaN native forces used to give 0.0 and an accepted commit. Now the run refuses
        # before commit_accepted is reached and the open attempt is abandoned.
        material, status, _, error = self.drive(forces=[nan] * 12)
        self.assertIsInstance(error, ValueError)
        self.assertIn('must be 12 finite numbers', str(error))
        self.assertEqual(material.refusedCommits, [])
        self.assertAbandoned(material, status)

    def test_driver_exception_abandons_only_the_open_attempt_and_keeps_the_original_error(self):
        # Review counterexample: the solver raises after a trial was evaluated (attempt (1, 1) used to stay open).
        for fail in ('solve', 'update'):
            material, status, problem, error = self.drive(fail=fail)
            self.assertIs(error, problem.raised)
            self.assertFalse(hasattr(error, '__notes__'))
            self.assertAbandoned(material, status)
        # The commit itself raises (native update missing): refused once, then the attempt is abandoned.
        material, status, _, error = self.drive(fail='skip-native-update')
        self.assertIn('native update missing', str(error))
        self.assertEqual(len(material.refusedCommits), 1)
        self.assertAbandoned(material, status)
        # Residual rejection (previous abort behaviour): abandoned exactly once, by the rejection itself.
        material, status, _, error = self.drive(forces=[1.0] * 12)
        self.assertIn('exceeds', str(error))
        self.assertAbandoned(material, status)
        # Failure after an accepted commit: the closed attempt is not abandoned and the committed history is kept.
        material, status, _, error = self.drive()
        self.assertEqual(str(error), 'controlled post-commit read failure')
        self.assertEqual((material.attempt, material.abandonedSteps, material.acceptedSteps, status.commits),
                         (None, [], [1], 1))
        self.assertAlmostEqual(status.committed['alpha'], (3 * G * math.log(1.1) - SY) / (3 * G + H), delta=1e-12)
        with self.assertRaisesRegex(ValueError, 'already accepted'):
            material.begin_step(1)
        # Cleanup failure: the original error is re-raised with the cleanup error attached as a note.
        material, status, problem, error = self.drive(fail='solve', abandon_error=RuntimeError('controlled abandon failure'))
        self.assertIs(error, problem.raised)
        self.assertEqual(error.__notes__, ["Additional abandon_step error: RuntimeError('controlled abandon failure')"])
        self.assertEqual((status.committed, status.commits), (fm.initial_state(), 0))


CASES = 12
suite = unittest.TestSuite()
for case in (Tension, Shear, SuperposedRotation, Tangent, StateAndConjugacy, AdapterOwnership, DriverBoundaries):
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(case))
assert suite.countTestCases() == CASES, suite.countTestCases()
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)
print(f'solid-finite-material: {CASES} independent cases passed')
