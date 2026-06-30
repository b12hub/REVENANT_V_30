// temporal-interceptors.ts
//
// VERSION HONESTY NOTE, stated once, up front: the Temporal TypeScript
// SDK's interceptor interface names and exact field shapes have moved
// across versions. Every interceptor interface and input-type name below
// is structurally accurate to the SDK's established pattern, but should
// be checked against whatever `@temporalio/*` version is actually
// installed before this ships — the same category of honest gap already
// flagged for the generated gRPC bindings in VLAN 0's dispatch.ts.
//
// THE SPLIT THIS FILE IMPLEMENTS, AND WHY:
//
// The task asks for one unified mechanism propagating tenant context
// across the client → workflow → activity boundary. That's the right
// GOAL. It can't be one unified MECHANISM, for a real, non-negotiable
// reason: Temporal workflow code runs inside a deterministic, sandboxed
// bundle that does not provide `node:async_hooks` (or most other Node
// core modules) at all — importing tenant-context.ts's AsyncLocalStorage-
// based primitive from workflow code would fail to bundle, not just
// behave unexpectedly.
//
// The fix exploits a guarantee the SDK already provides for free: each
// individual workflow EXECUTION gets its own isolated module-scope
// instance — the SDK never interleaves two different executions' code
// within the same instantiated module state. A workflow execution belongs
// to exactly one tenant for its entire lifetime. That means a plain,
// non-AsyncLocalStorage, module-scoped variable is ALREADY execution-
// isolated by construction on the workflow side — no async_hooks needed,
// and none available anyway.
//
// Net result: TWO parallel context mechanisms, clearly named so they're
// never confused —
//   - Activities & the workflow CLIENT run in plain Node.js processes →
//     use the REAL tenant-context.ts (Activities: ActivityInbound
//     interceptor; client: WorkflowClient interceptor).
//   - Workflow code itself runs in the sandbox → uses the small,
//     intentionally-duplicated, NODE-IMPORT-FREE context holder defined
//     locally in this file below. It is NOT imported from tenant-
//     context.ts, even for just the error classes — doing so would pull
//     tenant-context.ts's `node:async_hooks` import transitively into the
//     workflow bundle the moment this file's workflow-side interceptors
//     get bundled, which is exactly the failure this split exists to avoid.

import type { Next } from '@temporalio/common';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import {
  getTenantContext,
  runWithTenantContext,
  type TenantContext,
} from './tenant-context.js';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
} from '@temporalio/worker';
import type {
  WorkflowClientInterceptor,
  WorkflowStartInput,
  WorkflowExecution,
} from '@temporalio/client';
import type {
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
  ActivityInput,
  WorkflowInterceptorsFactory,
  StartChildWorkflowExecutionInput,
} from '@temporalio/workflow';

// ---------------------------------------------------------------------------
// Header keys — one shared constant set, since both sides (encode in the
// client/workflow-outbound interceptors, decode in the activity/workflow-
// inbound interceptors) must agree on the exact same key strings.
// ---------------------------------------------------------------------------

const HEADER_TENANT_ID = 'revenant-tenant-id';
const HEADER_TRACE_ID = 'revenant-trace-id';
const HEADER_ENVIRONMENT = 'revenant-environment';
const HEADER_AUTH_FACTOR_LEVEL = 'revenant-auth-factor-level';

function encodeContextIntoHeaders(context: TenantContext, headers: Headers): Headers {
  return {
    ...headers,
    [HEADER_TENANT_ID]: defaultPayloadConverter.toPayload(context.tenantId),
    [HEADER_TRACE_ID]: defaultPayloadConverter.toPayload(context.traceId),
    [HEADER_ENVIRONMENT]: defaultPayloadConverter.toPayload(context.environment),
    [HEADER_AUTH_FACTOR_LEVEL]: defaultPayloadConverter.toPayload(context.authFactorLevel),
  };
}

/**
 * Returns null (never throws) on a missing/malformed header set — the
 * INBOUND interceptors decide whether a missing context is fatal for
 * their specific boundary, not this shared decode helper.
 */
