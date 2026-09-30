/**
 * This repository ships the enterprise edition only. Community plugin
 * install and update stay closed even when the user is offline or signed out.
 */
export const ENTERPRISE_CAPABILITY_POLICY = Object.freeze({
  communityPluginInstall: false
})

export function communityPluginInstallAllowed() {
  return ENTERPRISE_CAPABILITY_POLICY.communityPluginInstall === true
}
