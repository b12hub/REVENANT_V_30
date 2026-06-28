import type { ActivityFunction, Priority, RetryPolicy, SearchAttributePair, TypedSearchAttributes } from '@temporalio/common';
import type { Duration } from '@temporalio/common/lib/time';
import { temporal } from '@temporalio/proto';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type { ActivityCancelInput, ActivityClientInterceptor, ActivityCountInput, ActivityDescribeInput, ActivityGetResultInput, ActivityListInput, ActivityStartInput, ActivityTerminateInput } from './interceptors';
import type { AsyncCompletionClientOptions } from './async-completion-client';
import { AsyncCompletionClient } from './async-completion-client';
import type { ActivityExecutionDescription, ActivityExecutionInfo, ActivityIdConflictPolicy, ActivityIdReusePolicy, CountActivityExecutions } from './types';
/**
 * Options used to configure {@link ActivityClient}
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export interface ActivityClientOptions extends AsyncCompletionClientOptions {
    interceptors?: ActivityClientInterceptor[];
}
/**
 * Client for starting and managing Activities, and for asynchronous completion and heartbeating of Activities.
 * Includes all functionality of {@link AsyncCompletionClient}.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.activity} to interact with Activities.
 */
export declare class ActivityClient extends AsyncCompletionClient implements TypedActivityClient<any> {
    private readonly interceptedHandlers;
    constructor(options?: ActivityClientOptions);
    /**
     * Returns this client as a {@link TypedActivityClient}. It enables strong type checking of Activity name, arguments
     * and result based on the provided Activity interface. Note that no new client object is created - this method only
     * affects type annotations.
     * @template T Activity interface to use for type checking. The returned client can only start activities present in
     * this interface.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    typed<T>(): TypedActivityClient<T>;
    /**
     * Starts new Standalone Activity execution.
     *
     * @param activity Name of the activity to start.
     * @param options Options controlling the start and execution of the activity.
     * @returns Handle to the started activity. The handle's `runId` property will be set to the started run.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    start<R = any>(activity: string, options: ActivityOptions): Promise<ActivityHandle<R>>;
    /**
     * Executes a Standalone Activity until completion and returns the result.
     * @param activity Name of the activity to start.
     * @param options Options controlling the activity execution.
     * @returns Result of the activity.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    execute<R = any>(activity: string, options: ActivityOptions): Promise<R>;
    /**
     * Creates an Activity handle from ID and optionally from run ID. If `runId` is not set, the handle will refer to the
     * newest Activity run with the given Activity ID.
     *
     * Note 1: this function always succeeds. If the provided ID is invalid, an error will only be thrown when calling
     * the handle's methods.
     *
     * Note 2: if `runID` is not set when calling `getHandle`, then `runId` property of the returned handle will always
     * remain unset, even after method calls are performed. To get the run ID of the targeted activity execution, call
     * {@link ActivityHandle.describe} and read the `activityRunId` field of the returned {@link ActivityExecutionDescription}.
     *
     * @param activityId ID of the Activity.
     * @param runId Optional run ID of the specific Activity execution.
     * @returns Handle to the specified activity execution.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    getHandle<R = any>(activityId: string, runId?: string): ActivityHandle<R>;
    /**
     * Return a list of Activity executions matching the given `query`.
     *
     * Note that the list of Activity executions returned is approximate and eventually consistent.
     *
     * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
     * https://docs.temporal.io/visibility
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    list(query: string): AsyncIterable<ActivityExecutionInfo>;
    /**
     * Return the number of Activity executions matching the given `query`.
     *
     * Note that the number of Activity executions returned is approximate and eventually consistent.
     *
     * More info on the concept of "visibility" and the query syntax on the Temporal documentation site:
     * https://docs.temporal.io/visibility
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    count(query: string): Promise<CountActivityExecutions>;
    protected createHandle<R>(activityId: string, runId?: string): ActivityHandle<R>;
    protected startHandler(input: ActivityStartInput): Promise<ActivityHandle>;
    protected buildStartActivityExecutionRequest(input: ActivityStartInput): Promise<temporal.api.workflowservice.v1.IStartActivityExecutionRequest>;
    protected getResultHandler(input: ActivityGetResultInput): Promise<any>;
    protected describeHandler(input: ActivityDescribeInput): Promise<ActivityExecutionDescription>;
    protected cancelHandler(input: ActivityCancelInput): Promise<void>;
    protected terminateHandler(input: ActivityTerminateInput): Promise<void>;
    protected listHandler(input: ActivityListInput): AsyncIterable<ActivityExecutionInfo>;
    protected countHandler(input: ActivityCountInput): Promise<CountActivityExecutions>;
    protected rethrowGrpcError(err: unknown, fallbackMessage: string): never;
}
/**
 * Handle that can be used to perform operations on the associated Activity.
 * Can be obtained by calling {@link ActivityClient.start} or {@link ActivityClient.getHandle}.
 * @template R Result type of the activity. Use {@link ActivityClient.typed} to start activities in a type-safe way.
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export interface ActivityHandle<R = any> {
    /**
     * ID of the Activity this handle refers to.
     */
    readonly activityId: string;
    /**
     * Run ID of the specific Activity execution this handle refers to. If empty, this handle refers to the latest
     * execution of the Activity with given ID.
     */
    readonly runId?: string;
    /**
     * Waits until the activity completes. If the activity is successful, returns the result of the activity.
     * If the activity was not successful, throws {@link ActivityExecutionFailedError}. The activity failure is stored in
     * the `cause` field.
     */
    result(): Promise<R>;
    /**
     * Returns information about the Activity execution.
     */
    describe(): Promise<ActivityExecutionDescription>;
    /**
     * Requests cancellation of the Activity execution. Note that cancellations are cooperative and not guaranteed to happen.
     */
    cancel(reason: string): Promise<void>;
    /**
     * Terminates the Activity execution. Note that the worker is not immediately notified of termination and may continue running the activity.
     */
    terminate(reason: string): Promise<void>;
}
/**
 * Options used by {@link ActivityClient.start}.
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export interface ActivityOptions {
    /**
     * Activity ID of the started activity. It's recommended to use a meaningful business ID.
     */
    id: string;
    /**
     * Task queue to run this activity on.
     */
    taskQueue: string;
    /**
     * Input arguments to pass to the activity.
     */
    args?: any[] | Readonly<any[]>;
    /**
     * If set, specifies maximum time between successful heartbeats.
     */
    heartbeatTimeout?: Duration;
    /**
     * Controls how Activity is retried. If not set, the server will assign default retry policy.
     */
    retry?: RetryPolicy;
    /**
     * Is set, specifies total time the activity is allowed to run, including retries.
     *
     * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
     */
    startToCloseTimeout?: Duration;
    /**
     * If set, specifies maximum time the activity can wait in the task queue before being picked up by a worker.
     * This timeout is non-retryable.
     */
    scheduleToStartTimeout?: Duration;
    /**
     * If set, specifies maximum time for a single execution attempt. This timeout is retryable.
     *
     * Note: it is required to set at least one of {@link startToCloseTimeout} and {@link scheduleToCloseTimeout}.
     */
    scheduleToCloseTimeout?: Duration;
    /**
     * A single-line fixed summary for this activity execution that may appear in UI/CLI.
     * This can be in single-line Temporal markdown format.
     */
    summary?: string;
    /**
     * Priority to use when starting this activity.
     */
    priority?: Priority;
    /**
     * Time to wait before dispatching the first activity task. This delay is not applied to retry attempts.
     */
    startDelay?: Duration;
    /**
     * Specifies behavior if there's a *closed* activity with the same ID.
     */
    idReusePolicy?: ActivityIdReusePolicy;
    /**
     * Specifies behavior if there's a *running* activity with the same ID. Note that there can only be one running
     * Activity for each Activity ID.
     */
    idConflictPolicy?: ActivityIdConflictPolicy;
    /**
     * Search attributes for the activity.
     */
    typedSearchAttributes?: SearchAttributePair[] | TypedSearchAttributes;
}
/**
 * Sub-interface of {@link ActivityClient} that provides a strongly-typed interface for executing Activities.
 * Argument types in the provided options must match the argument types of the specified Activity as defined in provided
 * interface
 * @template T Activity interface
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export interface TypedActivityClient<T> {
    start<N extends ActivityName<T>>(activity: N, options: ActivityOptionsFor<T, N>): Promise<ActivityHandle<ActivityResult<T, N>>>;
    execute<N extends ActivityName<T>>(activity: N, options: ActivityOptionsFor<T, N>): Promise<ActivityResult<T, N>>;
}
/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Contains names of activities extracted from the specified activity interface.
 * @template T Activity interface
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityName<T> = {
    [N in keyof T & string]: T[N] extends ActivityFunction<any, any> ? N : never;
}[keyof T & string];
/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts argument types of an activity.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityArgs<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<infer P, any> ? P : never;
/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Extracts result type of an activity.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityResult<T, N extends ActivityName<T>> = T[N] extends ActivityFunction<any, infer R> ? R : never;
/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments.
 * @template Args Types of activity arguments as an array type.
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityOptionsWithArgs<Args extends any[]> = Args extends [any, ...any] ? Replace<ActivityOptions, {
    /**
     * Arguments to pass to the Activity
     */
    args: Args | Readonly<Args>;
}> : Replace<ActivityOptions, {
    /**
     * Arguments to pass to the Activity
     */
    args?: Args | Readonly<Args>;
}>;
/**
 * Utility type to support strong typing in {@link TypedActivityClient}.
 * Represents {@link ActivityOptions} with strongly typed arguments matching specified Activity in specified interface.
 * @template T Activity interface
 * @template N Activity name
 *
 * @experimental Standalone Activities are experimental. APIs may be subject to change.
 */
export type ActivityOptionsFor<T, N extends ActivityName<T>> = ActivityOptionsWithArgs<ActivityArgs<T, N>>;