function decodeContextFromHeaders(headers: Headers): TenantContext | null {
  const tenantIdPayload = headers[HEADER_TENANT_ID];
  const traceIdPayload = headers[HEADER_TRACE_ID];
  const environmentPayload = headers[HEADER_ENVIRONMENT];
  const authFactorPayload = headers[HEADER_AUTH_FACTOR_LEVEL];

  if (!tenantIdPayload || !traceIdPayload || !environmentPayload || !authFactorPayload) {
    return null;
  }

  try {
    return {
      tenantId: defaultPayloadConverter.fromPayload<string>(tenantIdPayload),
      traceId: defaultPayloadConverter.fromPayload<string>(traceIdPayload),
      environment: defaultPayloadConverter.fromPayload<TenantContext['environment']>(environmentPayload),
      authFactorLevel: defaultPayloadConverter.fromPayload<TenantContext['authFactorLevel']>(authFactorPayload),
    };
  } catch {
    return null; // malformed payload — treated identically to "absent" by every caller below
  }
}

// =============================================================================
// NODE-SIDE: real tenant-context.ts, real AsyncLocalStorage.
// =============================================================================

/**
 * Client-side interceptor. Runs in the plain Node.js process that calls
 * `client.workflow.start()` — e.g. VLAN 0's gRPC dispatcher, or a VLAN's
 * own service starting its Temporal workflow. Reads from the REAL
 * AsyncLocalStorage context (already established upstream by that
 * process's own request-handling middleware) and stamps it into the
 * headers that travel with the StartWorkflowExecution command into
 * Temporal's history — this is what the workflow-side inbound interceptor
 * below decodes once execution begins.
 */
export class TenantWorkflowClientInterceptor implements WorkflowClientInterceptor {
  async start(input: WorkflowStartInput, next: Next<WorkflowClientInterceptor, 'start'>): Promise<string> {
    const context = getTenantContext(); // fail-closed — refuses to start a workflow with no tenant attached
    return next({ ...input, headers: encodeContextIntoHeaders(context, input.headers) });
  }
}

/**
 * Worker-side Activity interceptor. Activities execute in plain Node.js
 * worker processes — this IS where the real AsyncLocalStorage mechanism
 * is correctly used, the mirror image of the workflow-sandbox restriction
 * described in the file header. Decodes the headers Temporal delivered
 * alongside the ScheduleActivityTask command and wraps the actual
 * Activity function call in runWithTenantContext(), so every Activity
 * function written elsewhere in this codebase (P2P's executeTransfer,
 * Credit's checkEligibility, etc.) can call getTenantContext() with zero
 * prop-drilling — exactly the property this whole feature exists to provide.
 */
export class TenantActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const context = decodeContextFromHeaders(input.headers);
    if (!context) {
      // Fail closed: an Activity invoked with no tenant context attached
      // is a configuration/propagation bug upstream, never a state safe
      // to execute business logic in. Throwing here surfaces it loudly
      // at the Activity boundary rather than letting getTenantContext()
      // throw later, deeper inside whatever the Activity tries to do.
      throw new Error(
        `Activity received no propagated tenant context. ` +
          `This indicates a missing TenantWorkflowOutboundInterceptor registration on the ` +
          `workflow worker, or a workflow started without TenantWorkflowClientInterceptor.`,
      );
    }
    return runWithTenantContext(context, () => next(input));
  }
}
// =============================================================================
// WORKFLOW-SANDBOX SIDE: deliberately NOT tenant-context.ts. See file
// header for the full reasoning. This holder is intentionally as small
// and dependency-free as possible — no imports from anywhere outside this
// file's own module scope, by design.
// =============================================================================

let workflowLocalTenantContext: TenantContext | null = null;

/**
 * Sandbox-local equivalent of MissingTenantContextError. A SEPARATE class
 * from tenant-context.ts's version, deliberately — importing that one
 * here, even just for the class declaration, would still pull
 * tenant-context.ts's top-level `node:async_hooks` import into whatever
 * bundles this file for the workflow sandbox. Two small, independently-
 * declared classes with the same name and intent is the correct tradeoff
 * here, not an oversight.
 */
