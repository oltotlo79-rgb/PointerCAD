import { describe, expect, it } from 'vitest';
import { cantilever } from './analysisCases.testSupport.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { compareVerification } from './verificationComparison.testSupport.js';
import { bucklingInput, linearInput } from './verificationCases.testSupport.js';
import type { VerificationKind } from './verificationComparison.testSupport.js';
import { VERIFICATION_KINDS, validateVerificationReferences } from './verificationReferences.testSupport.js';
import type { FixtureDerivation } from './verificationReferences.testSupport.js';

type PublishedSource = Parameters<typeof validateVerificationReferences>[0][number];
/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const DERIVATION_STATEMENT = 'Independent algebraic derivation for this fixture by this repository; the cited sources support only the principle, formula and assumptions and did not test this fixture.';

const STUB = 'The publisher URL returned a 3,038-byte page (SHA-256 32ed63159c77e21ee19ca1b9aa3213ccf0218eb59539560b132a8e68ef0e18ea, identical for three different Springer URLs) without the text';

const VERIFICATION_SOURCES: readonly PublishedSource[] = [
  { id: 'moose-beam-vandv', url: 'https://raw.githubusercontent.com/idaholab/moose/master/modules/solid_mechanics/doc/content/modules/solid_mechanics/beam_vandv.md',
    title: 'Beams (Solid Mechanics module verification and validation), page source beam_vandv.md', authors: 'MOOSE Framework, Idaho National Laboratory',
    publication: 'idaholab/moose repository, master branch as served on 2026-11-03 (the rendered page mooseframework.inl.gov/modules/solid_mechanics/beam_vandv.html answered 403)',
    locator: 'Static cantilever test timoshenko_small_strain_y.i, Results: alpha = kAGL^2/(EI) and Delta = PL^3/(3EI) (1 + 3/alpha)',
    supports: 'Small-deformation Timoshenko cantilever tip deflection under an end load', applicability: 'Linear elastic prismatic cantilever, end point load, shear coefficient k',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:01:19+09:00', bytes: 14784, sha256: '7843145047270f4a6369b960e97c61c1520380176c88ac15a577c9f1117d8372',
      located: ['alpha = \\frac {kAGL^2}{EI}', '\\Delta = \\frac {PL^3}{3EI} \\; (1 + \\frac {3}{alpha})'] } },
  { id: 'tudelft-timoshenko', url: 'https://teachbooks.tudelft.nl/computational-modelling/structural_linear/timoshenko.html',
    title: '4.2. Timoshenko Beam (Computational Modelling teachbook)', authors: 'Colomes, Rocha, Van der Meer, Lesueur (TU Delft)',
    publication: 'TU Delft TeachBooks online book', locator: 'Section 4.2 heading only (text not retrieved)',
    supports: 'Timoshenko kinematics with shear deformation', applicability: 'Linear in-plane beams',
    confirmation: 'not-retrieved', unverifiedReason: 'TLS handshake timed out twice on 2026-11-03 (11:02, 11:05)' },
  { id: 'arizona-opti222-buckling', url: 'https://wp.optics.arizona.edu/optomech/wp-content/uploads/sites/53/2016/10/OPTI_222_W18.pdf',
    title: 'OPTI 222 Mechanical Design in Optical Engineering, buckling with other end conditions (file OPTI_222_W18)', authors: 'University of Arizona, College of Optical Sciences',
    publication: 'Course lecture notes PDF (no edition)', locator: 'Euler critical load Pcr = pi^2 EI/L^2; fixed and free (unguided) end: effective length Le = 2L; Pcr = pi^2 EI/Le^2',
    supports: 'Euler buckling load with effective length 2L for a fixed-free column', applicability: 'Ideal straight linear elastic column, fixed base, free loaded top',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:00:07+09:00', bytes: 674573, sha256: '92cda4801c52fd7de335422f5bc3a2e120b2072e9548a30fdcc4fc0867d9afd6',
      located: ['column with one fixed end and one free (unguided) end ... identical to a pinned end column with a length of 2L', 'for a column with one free end and one fixed end, we use an effective length of: Le = 2L', 'Euler\'s equation becomes Pcr = pi^2 EI/Le^2'] } },
  { id: 'govindjee-ch12', url: 'https://academic.oup.com/book/4888/chapter/147332313',
    title: 'Geometric Instability (Engineering Mechanics of Deformable Solids: A Presentation with Exercises)', authors: 'Sanjay Govindjee',
    publication: 'Oxford University Press, 2012; chapter DOI 10.1093/acprof:oso/9780199651641.003.0012', locator: 'Chapter 12 (text not retrieved)',
    supports: 'Euler buckling from equilibrium and stationary potential energy', applicability: 'Linearized buckling of an ideal elastic column',
    confirmation: 'not-retrieved', unverifiedReason: 'Publisher page answered HTTP 403 on 2026-11-03 11:00; access control not bypassed' },
  { id: 'felippa-afem-ch15', url: 'https://automatica.dei.unipd.it/old/public/Schenato/PSC/2010_2011/gruppo4-Building_termo_identification/IdentificazioneTermodinamica20062007/eggpsc/Simulatore%20termico/AFEM.Ch15.pdf',
    title: 'Chapter 15: The Linear Tetrahedron (Advanced Finite Element Methods)', authors: 'Carlos A. Felippa (University of Colorado Boulder)',
    publication: 'AFEM course notes, Chapter 15, copy hosted at Universita di Padova (the author\'s own site was not retrieved)',
    locator: 'Eq. (15.28) Ke = V B^T E B; Eq. (15.34) integral of zeta_i dV = V/4; Eq. (15.35) integral of zeta_i zeta_j dV = V/10 (i = j), V/20 (i != j)',
    supports: 'Constant-strain tetrahedron stiffness and the volume-coordinate integrals that give the consistent mass rho V/20 (1 + delta_ij)', applicability: 'Straight-sided 4-node linear tetrahedron, constant elastic moduli',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:00:11+09:00', bytes: 106319, sha256: 'a242ea05522ff533ff11beea35996cb1b34ad00aa714d17543b0cacd448f39c3',
      located: ['§15.4 The Element Stiffness Matrix, Ke = V BT E B (15.28)', '(15.34)', '(15.35)'] } },
  { id: 'yaw-1d-plasticity', url: 'https://gab.wallawalla.edu/~louie.yaw/plasticitypublications/1Dplasticity.pdf',
    title: 'Nonlinear Static - 1D Plasticity - Various Forms of Isotropic Hardening', authors: 'Louie L. Yaw (Walla Walla University)',
    publication: 'Tutorial PDF; notation follows Simo and Hughes [6] (no edition)',
    locator: '4.1 Derivation of Elasto-Plastic Tangent Modulus; Eq. (4.2) sigma = E(eps - eps_p); Box 5.2 1D Plasticity Algorithm With Linear Isotropic Hardening (G(alpha) = sigma_y + K alpha, Cep = EK/(E+K))',
    supports: 'Uniaxial linear isotropic hardening and its elasto-plastic tangent EK/(E+K)', applicability: 'One-dimensional (uniaxial) stress, rate-independent plasticity',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:00:13+09:00', bytes: 256030, sha256: '0ce01339d29fcd1c4eb2f456c138d323aea13f577f1f012f6eb38cd48eefc36f',
      located: ['4.1 Derivation of Elasto-Plastic Tangent Modulus', '(4.2)', 'Box 5.2: 1D Plasticity Algorithm With Linear Isotropic Hardening', 'Cep = EK/(E+K)'] } },
  { id: 'simo-hughes-1998', url: 'https://link.springer.com/book/10.1007/b98904',
    title: 'Computational Inelasticity', authors: 'J. C. Simo, T. J. R. Hughes',
    publication: 'Springer New York, Interdisciplinary Applied Mathematics 7, 1998; DOI 10.1007/b98904', locator: 'Chapter 1 (text not retrieved)',
    supports: 'One-dimensional plasticity with isotropic hardening (cited by the Yaw tutorial as its basis)', applicability: 'Uniaxial stress',
    confirmation: 'bibliographic-record', unverifiedReason: STUB },
  { id: 'zimmermann-sauer-2017', url: 'https://arxiv.org/pdf/1701.08742',
    title: 'Adaptive local surface refinement based on LR NURBS and its application to contact', authors: 'Christopher Zimmermann, Roger A. Sauer (AICES, RWTH Aachen)',
    publication: 'arXiv:1701.08742, version served on 2026-11-03', locator: 'Section 2 contact formulation: Eq. (2.9) penalty normal traction, (2.10) Coulomb sliding traction, (2.11) slip split into reversible and irreversible parts, (2.12) slip criterion fs = ||tt|| - mu p',
    supports: 'Penalty enforcement of normal contact and the Coulomb stick/slip criterion', applicability: 'Frictional contact with a constant penalty parameter; stick while fs < 0',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:02:46+09:00', bytes: 8465230, sha256: 'e2094e10c8624d3793bc7f216f7fecfb1160b8822058dfeb52f7fad618d97a99',
      located: ['(2.9)', '(2.10)', '(2.11)', '(2.12)'] } },
  { id: 'wriggers-2006', url: 'https://doi.org/10.1007/978-3-540-32609-0',
    title: 'Computational Contact Mechanics', authors: 'Peter Wriggers',
    publication: 'Springer, 2nd edition, 2006', locator: 'Penalty method and tangential contact sections (text not retrieved)',
    supports: 'Penalty regularization of stick with Coulomb friction', applicability: 'Frictional contact',
    confirmation: 'bibliographic-record', unverifiedReason: STUB },
  { id: 'moose-mechanical-contact-constraint', url: 'https://raw.githubusercontent.com/idaholab/moose/master/modules/contact/src/constraints/MechanicalContactConstraint.C',
    title: 'MechanicalContactConstraint.C (contact module source)', authors: 'MOOSE Framework, Idaho National Laboratory',
    publication: 'idaholab/moose repository, master (MOOSE stable) branch as served on 2026-11-03; the doxygen page mooseframework.inl.gov/docs/doxygen/modules/classMechanicalContactConstraint.html and its source listing answered 403',
    locator: 'Lines 640-673 case ContactFormulation::PENALTY: pen_force = penalty * (incremental slip + normal gap); capacity = friction coefficient * normal penalty force; tangential predictor capped to the capacity, otherwise MS_STICKING. Lines 704-736 TANGENTIAL_PENALTY: penalty * incremental slip with the same cap. Lines 1717-1734 getPenalty/getTangentialPenalty: penalty * nodalArea(node) when normalize_penalty',
    supports: 'Stick force proportional to the incremental slip through a tangential penalty, bounded by the Coulomb capacity mu times the normal penalty force', applicability: 'Node-face frictional contact, Coulomb model, area-normalized penalty; stick while the tangential predictor does not exceed the capacity',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:22:11+09:00', bytes: 75232, sha256: 'd22f0418c5dc917a57b85f448117bf35a44a1471c031d175795d6e008c37616d',
      located: ['case ContactFormulation::PENALTY:', 'pen_force = penalty * distance_vec;', 'const Real capacity(_friction_coefficient *', 'RealVectorValue inc_pen_force_tangential = penalty * pinfo->_incremental_slip;', 'if (tan_mag > capacity)', 'penalty *= nodalArea(node);'] } },
  { id: 'moose-penalty-friction-uo', url: 'https://raw.githubusercontent.com/idaholab/moose/master/modules/contact/src/userobjects/PenaltyFrictionUserObject.C',
    title: 'PenaltyFrictionUserObject.C (contact module source)', authors: 'MOOSE Framework, Idaho National Laboratory',
    publication: 'idaholab/moose repository, master (MOOSE stable) branch as served on 2026-11-03; the doxygen page mooseframework.inl.gov/docs/doxygen/modules/PenaltyFrictionUserObject_8C_source.html answered 403',
    locator: 'Lines 305-318: tangential trial traction = old tangential traction + penalty_friction * slip_distance (comment Simo 3.12); phi_trial = trial traction norm - friction coefficient * normal pressure; capped to the Coulomb limit when phi_trial > 0',
    supports: 'Tangential traction proportional to the slip through a penalty per unit area while below the Coulomb limit mu p', applicability: 'Mortar penalty friction, tractions per unit area; stick while phi_trial <= 0',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:22:12+09:00', bytes: 20045, sha256: '00e9e6821be74246c147cccb5364a3549c48df42fd0587bd04b76232b82d6b6d',
      located: ['old_tangential_traction + tangential_lm + penalty_friction * slip_distance;', 'ADReal phi_trial = tangential_trial_traction_norm - _friction_coefficient * normal_pressure;', 'if (phi_trial > 0.0)'] } },
  { id: 'felippa-guo-park-mass-templates', url: 'https://experts.colorado.edu/display/pubid_146231',
    title: 'Mass Matrix Templates: General Description and 1D Examples', authors: 'C. A. Felippa, Q. Guo, K. C. Park',
    publication: 'Archives of Computational Methods in Engineering (CU Experts record; volume/pages not read)', locator: 'Record page title and journal only',
    supports: 'Consistent mass of the 2-node bar', applicability: 'Prismatic 2-node bar with linear shape functions',
    confirmation: 'bibliographic-record', unverifiedReason: 'Only the CU Experts record page (18,730 bytes, SHA-256 8b577760c25d62f98a885aaa3796942c5f4f391e15ed20fa49291c21df9eec16) was retrieved; the article text was not' },
  { id: 'simo-tarnow-1992', url: 'https://doi.org/10.1007/BF00913408',
    title: 'The discrete energy-momentum method. Conserving algorithms for nonlinear elastodynamics', authors: 'J. C. Simo, N. Tarnow',
    publication: 'Zeitschrift fur angewandte Mathematik und Physik (ZAMP) 43(5), 757-792, 1992; DOI from a citing reference list', locator: 'Whole article (text not retrieved)',
    supports: 'Energy-conserving implicit time integration', applicability: 'Undamped elastodynamics',
    confirmation: 'bibliographic-record', unverifiedReason: STUB },
  { id: 'felippa-ifem-ch31', url: 'https://quickfem.com/wp-content/uploads/IFEM.Ch31.pdf',
    title: 'Chapter 31: Lumped and Consistent Mass Matrices (IFEM course notes)', authors: 'Carlos A. Felippa (IFEM chapter series; the name is not in the extracted text of this copy)',
    publication: 'IFEM Chapter 31 PDF, copy hosted at quickfem.com (the colorado.edu IFEM.Ch31.pdf URL answered 404 on 2026-11-03)',
    locator: 'Section 31.2: Eq. (31.4) Me = integral of rho (Nv)^T Nv over the element, called the consistent mass matrix when Nv = N; 2-node prismatic bar shape functions Ni = 1 - zeta, Nj = zeta with dx = l dzeta; Eq. (31.5) Me_C = rho A l/6 [[2, 1], [1, 2]]',
    supports: 'Consistent mass definition M = integral rho N^T N dV and the consistent mass of the 2-node prismatic bar with linear shape functions', applicability: 'Prismatic 2-node bar moving along its axis, constant rho and A',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:23:47+09:00', bytes: 195195, sha256: 'f5b5d2e1b282e6df2277aaa774d669c61c97fb6f4c77a5a4382333298708ba6c',
      located: ['(31.4)', 'is called the consistent mass matrix', 'Ni = 1 - (x - xi)/l = 1 - zeta and Nj = (x - xi)/l = zeta', '(31.5)'] } },
  { id: 'moose-implicit-midpoint', url: 'https://raw.githubusercontent.com/idaholab/moose/master/framework/doc/content/source/timeintegrators/ImplicitMidpoint.md',
    title: 'ImplicitMidpoint (time integrator documentation, page source)', authors: 'MOOSE Framework, Idaho National Laboratory',
    publication: 'idaholab/moose repository, master (MOOSE stable) branch as served on 2026-11-03; the rendered page mooseframework.inl.gov/source/timeintegrators/ImplicitMidpoint.html answered 403',
    locator: 'Description: implicit midpoint scheme for dU/dt = A(t, U(t)) and its Butcher tableau c1 = 1/2, a11 = 1/2, b1 = 1 (the displayed one-line equation writes dt/2 where the tableau gives the average (U(t) + U(t + dt))/2; the tableau is used)',
    supports: 'One-stage Gauss-Legendre (implicit midpoint) rule U(t + dt) = U(t) + dt A(t + dt/2, (U(t) + U(t + dt))/2)', applicability: 'First-order systems dU/dt = A(t, U); second order accurate, A-stable',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:22:12+09:00', bytes: 983, sha256: '3cf9a82e361fee677b0ee4cacdb41e2a729ca771d08b8f6e13cb85e22c8c9cc5',
      located: ['The implicit midpoint method is second-order accurate', 'As a Gauss-Legendre method it is A-stable', 'Butcher Tableau', '1/2 & 1/2'] } },
  { id: 'cartiaux-2023', url: 'https://arxiv.org/pdf/2303.14504',
    title: 'Probabilistic formulation of Miner\'s rule and application to structural fatigue', authors: 'F.-B. Cartiaux, A. Ehrlacher, F. Legoll, A. Libal, J. Reygner',
    publication: 'arXiv:2303.14504v2 [cs.CE], 28 Mar 2023', locator: 'Section 1.1.1 S-N curve and Miner\'s rule: Eq. (1) D_{p,n} = sum_{i=1}^{n} 1/N_p(S_i); Eq. (2) failure when the damage reaches 1. Section 2.3 The Weibull-Basquin model: Eq. (9) ln Np(S) = -alpha ln S + Cte for all S > 0 (Basquin\'s model [1]); Eq. (10) Np(S)/Np = (S/Sp)^-alpha through the detail category (Np, Sp), S the constant cycle amplitude',
    supports: 'Palmgren-Miner linear damage summation over cycles of given severity, and the Basquin power-law S-N curve through one reference point', applicability: 'Cycles with lives taken from an S-N curve; sequence effects ignored; Basquin curve for all S > 0 without a cutoff',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:02:47+09:00', bytes: 1082497, sha256: '6d934650876e523ae1c38e6faaf1833a9e8cb98e59840ecdd466d3ca20673880',
      located: ['1.1.1. S-N curve and Miner\'s rule', '(1)', '(2)', '2.3. The Weibull-Basquin model', 'Basquin\'s model [1]', '(9)', '(10)'] } },
  { id: 'miner-1945', url: 'https://doi.org/10.1115/1.4009458',
    title: 'Cumulative Damage in Fatigue', authors: 'M. A. Miner',
    publication: 'Journal of Applied Mechanics 12(3), A159-A164, 1945', locator: 'Whole article (text not retrieved)',
    supports: 'Linear damage summation', applicability: 'Constant-amplitude blocks',
    confirmation: 'not-retrieved', unverifiedReason: 'DOI resolver answered HTTP 403 on 2026-11-03 11:00; access control not bypassed' },
  { id: 'basquin-1910', url: 'https://cir.nii.ac.jp/crid/1570854175181886720',
    title: 'The exponential law of endurance tests', authors: 'O. H. Basquin',
    publication: 'Proceedings of the American Society for Testing and Materials 10, 625-630, 1910', locator: 'CiNii record (not read)',
    supports: 'Power-law S-N relation', applicability: 'Form of the curve only; the test constants here are not material data',
    confirmation: 'not-retrieved', unverifiedReason: 'CiNii answered HTTP 202 with an empty body on 2026-11-03 11:00' },
  { id: 'kun-2008-basquin', url: 'https://arxiv.org/pdf/0801.3664',
    title: 'Universality behind Basquin\'s law of fatigue', authors: 'F. Kun, H. A. Carmona, J. S. Andrade Jr., H. J. Herrmann',
    publication: 'arXiv:0801.3664v1 [cond-mat.mtrl-sci], 23 Jan 2008', locator: 'Abstract and first paragraph: Basquin\'s law, the lifetime increases as a power law of the decreasing load amplitude, tf ~ sigma0^-alpha, with a strongly material dependent exponent alpha',
    supports: 'Basquin power law of fatigue lifetime against load amplitude', applicability: 'Form of the law only; alpha is material dependent and no material constant is taken from this paper',
    confirmation: 'primary-text', retrieval: { retrievedAt: '2026-11-03T11:19:51+09:00', bytes: 173257, sha256: 'a7f81f984335f8fdbb60c640baff8f27c928a93f08a97088067f8cec6dc94531',
      located: ['Universality behind Basquin\'s law of fatigue', 'Basquin\'s law of fatigue, namely, that the lifetime of the system increases as a power law', 'the exponent alpha has a strong material dependence'] } },
];

