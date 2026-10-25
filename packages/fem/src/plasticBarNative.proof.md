# Native proof for plasticBarAnalysis.py (Root-only, UNEXECUTED)

## Run
In the qualified Pyodide runtime, using the existing native-proof harness pattern:
1. Write the plan below to `/pcad_fem/analysis-input.json`.
2. Load `plasticBarAnalysis.py` as an extra fixed program (it is not in the runtime assets yet; integration task 1).
3. Call `run_plastic_bar()`.
4. Decode the JSON and compare it with `plasticBarReference(readPlasticBarPlan(plan))` through
   `comparePlasticBar(native.samples, reference, plan)`.

```json
{"schema":"pointercad-oofem-plastic-bar-plan/1","lengthM":1,"areaM2":0.0001,
 "material":{"youngPa":200000000000,"poisson":0.3,"yieldStressPa":250000000,"hardeningModulusPa":2000000000,
   "source":{"kind":"user-supplied","reference":"Numerical example entered by the user for a uniaxial test"}},
 "endDisplacementM":[0,0.0025,0,-0.0025,0],"stepsPerSegment":5}
```

## Expected values (hand-derived; identical to plasticBar.test.ts)
| Native step | End displacement (m) | Stress (Pa) | Plastic strain |
|---|---|---|---|
| 5 | 0.0025 | 252475247.52475247 | 1.2376237623762376e-3 |
| 10 | 0 | −247524752.47524752 | 1.2376237623762376e-3 |
| 15 | −0.0025 | −257376727.77178708 | −1.2131163611410645e-3 |
| 20 | 0 | 242623272.2282129 | −1.2131163611410645e-3 |

- **Steps 5 and 15 with 5 increments:** linear hardening under monotonic loading inside a segment gives the same
  end state as one increment.
- **Steps 1–2:** elastic, because ε ≤ 1.0e-3 < εy = 1.25e-3. Stress is exactly E·ε.

## Tolerances (fixed before execution)
| Quantity | Limit | Reason |
|---|---|---|
| `displacement` | ≤ 1e-12 relative to σ0/E·L | prescribed value |
| `stress`, `plasticStrain`, `force` | ≤ 1e-8 relative to σ0, σ0/E and σ0·A | One uniform element with the same closed-form 1D return (misesmat.C:197-219). The only differences are Newton convergence (`rtolf 1e-10`) and floating rounding. |
| `maximumEquilibriumMismatch` (end internal force against σ·A) | ≤ 1e-8 | — |
| `yielded` | `true` | — |
| `structuralCertification` | `false` | — |

**Negative control, which must FAIL the comparison:** the same plan with `hardeningModulusPa` changed to 0 in the
native run only, compared with the unchanged reference. The stress at step 15 becomes −250 MPa instead of
−257.38 MPa, a relative difference of about 0.029.

## Unverified binding assumptions this proof decides
1. A deck-instantiated problem accepts `checkProblemConsistency` → `init` → `postInitialize` before stepping, in the
   same order as beamAnalysis.py.
2. `Element.giveIPValue` on truss1d with MisesMat returns full Voigt vectors whose first component is axial for
   `IST_StressTensor`, `IST_StrainTensor` and `IST_PlasticStrainTensor`.
3. `InternalForcesVector` index 1 is the far-end axial force (tension positive).

If any of these fails, the native result is rejected. The proof is not passed by adjusting the comparison.
