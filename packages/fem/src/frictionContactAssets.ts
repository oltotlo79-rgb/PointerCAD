/** Fixed friction-only programs; shared beamContact.py and native dependency pins stay in FEM_ASSETS. */
export const FRICTION_CONTACT_ASSETS = [
  { file: 'beamFrictionContact.py', bytes: 39720, sha256: 'd21581ea5eb16b2cb587000c19db91479cc8cbba5d2314cfcc9d0abe0190d803' },
  { file: 'beamFrictionRuntime.py', bytes: 2257, sha256: '88d9e94bdd3512a0f31769a6fce2730e23b4eacafc084edc14f29edb647b4cdb' },
] as const;
