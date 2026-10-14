export interface ThirdPartyPolicySnapshot {
  allowThirdPartyPlugins: boolean
  allowThirdPartyWorkbenches: boolean
  syncSeconds: number
  connectionKey: string | undefined
  connected: boolean
  authoritative: boolean
}

export interface EnterpriseCapabilityPolicy {
  registerResolver(resolver: () => Promise<unknown>): () => void
  setCompositionHandler(handler: (snapshot: ThirdPartyPolicySnapshot) => Promise<void> | void): () => void
  snapshot(): ThirdPartyPolicySnapshot
  reset(): void
  refresh(expectedConnectionKey: string | undefined, options?: { force?: boolean }): Promise<ThirdPartyPolicySnapshot>
  authorizePluginMutation(): Promise<void>
  authorizeWorkbenchMarketInstall(): Promise<void>
}

export function normalizeThirdPartyPolicy(value: unknown): ThirdPartyPolicySnapshot & { stale?: boolean }
export function createEnterpriseCapabilityPolicy(options?: { now?: () => number }): EnterpriseCapabilityPolicy
export function communityPluginInstallAllowed(): boolean
export function isProtectedProfileBundle(name: string): boolean
export function localSourcePath(spec: unknown): string | undefined
export function isLocalPluginRequest(request: unknown): boolean
export function restrictCommunityPackageBackend(
  backend: import('./generations/package-backend').ProfileBundlePackageBackend,
  policy?: EnterpriseCapabilityPolicy,
  options?: {
    isQuarantined?: (name: string) => Promise<boolean>
    releaseQuarantine?: (name: string) => Promise<void>
    isOfficialBundle?: (name: string) => Promise<boolean>
    isLocallyInstalled?: (name: string) => Promise<boolean>
    isPhysicallyInstalled?: (name: string) => Promise<boolean>
  }
): import('./generations/package-backend').ProfileBundlePackageBackend
export function readPersistedThirdPartyPolicy(dshHome: string): Promise<ThirdPartyPolicySnapshot>
export function writePersistedThirdPartyPolicy(dshHome: string, policy: unknown): Promise<void>
export function syncMarketBundle(dshHome: string, allowed: boolean): Promise<boolean>
