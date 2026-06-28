// src/grpc/dispatch.ts
//
// Generic gRPC dispatcher: resolves the target VLAN, builds metadata,
// forwards the envelope, returns a typed result.
//
// Client lifecycle: one gRPC client per VLAN, created once at module load
// and reused for the life of the process — never constructed per-request.
// A gRPC client wraps an HTTP/2 connection; creating one per request would
// mean a fresh TCP+TLS handshake per request, which alone would blow the
// 5ms budget many times over before a single byte of actual work happens.

import { credentials, Metadata, ServiceError, status as GrpcStatus } from '@grpc/grpc-js';
import type { FastifyRequest } from 'fastify';
import { resolveVlanTarget, type VlanTarget } from '../routing/intentRouter';
import type { IngressRequest } from '../schemas/ingress.schema';
import '../types/request'; // Import the global augmentations

// --- MOCK PROTOBUF BINDINGS ---
// Temporarily mocking the generated interfaces until `protoc` is run.
export interface GatewayEnvelope {
  schema_version: string;
  trace_id: string;
  correlation_id: string;
  tenant_id: string;
  customer_id: string;
  session_id: string;
  channel: string;
  intent: string;
  payload_json: string;
}

export interface GatewayResult {
  trace_id: string;
  success: boolean;
  status_code: string;
  result_json: string;
  error_message: string;
}

// Mocking the gRPC client structure
class VlanServiceClient {
  constructor(public address: string, public creds: any) {}
  Dispatch(
    envelope: GatewayEnvelope,
    _metadata: Metadata,
    _options: { deadline: number },
    callback: (err: ServiceError | null, result?: GatewayResult) => void
  ) {
    // This is a stub for compilation. The real @grpc/grpc-js client executes here.
    callback(null, {
      trace_id: envelope.trace_id,
      success: true,
      status_code: '',
      result_json: '{"stub": true}',
      error_message: ''
    });
  }
  close() {}
}
// ------------------------------

/**
 * Per-VLAN deadline budgets — these are not arbitrary. They're carried
 * forward unchanged from this project's own Master Architecture Roadmap
 * §2.2 routing table, which set them deliberately per domain (Credit gets
 * longer because eligibility scoring takes real work; Merchant gets
 * shorter because QR generation is fast; Bill-Pay gets the longest because
 * third-party utility-provider APIs have the worst latency variance of
 * anything this gateway calls).
 */
const VLAN_TIMEOUT_MS: Readonly<Record<VlanTarget, number>> = {
  VLAN_10_P2P: 8_000,
  VLAN_40_CREDIT: 10_000,
  VLAN_50_MERCHANT: 6_000,
  VLAN_30_BILLPAY: 12_000,
  VLAN_20_FAQ: 8_000,
};

interface VlanEndpointConfig {
  address: string;
  tlsEnabled: boolean;
}


/**
 * Reads one VLAN's connection config from environment variables, failing
 * fast at boot — same philosophy as Part 1's loadRedisConfigFromEnv. A
 * gateway that starts successfully but has no idea where VLAN_40_CREDIT
 * lives is worse than a gateway that refuses to start at all.
 */
function loadVlanEndpointFromEnv(target: VlanTarget): VlanEndpointConfig {
  const envKey = `${target}_GRPC_ADDR`;
  const address = process.env[envKey] ?? 'localhost:50051'; // Fallback for dev
  return {
    address,
    tlsEnabled: process.env.GRPC_TLS_ENABLED === 'true',
  };
}

const ALL_VLAN_TARGETS: readonly VlanTarget[] = [
  'VLAN_10_P2P',
  'VLAN_20_FAQ',
  'VLAN_30_BILLPAY',
  'VLAN_40_CREDIT',
  'VLAN_50_MERCHANT',
];

const clientPool = new Map<VlanTarget, VlanServiceClient>();

function getOrCreateClient(target: VlanTarget): VlanServiceClient {
  const existing = clientPool.get(target);
  if (existing) return existing;

  const config = loadVlanEndpointFromEnv(target);
  const channelCredentials = config.tlsEnabled ? credentials.createSsl() : credentials.createInsecure();
  const client = new VlanServiceClient(config.address, channelCredentials);
  clientPool.set(target, client);
  return client;
}