class WorkflowSandboxMissingTenantContextError extends Error {
  constructor() {
    super(
      'Workflow code called getWorkflowLocalTenantContext() before TenantWorkflowInboundInterceptor ' +
        'established it. This should be structurally impossible if the interceptor is registered ' +
        'correctly — investigate the worker\'s interceptor configuration before assuming this is a ' +
        'transient issue.',
    );
    this.name = 'WorkflowSandboxMissingTenantContextError';
  }
}

/** Safe to call from anywhere within workflow code (workflows.ts files across every VLAN) — fail-closed, mirroring tenant-context.ts's getTenantContext() contract, just backed by a different, sandbox-legal mechanism. */
export function getWorkflowLocalTenantContext(): TenantContext {
  if (!workflowLocalTenantContext) {
    throw new WorkflowSandboxMissingTenantContextError();
  }
  return workflowLocalTenantContext;
}

/**
 * Workflow-INBOUND interceptor: fires once, at the very start of a
 * workflow execution's `execute` entry point, decodes the headers
 * delivered with the StartWorkflowExecution command, and sets the
 * module-scoped holder above for the remainder of this execution's
 * lifetime. Because this workflow instance's module scope is never shared
 * with any other concurrently-running execution (the SDK's own isolation
 * guarantee), this plain assignment is exactly as safe as
 * AsyncLocalStorage would be here, without needing — or being able to use
 * — AsyncLocalStorage at all.
 */
export class TenantWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const context = decodeContextFromHeaders(input.headers);
    if (!context) {
      throw new Error(
        'Workflow execution started with no propagated tenant context in its headers. ' +
          'This indicates TenantWorkflowClientInterceptor was not registered on the client ' +
          'that started this workflow.',
      );
    }
    workflowLocalTenantContext = context;
    return next(input);
  }
}

/**
 * Workflow-OUTBOUND interceptor: fires whenever workflow code SCHEDULES
 * an Activity or starts a child workflow — the literal `scheduleActivity`
 * hook the task asked for, plus `startChildWorkflowExecution` for
 * completeness (a child workflow needs the same propagated context its
 * parent has, for exactly the same reason an Activity does). Reads from
 * the module-scoped holder above (set once by the inbound interceptor at
 * the top of this same execution) and stamps it into the OUTGOING
 * command's headers — this is what TenantActivityInboundInterceptor
 * decodes on the worker side.
 */
export class TenantWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>,
  ): Promise<unknown> {
    const context = getWorkflowLocalTenantContext(); // fail-closed
    return next({ ...input, headers: encodeContextIntoHeaders(context, input.headers) });
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>,
  ): Promise<[Promise<string>, Promise<unknown>]> {
    const context = getWorkflowLocalTenantContext(); // fail-closed
    return next({ ...input, headers: encodeContextIntoHeaders(context, input.headers) });
  }
}

// ---------------------------------------------------------------------------
// Registration surface — the conventions both `Worker.create()` (worker-
// side: activity + workflow-bundling config) and `WorkflowClient` (client-
// side) actually look for.
// ---------------------------------------------------------------------------

/**
 * Worker-side, Node.js-process interceptors — passed directly into
 * `Worker.create({ interceptors: { activityInbound: [...] } })`. These
 * run in plain Node and may safely import from tenant-context.ts.
 */
export const activityInboundInterceptors: ActivityInboundCallsInterceptor[] = [
  new TenantActivityInboundInterceptor(),
];

/**
 * Workflow-side interceptors. These do NOT get passed directly into
 * `Worker.create()` — Temporal requires workflow-bundled interceptors to
 * be discovered via a module path that itself runs through the workflow
 * bundler, conventionally exporting a function literally named
 * `interceptors`. Worker setup points at THIS FILE's path via
 * `Worker.create({ interceptors: { workflowModules: [require.resolve('./temporal-interceptors')] } })` —
 * verify this exact registration shape against the installed SDK version,
 * per this file's header note.
 */
export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [new TenantWorkflowInboundInterceptor()],
  outbound: [new TenantWorkflowOutboundInterceptor()],
});