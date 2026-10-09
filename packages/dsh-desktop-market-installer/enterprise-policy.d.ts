export const ENTERPRISE_CAPABILITY_POLICY: {
  readonly communityPluginInstall: false
}

export function communityPluginInstallAllowed(): boolean

export function isProtectedProfileBundle(name: string): boolean
export function restrictCommunityPackageBackend(
  backend: import('./generations/package-backend').ProfileBundlePackageBackend
): import('./generations/package-backend').ProfileBundlePackageBackend
