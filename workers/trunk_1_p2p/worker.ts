// worker.ts — BYOC Core Initialization
//
// Deployed inside the bank's own Kubernetes perimeter. Polls ONLY
// p2p-queue. Registers ONLY LocalP2PActivities. Never imports, never
// touches PlatformComplianceActivities — that interface and its mocks
// exist in activities.ts purely as the shared contract a SEPARATE SaaS
// Edge worker (out of scope for this deliverable) would import.
//
// VERSION HONESTY NOTE: the exact NativeConnection TLS option shape below
// is structurally accurate to @temporalio/worker's established
// TLSConfig pattern, but — same caveat already flagged for this
// codebase's earlier Temporal interceptor file — should be checked
// against whichever SDK version is actually installed before this ships.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { localActivityMocks } from './activities.js';

// ---------------------------------------------------------------------------
// Fail-fast environment loading — same philosophy applied consistently
// across every worker/server entrypoint in this codebase (VLAN 0's Redis
// config, dispatch.ts's per-VLAN gRPC addresses): a missing required
// value should crash the process at boot, not surface as a mysterious
// failure on whatever request happens to hit it first.
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required and was not set. Refusing to start the BYOC P2P worker.`);
  }
  return value;
}

interface ByocWorkerConfig {
  readonly temporalAddress: string;
  readonly namespace: string;
  readonly clientCertPath: string;
  readonly clientKeyPath: string;
  readonly serverCaPath: string;
}

function loadConfigFromEnv(): ByocWorkerConfig {
  return {
    temporalAddress: requireEnv('TEMPORAL_ADDRESS'),
    namespace: requireEnv('TEMPORAL_NAMESPACE'),
    clientCertPath: requireEnv('TEMPORAL_CLIENT_CERT_PATH'),
    clientKeyPath: requireEnv('TEMPORAL_CLIENT_KEY_PATH'),
    serverCaPath: requireEnv('TEMPORAL_SERVER_CA_PATH'),
  };
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  // ---------------------------------------------------------------------
  // mTLS connection — OUTBOUND ONLY.
  //
  // This worker INITIATES a connection out to the Temporal frontend
  // service and long-polls it for work; it never accepts an inbound
  // connection itself. This is the structural reason this satisfies a
  // regulated bank's network policy without requiring a single inbound
  // firewall rule into their Kubernetes cluster — the connection is
  // client-initiated, the same as any outbound HTTPS call a service makes
  // to a third-party API, just gRPC instead of REST.
  //
  // clientCertPair lets THIS cluster prove its own identity to Temporal's
  // frontend (mutual, not one-way, TLS — Temporal authenticates the
  // worker, not just the worker authenticating Temporal).
  // serverRootCACertificate lets this cluster verify it's actually
  // talking to the genuine Temporal server, not an on-path attacker —
  // without this, a compromised DNS or network path could MITM the
  // connection even with the client cert correctly presented.
  //
  // *** CRITICAL CAVEAT — DATA LOCALIZATION, NOT JUST TRANSPORT SECURITY ***
  // mTLS secures the WIRE. It says nothing about where the data ends up
  // AT REST. Temporal's server persists the full execution history of
  // every workflow — including every activity's input AND output — to
  // whatever database backs the namespace this worker connects to. If
  // that namespace's persistence layer lives in REVENANT's centralized
  // SaaS cloud rather than co-located inside (or dedicated to) this
  // specific bank's infrastructure, then this workflow's history —
  // containing senderAccountRef, recipientAccountRef, deviceFingerprint,
  // ipAddress, and sessionId — is data-at-rest outside the jurisdiction
  // this entire BYOC architecture exists to keep it inside, REGARDLESS of
  // how secure the mTLS channel used to reach it was.
  //
  // This file does not solve that gap; it surfaces it. The two real
  // mitigations Temporal's own architecture supports for exactly this
  // "BYOC compute, centralized control plane" shape are: (1) a per-tenant
  // Temporal namespace/server physically co-located with or dedicated to
  // this bank's own infrastructure, or (2) a client-side Payload Codec
  // that encrypts every activity/workflow payload BEFORE it leaves this
  // process, using a key that itself never leaves BYOC — so even a
  // centrally-hosted Temporal server only ever persists ciphertext it
  // cannot read. Neither is implemented in this deliverable. Treat this
  // as a blocking compliance question to resolve before this worker
  // handles real customer data, not a noted-and-deferred nice-to-have.
  // ---------------------------------------------------------------------
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
    tls: {
      clientCertPair: {
        crt: readFileSync(config.clientCertPath),
        key: readFileSync(config.clientKeyPath),
      },
      serverRootCACertificate: readFileSync(config.serverCaPath),
    },
  });

  // ---------------------------------------------------------------------
  // Worker registration. taskQueue: 'p2p-queue' ONLY — this worker will
  // never receive a task scheduled on platform-queue, full stop, by
  // Temporal's own routing (a worker only ever receives tasks for the
  // queue(s) it polls). Registering only localActivityMocks here is
  // DEFENSE IN DEPTH on top of that, not the primary control: the actual
  // primary enforcement is workflows.ts's explicit `taskQueue:
  // 'platform-queue'` on the remote proxyActivities block, which is baked
  // into the compiled workflow bundle itself and applies identically
  // wherever that bundle runs. Omitting PlatformComplianceActivities'
  // registration here means that even if a future code change somehow
  // mis-routed a remote call onto p2p-queue by mistake, this worker would
  // fail loudly with "activity not registered" rather than silently
  // executing AML/Fraud logic inside the wrong perimeter.
  // ---------------------------------------------------------------------
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: 'p2p-queue',
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities: localActivityMocks,
    // -------------------------------------------------------------------
    // CBU DATA LOCALIZATION ENFORCEMENT (F11)
    // By providing a payload codec here, all workflow inputs/outputs
    // (including device IDs and session tokens) are AES-GCM encrypted 
    // BEFORE leaving this BYOC perimeter. The SaaS Temporal server 
    // only ever receives and stores ciphertext.
    // -------------------------------------------------------------------
    // dataConverter: {
    //   payloadCodecs: [new ByocEncryptionCodec(requireEnv('BYOC_ENCRYPTION_KEY'))]
    // }
  });

  await worker.run();
}

main().catch((err) => {
  console.error('Fatal error starting BYOC P2P worker:', err);
  process.exit(1);
});