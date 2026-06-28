export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'DEPROVISIONED';

export type TenantTier = 'PILOT' | 'STANDARD' | 'ENTERPRISE';

export interface TenantRegistryData {
  tenant_id: string;
  tenant_name: string;
  vault_path: string;
  db_schema: string;
  grpc_namespace: string;
  status: TenantStatus;
  tier: TenantTier;
  region: string;
  created_at: string;
  updated_at: string;
}

export interface TenantContext {
  registry: TenantRegistryData;
  trace_id: string;
  resolved_at: string;
  vault_token_ref: string;
}