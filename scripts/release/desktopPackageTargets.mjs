/** Each offered desktop variant has one self-contained downloadable entry point. */
export function desktopPackagePlan(platform, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Invalid desktop package version');
  }
  const prefix = `PointerCAD-${version}`;
  if (platform === 'win32') return [
    { target: 'nsis', name: `${prefix}-windows-x64-setup.exe` },
    { target: 'portable', name: `${prefix}-windows-x64-portable.exe` },
  ];
  if (platform === 'linux') return [{ target: 'AppImage', name: `${prefix}-linux-x64.AppImage` }];
  throw new Error('Unsupported desktop package platform');
}

/** Do not certify a build that silently omitted portable, or needs unlisted sidecar files. */
export function verifyDesktopPackageArtifacts(platform, version, assets) {
  const plan = desktopPackagePlan(platform, version);
  const names = new Set(assets.map(asset => asset.name));
  if (names.size !== assets.length || names.size !== plan.length || plan.some(item => !names.has(item.name))) {
    throw new Error('Desktop package artifacts differ from the required distribution variants');
  }
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw new Error('Desktop package artifact is empty or has no verified content hash');
    }
  }
  return plan.map(item => ({ target: item.target, files: [item.name], launchVerified: false }));
}