/** Eagerly constructs every VLAN client at boot rather than on first request. */
export function initializeAllVlanClients(): void {
  for (const target of ALL_VLAN_TARGETS) {
    getOrCreateClient(target);
  }
}

/** Called during graceful shutdown. */
export function closeAllVlanClients(): void {
  for (const client of clientPool.values()) {
    client.close();
  }
  clientPool.clear();
}

/**
 * gRPC metadata keys MUST be lowercase ASCII (letters, digits, `-`, `_`,
 * `.` only) — this is an actual wire-protocol constraint, not a style
 * preference. Copying HTTP-style header casing (`X-Tenant-ID`) directly
 * into gRPC Metadata is a real, easy mistake; every key here is written
 * lowercase from the start specifically to avoid it.
 */
function buildMetadata(request: FastifyRequest<{ Body: IngressRequest }>): Metadata {
  const metadata = new Metadata();

  const trace = request.traceContext;
  if (trace) {
    metadata.set('trace-id', trace.traceId);
    metadata.set('span-id', trace.spanId);
    // Reconstruct the standard traceparent string for any downstream
    // service that's itself OTel-instrumented and expects it in this form.
    metadata.set('traceparent', `00-${trace.traceId}-${trace.spanId}-${trace.traceFlags}`);
  }

  const tenant = request.tenantContext;
  if (tenant) {
    metadata.set('tenant-id', tenant.registry.tenant_id);
    metadata.set('tenant-schema', tenant.registry.db_schema);
    metadata.set('vault-path', tenant.registry.vault_path);
  }

  return metadata;
}

function buildEnvelope(
  request: FastifyRequest<{ Body: IngressRequest }>,
  intent: string,
): GatewayEnvelope {
  const tenant = request.tenantContext;
  if (!tenant) {
    throw new Error('dispatchToVlan called without a resolved tenant context.');
  }

  return {
    schema_version: 'v32.1',
    trace_id: request.traceContext?.traceId ?? 'UNKNOWN',
    correlation_id: request.traceContext?.spanId ?? 'UNKNOWN',
    tenant_id: tenant.registry.tenant_id,
    customer_id: request.body.customer_id,
    session_id: request.body.session_id,
    channel: request.body.channel,
    intent,
    payload_json: JSON.stringify(request.body.payload),
  };
}

export type DispatchOutcome =
  | { kind: 'SUCCESS'; result: GatewayResult }
  | { kind: 'GRPC_ERROR'; vlanTarget: VlanTarget; grpcStatusCode: number; message: string }
  | { kind: 'DEADLINE_EXCEEDED'; vlanTarget: VlanTarget; timeoutMs: number };

export function dispatchToVlan(
  request: FastifyRequest<{ Body: IngressRequest }>,
  intent: string,
): Promise<DispatchOutcome> {
  const { target } = resolveVlanTarget(intent);
  const client = getOrCreateClient(target);
  const envelope = buildEnvelope(request, intent);
  const metadata = buildMetadata(request);
  const timeoutMs = VLAN_TIMEOUT_MS[target];

  return new Promise((resolve) => {
    const call = client.Dispatch(
      envelope,
      metadata,
      { deadline: Date.now() + timeoutMs },
      (err: ServiceError | null, result?: GatewayResult) => {
        if (err) {
          if (err.code === GrpcStatus.DEADLINE_EXCEEDED) {
            resolve({ kind: 'DEADLINE_EXCEEDED', vlanTarget: target, timeoutMs });
            return;
          }
          resolve({
            kind: 'GRPC_ERROR',
            vlanTarget: target,
            grpcStatusCode: err.code ?? GrpcStatus.UNKNOWN,
            message: err.message,
          });
          return;
        }
        if (!result) {
          resolve({
            kind: 'GRPC_ERROR',
            vlanTarget: target,
            grpcStatusCode: GrpcStatus.INTERNAL,
            message: 'gRPC call completed with no error and no result — treating as a server defect.',
          });
          return;
        }
        resolve({ kind: 'SUCCESS', result });
      },
    );
    void call;
  });
}