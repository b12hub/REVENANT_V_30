"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivityClient = void 0;
const node_crypto_1 = require("node:crypto");
const grpc_js_1 = require("@grpc/grpc-js");
const common_1 = require("@temporalio/common");
const time_1 = require("@temporalio/common/lib/time");
const interceptors_1 = require("@temporalio/common/lib/interceptors");
const payload_search_attributes_1 = require("@temporalio/common/lib/converter/payload-search-attributes");
const internal_non_workflow_1 = require("@temporalio/common/lib/internal-non-workflow");
const proto_1 = require("@temporalio/proto");
const async_completion_client_1 = require("./async-completion-client");
const types_1 = require("./types");
const helpers_1 = require("./helpers");
const errors_1 = require("./errors");
/**
 * Client for starting and managing Activities, and for asynchronous completion and heartbeating of Activities.
 * Includes all functionality of {@link AsyncCompletionClient}.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.activity} to interact with Activities.
 */
class ActivityClient extends async_completion_client_1.AsyncCompletionClient {
    interceptedHandlers;
    constructor(options) {
        super(options);
        const interceptors = options?.interceptors ?? [];
        this.interceptedHandlers = {
            start: (0, interceptors_1.composeInterceptors)(interceptors, 'start', this.startHandler.bind(this)),
            getResult: (0, interceptors_1.composeInterceptors)(interceptors, 'getResult', this.getResultHandler.bind(this)),
            describe: (0, interceptors_1.composeInterceptors)(interceptors, 'describe', this.describeHandler.bind(this)),
            cancel: (0, interceptors_1.composeInterceptors)(interceptors, 'cancel', this.cancelHandler.bind(this)),
            terminate: (0, interceptors_1.composeInterceptors)(interceptors, 'terminate', this.terminateHandler.bind(this)),
            list: (0, interceptors_1.composeInterceptors)(interceptors, 'list', this.listHandler.bind(this)),
            count: (0, interceptors_1.composeInterceptors)(interceptors, 'count', this.countHandler.bind(this)),
        };
    }
    /**
     * Returns this client as a {@link TypedActivityClient}. It enables strong type checking of Activity name, arguments
     * and result based on the provided Activity interface. Note that no new client object is created - this method only
     * affects type annotations.
     * @template T Activity interface to use for type checking. The returned client can only start activities present in
     * this interface.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    typed() {
        return this;
    }
    /**
     * Starts new Standalone Activity execution.
     *
     * @param activity Name of the activity to start.
     * @param options Options controlling the start and execution of the activity.
     * @returns Handle to the started activity. The handle's `runId` property will be set to the started run.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    async start(activity, options) {
        return this.interceptedHandlers.start({
            activityType: activity,
            options,
            headers: {},
        });
    }
    /**
     * Executes a Standalone Activity until completion and returns the result.
     * @param activity Name of the activity to start.
     * @param options Options controlling the activity execution.
     * @returns Result of the activity.
     *
     * @experimental Standalone Activities are experimental. APIs may be subject to change.
     */
    async execute(activity, options) {
        const handle = await this.start(activity, options);
        return handle.result();
    }
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
    getHandle(activityId, runId) {
        return this.createHandle(activityId, runId);
    }
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
    list(query) {
        return this.interceptedHandlers.list({
            query,
            headers: {},
        });
    }
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
    async count(query) {
        return await this.interceptedHandlers.count({
            query,
            headers: {},
        });
    }
    createHandle(activityId, runId) {
        if (!activityId) {
            throw new TypeError('activityId is required');
        }
        const handle = {
            client: this,
            activityId,
            runId,
            async result() {
                return await this.client.interceptedHandlers.getResult({
                    activityId: this.activityId,
                    activityRunId: this.runId ?? '',
                    headers: {},
                });
            },
            async describe() {
                return await this.client.interceptedHandlers.describe({
                    activityId: this.activityId,
                    activityRunId: this.runId ?? '',
                    headers: {},
                });
            },
            async cancel(reason) {
                return await this.client.interceptedHandlers.cancel({
                    activityId: this.activityId,
                    activityRunId: this.runId ?? '',
                    reason,
                    headers: {},
                });
            },
            async terminate(reason) {
                return await this.client.interceptedHandlers.terminate({
                    activityId: this.activityId,
                    activityRunId: this.runId ?? '',
                    reason,
                    headers: {},
                });
            },
        };
        return handle;
    }
    async startHandler(input) {
        if (!input.activityType) {
            throw new TypeError('activityType is required');
        }
        validateActivityOptions(input.options);
        try {
            const resp = await this.workflowService.startActivityExecution(await this.buildStartActivityExecutionRequest(input));
            return this.createHandle(input.options.id, resp.runId);
        }
        catch (err) {
            if ((0, errors_1.isGrpcServiceError)(err) && err.code === grpc_js_1.status.ALREADY_EXISTS) {
                for (const entry of (0, helpers_1.getGrpcStatusDetails)(err) ?? []) {
                    if (!entry.type_url || !entry.value)
                        continue;
                    if ((0, helpers_1.trimGrpcTypeUrl)(entry.type_url) ===
                        'temporal.api.errordetails.v1.ActivityExecutionAlreadyStartedFailure') {
                        const details = proto_1.temporal.api.errordetails.v1.ActivityExecutionAlreadyStartedFailure.decode(entry.value);
                        throw new errors_1.ActivityExecutionAlreadyStartedError('Activity execution already started', input.options.id, details.runId);
                    }
                }
            }
            this.rethrowGrpcError(err, 'Failed to start activity');
        }
    }
    async buildStartActivityExecutionRequest(input) {
        const searchAttributes = input.options.typedSearchAttributes
            ? { indexedFields: (0, payload_search_attributes_1.encodeUnifiedSearchAttributes)(undefined, input.options.typedSearchAttributes) }
            : undefined;
        return {
            namespace: this.options.namespace,
            identity: this.options.identity,
            requestId: (0, node_crypto_1.randomUUID)(),
            activityId: input.options.id,
            activityType: { name: input.activityType },
            taskQueue: { name: input.options.taskQueue },
            scheduleToCloseTimeout: (0, time_1.msOptionalToTs)(input.options.scheduleToCloseTimeout),
            scheduleToStartTimeout: (0, time_1.msOptionalToTs)(input.options.scheduleToStartTimeout),
            startToCloseTimeout: (0, time_1.msOptionalToTs)(input.options.startToCloseTimeout),
            heartbeatTimeout: (0, time_1.msOptionalToTs)(input.options.heartbeatTimeout),
            retryPolicy: input.options.retry ? (0, common_1.compileRetryPolicy)(input.options.retry) : undefined,
            input: { payloads: await (0, internal_non_workflow_1.encodeToPayloads)(this.dataConverter, ...(input.options.args || [])) },
            idReusePolicy: (0, types_1.encodeActivityIdReusePolicy)(input.options.idReusePolicy),
            idConflictPolicy: (0, types_1.encodeActivityIdConflictPolicy)(input.options.idConflictPolicy),
            searchAttributes,
            header: { fields: input.headers },
            userMetadata: await (0, internal_non_workflow_1.encodeUserMetadata)(this.dataConverter, input.options.summary, undefined),
            priority: input.options.priority ? (0, common_1.compilePriority)(input.options.priority) : undefined,
            startDelay: (0, time_1.msOptionalToTs)(input.options.startDelay),
        };
    }
    async getResultHandler(input) {
        if (!input.activityId) {
            throw new TypeError('activityId is required');
        }
        const req = {
            namespace: this.options.namespace,
            activityId: input.activityId,
            runId: input.activityRunId || undefined,
        };
        for (;;) {
            let failedErr;
            try {
                const resp = await this.workflowService.pollActivityExecution(req);
                if (resp.outcome?.result) {
                    const [result] = await (0, internal_non_workflow_1.decodeArrayFromPayloads)(this.dataConverter, resp.outcome.result.payloads ?? []);
                    return result;
                }
                else if (resp.outcome?.failure) {
                    // If error conversion throws an exception, we want it to be caught and handled by rethrowGrpcError().
                    // If it succeeds, we want to throw the ActivityExecutionFailedError directly, so outside of try/catch.
                    failedErr = new errors_1.ActivityExecutionFailedError('Activity execution failed', await (0, internal_non_workflow_1.decodeOptionalFailureToOptionalError)(this.dataConverter, resp.outcome.failure), input.activityId, resp.runId || input.activityRunId || undefined);
                }
            }
            catch (err) {
                this.rethrowGrpcError(err, 'Failed to get activity result');
            }
            if (failedErr) {
                throw failedErr;
            }
        }
    }
    async describeHandler(input) {
        if (!input.activityId) {
            throw new TypeError('activityId is required');
        }
        try {
            const resp = await this.workflowService.describeActivityExecution({
                namespace: this.options.namespace,
                activityId: input.activityId,
                runId: input.activityRunId || undefined,
            });
            return buildActivityDescription(resp.info, this.dataConverter);
        }
        catch (err) {
            this.rethrowGrpcError(err, 'Failed to describe activity');
        }
    }
    async cancelHandler(input) {
        if (!input.activityId) {
            throw new TypeError('activityId is required');
        }
        try {
            await this.workflowService.requestCancelActivityExecution({
                namespace: this.options.namespace,
                activityId: input.activityId,
                runId: input.activityRunId || undefined,
                identity: this.options.identity,
                requestId: (0, node_crypto_1.randomUUID)(),
                reason: input.reason || undefined,
            });
        }
        catch (err) {
            this.rethrowGrpcError(err, 'Failed to request activity cancellation');
        }
    }
    async terminateHandler(input) {
        if (!input.activityId) {
            throw new TypeError('activityId is required');
        }
        try {
            await this.workflowService.terminateActivityExecution({
                namespace: this.options.namespace,
                activityId: input.activityId,
                runId: input.activityRunId || undefined,
                identity: this.options.identity,
                requestId: (0, node_crypto_1.randomUUID)(),
                reason: input.reason || undefined,
            });
        }
        catch (err) {
            this.rethrowGrpcError(err, 'Failed to terminate activity');
        }
    }
    async *listHandler(input) {
        let nextPageToken = undefined;
        do {
            try {
                const resp = await this.workflowService.listActivityExecutions({
                    namespace: this.options.namespace,
                    query: input.query,
                    nextPageToken,
                });
                for (const info of resp.executions ?? []) {
                    yield buildActivityExecutionInfo(info);
                }
                nextPageToken = resp.nextPageToken;
            }
            catch (e) {
                this.rethrowGrpcError(e, 'Failed to list activities');
            }
        } while (nextPageToken && nextPageToken.length > 0);
    }
    async countHandler(input) {
        try {
            const resp = await this.workflowService.countActivityExecutions({
                namespace: this.options.namespace,
                query: input.query,
            });
            return {
                count: resp.count?.toNumber() ?? 0,
                groups: resp.groups?.map((g) => ({
                    count: g.count?.toNumber() ?? 0,
                    groupValues: g.groupValues?.map((v) => payload_search_attributes_1.searchAttributePayloadConverter.fromPayload(v)),
                })),
            };
        }
        catch (err) {
            this.rethrowGrpcError(err, 'Failed to count activities');
        }
    }
    rethrowGrpcError(err, fallbackMessage) {
        if ((0, errors_1.isGrpcServiceError)(err)) {
            (0, helpers_1.rethrowKnownErrorTypes)(err);
            if (err.code === grpc_js_1.status.NOT_FOUND) {
                throw new errors_1.ActivityNotFoundError(err.details ?? 'Activity not found');
            }
            throw new errors_1.ServiceError(fallbackMessage, { cause: err });
        }
        throw new errors_1.ServiceError('Unexpected error while making gRPC request');
    }
}
exports.ActivityClient = ActivityClient;
function validateActivityOptions(options) {
    if (!options.id) {
        throw new TypeError('id is required');
    }
    if (!options.taskQueue) {
        throw new TypeError('taskQueue is required');
    }
    if (!options.scheduleToCloseTimeout && !options.startToCloseTimeout) {
        throw new TypeError('Either scheduleToCloseTimeout or startToCloseTimeout is required');
    }
    if (options.startDelay !== undefined && (0, time_1.msToNumber)(options.startDelay) < 0) {
        throw new TypeError('startDelay must be non-negative');
    }
}
function buildActivityExecutionInfoCommonPart(info) {
    return {
        activityId: info.activityId,
        activityRunId: info.runId,
        activityType: info.activityType.name,
        scheduleTime: (0, time_1.optionalTsToDate)(info.scheduleTime),
        closeTime: (0, time_1.optionalTsToDate)(info.closeTime),
        status: (0, types_1.decodeActivityExecutionStatus)(info.status),
        typedSearchAttributes: (0, payload_search_attributes_1.decodeTypedSearchAttributes)(info.searchAttributes?.indexedFields),
        taskQueue: info.taskQueue,
        executionDurationMs: (0, time_1.optionalTsToMs)(info.executionDuration),
    };
}
function buildActivityExecutionInfo(info) {
    return {
        ...buildActivityExecutionInfoCommonPart(info),
        rawListInfo: info,
    };
}
function buildActivityDescription(info, dataConverter) {
    const getHeartbeatDetails = async () => {
        const payloads = info.heartbeatDetails?.payloads;
        if (payloads && payloads.length > 0) {
            return await (0, internal_non_workflow_1.decodeFromPayloadsAtIndex)(dataConverter, 0, info.heartbeatDetails?.payloads);
        }
        else {
            return undefined;
        }
    };
    const getLastFailure = async () => {
        return await (0, internal_non_workflow_1.decodeOptionalFailureToOptionalError)(dataConverter, info.lastFailure);
    };
    return {
        ...buildActivityExecutionInfoCommonPart(info),
        rawInfo: info,
        runState: (0, types_1.decodePendingActivityState)(info.runState),
        scheduleToCloseTimeoutMs: (0, time_1.optionalTsToMs)(info.scheduleToCloseTimeout),
        scheduleToStartTimeoutMs: (0, time_1.optionalTsToMs)(info.scheduleToStartTimeout),
        startToCloseTimeoutMs: (0, time_1.optionalTsToMs)(info.startToCloseTimeout),
        heartbeatTimeoutMs: (0, time_1.optionalTsToMs)(info.heartbeatTimeout),
        retryPolicy: (0, common_1.decompileRetryPolicy)(info.retryPolicy),
        lastHeartbeatTime: (0, time_1.optionalTsToDate)(info.lastHeartbeatTime),
        lastStartedTime: (0, time_1.optionalTsToDate)(info.lastStartedTime),
        attempt: info.attempt,
        expirationTime: (0, time_1.optionalTsToDate)(info.expirationTime),
        lastWorkerIdentity: info.lastWorkerIdentity || undefined,
        currentRetryIntervalMs: (0, time_1.optionalTsToMs)(info.currentRetryInterval),
        lastAttemptCompleteTime: (0, time_1.optionalTsToDate)(info.lastAttemptCompleteTime),
        nextAttemptScheduleTime: (0, time_1.optionalTsToDate)(info.nextAttemptScheduleTime),
        lastDeploymentVersion: (0, common_1.convertDeploymentVersion)(info.lastDeploymentVersion),
        priority: (0, common_1.decodePriority)(info.priority),
        canceledReason: info.canceledReason || undefined,
        getHeartbeatDetails,
        getLastFailure,
    };
}
//# sourceMappingURL=activity-client.js.map