// Generated from preserved official artifacts and fixed developer wrappers.
// Bolt-only developer wrapper; all shared native dependency pins remain unchanged.
export const BOLT_CONTACT_ASSETS = [{ file: 'beamBoltContact.py', bytes: 15396,
  sha256: 'd58a66b03e25a3daa30df6320136221c599dddecdcfcda39a90ec1bc6f9be2ba' }] as const;
export const FEM_ASSETS = [
  {
    "file": "pyodide.mjs",
    "bytes": 17616,
    "sha256": "23213d27e9dacbda6f25f955fb38dabfc40ada082c04ee253047ea5dddcaa3b5"
  },
  {
    "file": "pyodide.asm.js",
    "bytes": 1074322,
    "sha256": "1263f02b5b26099b96112378156f242dd98b39a8201ba7765e5fe3d455c5ce91"
  },
  {
    "file": "pyodide.asm.wasm",
    "bytes": 8647684,
    "sha256": "e2f4ee75b325e35eb31bfb8c613d4dd5098f5502c156a97847686875b5025480"
  },
  {
    "file": "python_stdlib.zip",
    "bytes": 2423989,
    "sha256": "4298b6ee445cb724c3973437da47789752b9e6ff4e26619026b283ec801fc46b"
  },
  {
    "file": "package.json",
    "bytes": 3010,
    "sha256": "81f7cf8ee62633854d610a040efe15d3f9e80cfc78fbc32426860419b8712924"
  },
  {
    "file": "numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
    "bytes": 3103966,
    "sha256": "6eaab6a7bb658d71ebe702911a3deab715323642462eb41b65565ca6a7cc23f1"
  },
  {
    "file": "pyodide-lock.json",
    "bytes": 120010,
    "sha256": "3256ffc76388de0e37f4b34d42ab484268d1afc675179ff97b2a5bb14f84ccac"
  },
  {
    "file": "oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl",
    "bytes": 2620689,
    "sha256": "aaff729b15e1cec2ef90c9c0bb2d3594b3997b523d35344b18ba9f64d4d1a7e4"
  },
  {
    "file": "test_2.py",
    "bytes": 3781,
    "sha256": "b7f6b7dd23d3933c5cf44d92de979a2950f29615afb5da09530c8840cb7c664b"
  },
  {
    "file": "beamProof.py",
    "bytes": 3012,
    "sha256": "78b225d54ff5f4e08db53e08a003f7bf2de1a0c694ae0a0e7cf63376e3038e61"
  },
  {
    "file": "beamAnalysis.py",
    "bytes": 55527,
    "sha256": "9593ec530550d81c5ee46a824cafc9a3dedd0e68114c8371a0013e30ceec3a38"
  },
  {
    "file": "plasticBarAnalysis.py",
    "bytes": 11818,
    "sha256": "4476efc3d2ead7db8420ca55b3547ba25c3cbc8a725802704e4b53217a3436fd"
  },
  {
    "file": "beamContact.py",
    "bytes": 33736,
    "sha256": "2bdf6b14dcf4c076a8a23f14d31a53be933c3bc7f9ce3433593acdaffe4a43e0"
  }
] as const;

// Root packages these admitted assets separately; only the mesh mode requests them.
export const NETGEN_ASSETS = [
    {
        "file":  "netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl",
        "bytes":  2809006,
        "sha256":  "3f0d507e8daa11b5a26654d904c529d6c1338e9a3a4c7d7728152f3596954ba3"
    },
    {
        "file":  "netgenMesher.py",
        "bytes":  10460,
        "sha256":  "1732266925f862c83d096648c659179ea381e69fb0e0c2e55731ec67620bd0b0"
    }
] as const;

// Solid mode only; Root must generate the identical runtime asset and closure.
export const SOLID_ASSETS = [{ file: 'solidAnalysis.py', bytes: 15770,
  sha256: '72681567864f65f0f59bc3b3f332b84a937ddd0827fef4daf8a3345c4eeac9e3' }] as const;

// Plastic solid mode only; Root generates this exact freeze-c3 wrapper and the runtime source closure.
export const SOLID_PLASTIC_ASSETS = [{ file: 'solidPlasticAnalysis.py', bytes: 19110,
  sha256: '809621c9b6aac03647fc090ec1d05c20336174385d3f3acfceb7bf9b7c764438' }] as const;

// Solid modal mode only; Root generates this exact r150 wrapper into the runtime asset closure.
export const SOLID_MODAL_ASSETS = [{ file: 'solidModal.py', bytes: 24031,
  sha256: '8e2ad51007e9f571cd90c27367cf92a9ed380caed881d8c5e7a049dfd90ddb34' }] as const;

// Solid prestress buckling only; Root generates this exact task159 native-r1 wrapper into the runtime asset closure.
export const SOLID_BUCKLING_ASSETS = [{ file: 'solidBuckling.py', bytes: 18036,
  sha256: 'eef26fdb7f4cb7303371b448d0dcf7ab1b3c5039007ab8980b5867a473ea1290' }] as const;