const VERIFICATION_DERIVATIONS: Readonly<Record<VerificationKind, FixtureDerivation>> = {
  'linear-static': { kind: 'linear-static', caseId: 'linear-cantilever-tip-y-v1', sourceIds: ['moose-beam-vandv', 'tudelft-timoshenko'],
    formula: 'delta = P L^3/(3 E I) (1 + 3/alpha), alpha = kappa A G L^2/(E I), i.e. delta = P L^3/(3 E I) + P L/(kappa G A)',
    substitution: 'P = 4000 N (+y at tip), L = 2 m, E = 208e9 Pa, I = iz = 5e-6 m^4, kappa = 5/6, G = 80e9 Pa, A = 0.003 m^2: 32000/3.12e6 + 8000/2e8 m',
    conditions: 'Base node fixed, single member base->tip along +x, localYHint +y, tip force [0, 4000, 0], no moment', statement: DERIVATION_STATEMENT,
    ownSteps: ['Expanding PL^3/(3EI) (1 + 3/alpha) into the bending plus shear sum'], sourceGaps: [] },
  buckling: { kind: 'buckling', caseId: 'buckling-fixed-free-first-v1', sourceIds: ['arizona-opti222-buckling', 'govindjee-ch12'],
    formula: 'Pcr = pi^2 E I/Le^2 with Le = 2 L; the first load factor for a 1 N reference load equals Pcr/1 N',
    substitution: 'E = 210e9 Pa, I = min(iy, iz) = 1e-12 m^4, L = 1 m: pi^2 * 210e9 * 1e-12/4',
    conditions: 'node-0 restrained in all 6 DOFs, node-1 free, reference nodal force [-1, 0, 0] N (compression), 16 segments', statement: DERIVATION_STATEMENT,
    ownSteps: ['The first mode buckles about the weaker axis, so I = min(iy, iz)'], sourceGaps: [] },
  modal: { kind: 'modal', caseId: 'modal-supported-tet-first-v1', sourceIds: ['felippa-afem-ch15'],
    formula: 'Lowest root of det(K - lambda M) = 0 on the 2 free DOFs: M = [[d, o], [o, d]], K = diag(k1, k2); lambda = k1 k2/((d^2 - o^2) lambda_max)',
    substitution: 'V = 1000/6 mm^3, rho = 7.85e-9 t/mm^3, d = rho V/10, o = rho V/20; nu = 0 and u_x = a1 x/10 + a2 y/10 give eps_xx = a1/10, gamma_xy = a2/10, so k1 = V E/100 = E 10/6, k2 = V (E/2)/100 = E 10/12, coupling 0; E = 205000 MPa',
    conditions: 'Nodes (0,0,0), (10,0,0), (0,10,0), (0,0,10); nodes 0 and 3 fixed; nodes 1 and 2 free in x only', statement: DERIVATION_STATEMENT,
    ownSteps: ['Evaluating Ke = V B^T E B for nu = 0 on the two free x-DOFs', 'Solving the 2x2 generalized eigenproblem in closed form'], sourceGaps: [] },
  'plastic-solid': { kind: 'plastic-solid', caseId: 'solid-plastic-first-load-v1', sourceIds: ['yaw-1d-plasticity', 'simo-hughes-1998'],
    formula: 'sigma = sigma_y + (E K/(E + K)) (eps - sigma_y/E) for eps > sigma_y/E under monotonic loading',
    substitution: 'eps = 0.025 mm/10 mm = 0.0025, E = 200000 MPa, K = H = 2000 MPa, sigma_y = 250 MPa: 250 + (4e8/202000) (0.0025 - 0.00125)',
    conditions: 'Node 0 fixed; node 1 x = 0.025 mm (y, z = 0); node 2 x, z = 0 (y free); node 3 x, y = 0 (z free); first load point of factors [0, 1, 0, -1, 0]', statement: DERIVATION_STATEMENT,
    ownSteps: ['Treating the supported tetrahedron as homogeneous uniaxial stress so that the 3D model with hardening modulus H reduces to the 1D model (not stated by the 1D source)'], sourceGaps: [] },
  contact: { kind: 'contact', caseId: 'contact-first-stick-v1', sourceIds: ['zimmermann-sauer-2017', 'moose-mechanical-contact-constraint', 'moose-penalty-friction-uo', 'wriggers-2006'],
    formula: 'Stick: u = P/(k_bar + k_t A), k_bar = G A/L, G = E/(2(1 + nu)); valid while k_t A u < mu k_n A g_n',
    substitution: 'A = 10 * 20 = 200 mm^2, L = 100 mm, E = 210000 MPa, nu = 0: k_bar = 105000 * 200/100 = 210000 N/mm; k_t A = 10000 * 200 = 2e6 N/mm; P = 2/30 + 2/60 = 0.1 N: u = 0.1/2210000 mm; normal closure 5e-7 mm gives N = 10000 * 200 * 5e-7 = 1 N, mu N = 0.3 N > 2e6 u',
    conditions: 'As in solidContactConvergence.test.ts: bar nodes 0-3 fixed, end nodes 4-7 x prescribed 5e-7 mm and z = 0, y loaded; stop nodes 8-15 fixed; two patches kn = kt = 10000 N/mm^3, mu = 0.3; step 1 of 5; tangential force 2e6 u expected there', statement: DERIVATION_STATEMENT,
    ownSteps: ['Simple-shear stiffness G A/L of the bar, exact for constant-strain tetrahedra', 'Bar and tangential penalty acting as parallel springs',
      'Summing the per-area penalty over the contact area to k_t A and k_n A; in step 1 the old tangential force is zero, so the stick force is k_t A u'],
    sourceGaps: [] },
  impact: { kind: 'impact', caseId: 'impact-axial-energy-v1', sourceIds: ['felippa-ifem-ch31', 'moose-implicit-midpoint', 'felippa-guo-park-mass-templates', 'simo-tarnow-1992'],
    formula: 'E = m v0^2/2 with m = rho A L/3 (free-node entry of the consistent bar mass); the midpoint rule keeps this total energy for the linear 1-DOF system',
    substitution: 'rho = 7850 kg/m^3, A = 1e-4 m^2, L = 1 m, v0 = 0.01 m/s: (7850 * 1e-4/3) * 0.01^2/2 J',
    conditions: 'As in beamImpactNativeFixture.test.ts: native-1 fully restrained, native-2 free in x only, initial velocity [0.01, 0, 0] m/s, zero initial displacement, contact gap 0 (contact active, u >= 0), kc = 21e6 N/m, 30 steps of h = 6.199254089337072e-6 s, every sample compared', statement: DERIVATION_STATEMENT,
    ownSteps: ['Zero initial displacement and gap, so the initial total energy is kinetic only',
      'Restraining native-1 leaves the free-node entry rho A L/3 of the consistent bar mass (31.5) as the 1-DOF mass m',
      'Writing m a + k u = 0 (k = bar plus contact stiffness, contact active while u >= 0 as the original test checks) as dU/dt = A U with U = (u, v), the tableau gives u1 - u0 = h (v0 + v1)/2 and m (v1 - v0) = -h k (u0 + u1)/2; multiplying the two shows that m v^2/2 + k u^2/2 is unchanged in every step'],
    sourceGaps: [] },
  fatigue: { kind: 'fatigue', caseId: 'fatigue-miner-two-blocks-v1', sourceIds: ['cartiaux-2023', 'kun-2008-basquin', 'miner-1945', 'basquin-1910'],
    formula: 'D = sum n_i/N_i with N(S) = N_ref (S_ref/S)^m, S = stress range, mean-independent, no cutoff',
    substitution: 'N_ref = 2e6 at S_ref = 100 MPa, m = 3: block a range 100 MPa, n = 1000, N = 2e6; block b range 200 MPa, n = 10, N = 2e6/2^3 = 2.5e5: D = 1000/2e6 + 10/2.5e5',
    conditions: 'As in fatigue.test.ts: histories [-50, 50] x 1000 and [-100, 100] x 10, repeated-periodic; curve constants are test-only, not material values', statement: DERIVATION_STATEMENT,
    ownSteps: ['Grouping equal-severity cycles into n_i/N_i',
      'Writing Eq. (10) Np(S)/Np = (S/Sp)^-alpha as N(S) = N_ref (S_ref/S)^m with m = alpha and the test-only point (N_ref, S_ref); measuring S as the stress range instead of the amplitude only rescales that test-only point for a pure power law'],
    sourceGaps: [] },
};

