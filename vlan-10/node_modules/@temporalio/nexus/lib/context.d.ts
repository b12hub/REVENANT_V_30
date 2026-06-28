import { AsyncLocalStorage } from 'node:async_hooks';
import type * as nexus from 'nexus-rpc';
import type { Logger, MetricMeter } from '@temporalio/common';
import type { Client } from '@temporalio/client';
export declare const asyncLocalStorage: AsyncLocalStorage<HandlerContext>;
export declare function getHandlerContext(): HandlerContext;
/**
 * Context used internally in the SDK to propagate information from the worker to the Temporal Nexus helpers.
 *
 * @internal
 * @hidden
 */
export interface HandlerContext {
    log: Logger;
    metrics: MetricMeter;
    client: Client;
    namespace: string;
    taskQueue: string;
    endpoint: string;
}
/**
 * Holds information about the current Nexus Operation Execution.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface OperationInfo {
    /**
     * Namespace this Nexus Operation is executing in
     */
    readonly namespace: string;
    /**
     * Task Queue this Nexus Operation is executing on
     */
    readonly taskQueue: string;
    /**
     * Nexus Endpoint this Operation was routed through.
     * Only available with server version 1.30.0 or later.
     */
    readonly endpoint: string;
}
/**
 * Context received by a {@link TemporalOperationHandler}'s start handler when a Nexus Operation is
 * started.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalStartOperationContext extends nexus.StartOperationContext {
}
/**
 * Context received by a {@link TemporalOperationHandler}'s cancel handler when a Nexus Operation is
 * canceled.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalCancelOperationContext extends nexus.CancelOperationContext {
}
/**
 * A logger for use in Nexus Handler scope.
 *
 * This defaults to the `Runtime`'s Logger (see {@link Runtime.logger}). Attributes from the
 * current Nexus handler context are automatically included as metadata on every log entries. An
 * extra `sdkComponent` metadata attribute is also added, with value `nexus`; this can be used
 * for fine-grained filtering of log entries further downstream.
 *
 * To customize log attributes, register a {@link nexus.NexusOutboundCallsInterceptor} that
 * intercepts the `getLogAttributes()` method.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export declare const log: Logger;
/**
 * A metric meter for use in Nexus handler scope, with Nexus handler-specific tags.
 *
 * To add custom tags, register a {@link nexus.NexusOutboundCallsInterceptor} that
 * intercepts the `getMetricTags()` method.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export declare const metricMeter: MetricMeter;
/**
 * Returns a client to be used in a Nexus Operation's context, this Client is powered by the same
 * NativeConnection that the worker was created with.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export declare function getClient(): Client;
/**
 * Get information about the current Nexus Operation.
 *
 * @return OperationInfo for the current Nexus Operation being executed
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export declare function operationInfo(): OperationInfo;
