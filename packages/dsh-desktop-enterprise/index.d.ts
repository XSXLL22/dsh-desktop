import type { Context } from '@deepseek-ai/cordis'
import type { AuditContextField } from './contract.js'

export interface EnterpriseAuditCapability {
  fields: AuditContextField[]
}

export declare const name = "dsh-desktop-enterprise"
export declare const inject: readonly ["connection", "llm"]
export declare const BISHENG_PROVIDER_ROUTE = "bisheng-enterprise"
export declare function apply(ctx: Context): void