describe('verification case input binding', () => {
  it('accepts the actual fixed linear and buckling fixture inputs with independent literal observables', () => {
    const linear = { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(cantilever({ mode: 'y' })), value: .010296410256410255 };
    expect(compareVerification(linear.caseId, linear).passed).toBe(true);
    const buckling = { caseId: 'buckling-fixed-free-first-v1', input: bucklingInput(bucklingFixture({ pinned: false, segments: 16 })), value: .5181542310571913 };
    expect(compareVerification(buckling.caseId, buckling).passed).toBe(true);
  });
  it('rejects a different case, units, load, revision and non-finite value', () => {
    const input = cantilever({ mode: 'y' });
    const observation = { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(input), value: .010296410256410255 };
    expect(() => compareVerification('buckling-fixed-free-first-v1', observation)).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: { ...observation.input, units: 'N-mm' } })).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: linearInput(cantilever({ forceMultiplier: -1 })) })).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: linearInput({ ...input, revision: input.revision + 1 }) })).toThrow();
    for (const value of [NaN, Infinity, -Infinity]) expect(() => compareVerification(observation.caseId, { ...observation, value })).toThrow();
    expect(compareVerification(observation.caseId, { ...observation, value: .02 }).passed).toBe(false);
  });
});

describe('verification case published references', () => {
  type Derivations = Partial<Record<VerificationKind, FixtureDerivation>>;
  const registered = (caseId: string): boolean => {
    try {
      compareVerification(caseId, { caseId, input: { geometry: null, boundary: null, material: null, units: '', source: null }, value: 0 });
      return true;
    } catch (error) {
      return error instanceof Error && error.message === 'verification: mismatched case or input';
    }
  };
  const replaced = (kind: VerificationKind, change: Partial<FixtureDerivation>): Derivations => {
    const copy: Derivations = { ...VERIFICATION_DERIVATIONS };
    copy[kind] = { ...VERIFICATION_DERIVATIONS[kind], ...change };
    return copy;
  };
  const replacedSource = (id: string, change: Partial<PublishedSource>): PublishedSource[] =>
    VERIFICATION_SOURCES.map(source => (source.id === id ? { ...source, ...change } : source));
  // rev46: every needed principle of each kind is located in retrieved primary text; own steps are listed separately.
  const expectedStatus = { 'linear-static': 'verified', buckling: 'verified', modal: 'verified', 'plastic-solid': 'verified',
    contact: 'verified', impact: 'verified', fatigue: 'verified' };

  it('binds each of the seven kinds to registered cases and reports only retrieved primary texts as verified', () => {
    expect(validateVerificationReferences(VERIFICATION_SOURCES, VERIFICATION_DERIVATIONS)).toEqual(expectedStatus);
    expect(Object.keys(VERIFICATION_DERIVATIONS).sort()).toEqual([...VERIFICATION_KINDS].sort());
    expect(new Set(VERIFICATION_KINDS).size).toBe(7);
    for (const kind of VERIFICATION_KINDS) {
      const derivation = VERIFICATION_DERIVATIONS[kind];
      expect(derivation.kind).toBe(kind);
      expect(registered(derivation.caseId)).toBe(true);
      expect(derivation.statement).toBe(DERIVATION_STATEMENT);
    }
    expect(registered('unregistered-case-v1')).toBe(false);
    const linked = new Set(VERIFICATION_KINDS.flatMap(kind => VERIFICATION_DERIVATIONS[kind].sourceIds));
    expect(VERIFICATION_SOURCES.map(source => source.id).filter(id => !linked.has(id))).toEqual([]);
  });

  it('keeps a kind incomplete when its primary text is only a record or a needed principle is open', () => {
    for (const kind of VERIFICATION_KINDS.filter(item => expectedStatus[item] === 'verified')) {
      const withGap = validateVerificationReferences(VERIFICATION_SOURCES, replaced(kind, { sourceGaps: ['principle not located'] }));
      expect(withGap[kind]).toBe('incomplete');
      let sources: PublishedSource[] = [...VERIFICATION_SOURCES];
      for (const id of VERIFICATION_DERIVATIONS[kind].sourceIds)
        sources = sources.map((source): PublishedSource => (source.id === id && source.confirmation === 'primary-text'
          ? { ...source, confirmation: 'bibliographic-record', retrieval: undefined, unverifiedReason: 'record only' } : source));
      expect(validateVerificationReferences(sources, VERIFICATION_DERIVATIONS)[kind]).toBe('incomplete');
    }
    for (const source of VERIFICATION_SOURCES.filter(item => item.confirmation !== 'primary-text'))
      expect(() => validateVerificationReferences(replacedSource(source.id, { confirmation: 'primary-text', unverifiedReason: undefined }), VERIFICATION_DERIVATIONS)).toThrow();
  });

  it('rejects a missing kind, a missing or unlinked source and an incomplete derivation for every kind', () => {
    for (const kind of VERIFICATION_KINDS) {
      const without: Derivations = { ...VERIFICATION_DERIVATIONS };
      delete without[kind];
      expect(() => validateVerificationReferences(VERIFICATION_SOURCES, without)).toThrow();
      const derivation = VERIFICATION_DERIVATIONS[kind];
      const other = VERIFICATION_KINDS.find(item => item !== kind) ?? kind;
      for (const change of [{ sourceIds: [] }, { sourceIds: ['not-a-published-source'] }, { sourceIds: [derivation.sourceIds[0], derivation.sourceIds[0]] },
        { formula: '' }, { substitution: ' ' }, { conditions: '' }, { caseId: '' }, { caseId: VERIFICATION_DERIVATIONS[other].caseId },
        { kind: other }, { statement: 'The cited source validated this fixture' }, { ownSteps: [''] }, { sourceGaps: [' '] }] satisfies Partial<FixtureDerivation>[])
        expect(() => validateVerificationReferences(VERIFICATION_SOURCES, replaced(kind, change))).toThrow();
      for (const id of derivation.sourceIds)
        expect(() => validateVerificationReferences(VERIFICATION_SOURCES.filter(source => source.id !== id), VERIFICATION_DERIVATIONS)).toThrow();
    }
  });

  it('rejects a source without https URL, title, edition, locator, or the retrieval record its confirmation needs', () => {
    for (const source of VERIFICATION_SOURCES) {
      for (const change of [{ url: '' }, { url: 'not a url' }, { url: 'http://example.org/reference' }, { title: '' }, { authors: '' },
        { publication: '' }, { locator: ' ' }, { supports: '' }, { applicability: '' }, { id: '' }] satisfies Partial<PublishedSource>[])
        expect(() => validateVerificationReferences(replacedSource(source.id, change), VERIFICATION_DERIVATIONS)).toThrow();
      expect(() => validateVerificationReferences([...VERIFICATION_SOURCES, { ...source }], VERIFICATION_DERIVATIONS)).toThrow();
      const retrieval = source.retrieval;
      if (retrieval === undefined) {
        for (const change of [{ unverifiedReason: undefined }, { unverifiedReason: ' ' },
          { retrieval: { retrievedAt: '2026-11-03T11:00:00+09:00', bytes: 1, sha256: 'a'.repeat(64), located: ['x'] } }] satisfies Partial<PublishedSource>[])
          expect(() => validateVerificationReferences(replacedSource(source.id, change), VERIFICATION_DERIVATIONS)).toThrow();
      } else {
        for (const change of [{ retrieval: undefined }, { unverifiedReason: 'record only' }, { retrieval: { ...retrieval, sha256: 'abc' } },
          { retrieval: { ...retrieval, bytes: 0 } }, { retrieval: { ...retrieval, located: [] } }, { retrieval: { ...retrieval, located: [''] } },
          { retrieval: { ...retrieval, retrievedAt: '2026-11-03' } }] satisfies Partial<PublishedSource>[])
          expect(() => validateVerificationReferences(replacedSource(source.id, change), VERIFICATION_DERIVATIONS)).toThrow();
      }
    }
  });
});
