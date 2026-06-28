"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncCompletionClient = void 0;
const grpc_js_1 = require("@grpc/grpc-js");
const common_1 = require("@temporalio/common");
const internal_non_workflow_1 = require("@temporalio/common/lib/internal-non-workflow");
const internal_workflow_1 = require("@temporalio/common/lib/internal-workflow");
const base_client_1 = require("./base-client");
const errors_1 = require("./errors");
const helpers_1 = require("./helpers");
function defaultAsyncCompletionClientOptions() {
    return (0, base_client_1.defaultBaseClientOptions)();
}
function activityContextFromFullActivityId(namespace, fullActivityId) {
    return {
        type: 'activity',
        namespace,
        workflowId: fullActivityId.workflowId,
        activityId: fullActivityId.activityId,
        isLocal: false,
    };
}
/**
 * A client for asynchronous completion and heartbeating of Activities.
 *
 * Typically this client should not be instantiated directly, instead create the high level {@link Client} and use
 * {@link Client.activity} to complete async activities.
 */
class AsyncCompletionClient extends base_client_1.BaseClient {
    options;
    constructor(options) {
        super(options);
        this.options = {
            ...defaultAsyncCompletionClientOptions(),
            ...(0, internal_workflow_1.filterNullAndUndefined)(options ?? {}),
            loadedDataConverter: this.dataConverter,
        };
    }
    /**
     * Raw gRPC access to the Temporal service.
     *
     * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made via this service
     * object.
     */
    get workflowService() {
        return this.connection.workflowService;
    }
    serializationContextFor(taskTokenOrFullActivityId, options) {
        return taskTokenOrFullActivityId instanceof Uint8Array
            ? options?.serializationContext
            : activityContextFromFullActivityId(this.options.namespace, taskTokenOrFullActivityId);
    }
    /**
     * Transforms grpc errors into well defined TS errors.
     */
    handleError(err) {
        if ((0, errors_1.isGrpcServiceError)(err)) {
            (0, helpers_1.rethrowKnownErrorTypes)(err);
            if (err.code === grpc_js_1.status.NOT_FOUND) {
                throw new errors_1.ActivityNotFoundError('Not found');
            }
            throw new errors_1.ActivityCompletionError(err.details || err.message);
        }
        throw new errors_1.ActivityCompletionError('Unexpected failure');
    }
    async complete(taskTokenOrFullActivityId, result, options) {
        const payloads = await (0, internal_non_workflow_1.encodeToPayloadsWithContext)(this.dataConverter, this.serializationContextFor(taskTokenOrFullActivityId, options), [result]);
        try {
            if (taskTokenOrFullActivityId instanceof Uint8Array) {
                await this.workflowService.respondActivityTaskCompleted({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    taskToken: taskTokenOrFullActivityId,
                    result: { payloads },
                });
            }
            else {
                await this.workflowService.respondActivityTaskCompletedById({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    ...taskTokenOrFullActivityId,
                    result: { payloads },
                });
            }
        }
        catch (err) {
            this.handleError(err);
        }
    }
    async fail(taskTokenOrFullActivityId, err, options) {
        const failure = await (0, internal_non_workflow_1.encodeErrorToFailure)(this.dataConverter, (0, common_1.ensureTemporalFailure)(err), this.serializationContextFor(taskTokenOrFullActivityId, options));
        try {
            if (taskTokenOrFullActivityId instanceof Uint8Array) {
                await this.workflowService.respondActivityTaskFailed({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    taskToken: taskTokenOrFullActivityId,
                    failure,
                });
            }
            else {
                await this.workflowService.respondActivityTaskFailedById({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    ...taskTokenOrFullActivityId,
                    failure,
                });
            }
        }
        catch (err) {
            this.handleError(err);
        }
    }
    async reportCancellation(taskTokenOrFullActivityId, details, options) {
        const payloads = await (0, internal_non_workflow_1.encodeToPayloadsWithContext)(this.dataConverter, this.serializationContextFor(taskTokenOrFullActivityId, options), [details]);
        try {
            if (taskTokenOrFullActivityId instanceof Uint8Array) {
                await this.workflowService.respondActivityTaskCanceled({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    taskToken: taskTokenOrFullActivityId,
                    details: { payloads },
                });
            }
            else {
                await this.workflowService.respondActivityTaskCanceledById({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    ...taskTokenOrFullActivityId,
                    details: { payloads },
                });
            }
        }
        catch (err) {
            this.handleError(err);
        }
    }
    async heartbeat(taskTokenOrFullActivityId, details, options) {
        const payloads = await (0, internal_non_workflow_1.encodeToPayloadsWithContext)(this.dataConverter, this.serializationContextFor(taskTokenOrFullActivityId, options), [details]);
        let cancelRequested = false;
        let paused = false;
        let reset = false;
        try {
            if (taskTokenOrFullActivityId instanceof Uint8Array) {
                const response = await this.workflowService.recordActivityTaskHeartbeat({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    taskToken: taskTokenOrFullActivityId,
                    details: { payloads },
                });
                cancelRequested = !!response.cancelRequested;
                paused = !!response.activityPaused;
                reset = !!response.activityReset;
            }
            else {
                const response = await this.workflowService.recordActivityTaskHeartbeatById({
                    identity: this.options.identity,
                    namespace: this.options.namespace,
                    ...taskTokenOrFullActivityId,
                    details: { payloads },
                });
                cancelRequested = !!response.cancelRequested;
                paused = !!response.activityPaused;
                reset = !!response.activityReset;
            }
        }
        catch (err) {
            this.handleError(err);
        }
        // Note that it is possible for a heartbeat response to have multiple fields
        // set as true (i.e. cancelled and pause).
        if (cancelRequested) {
            throw new errors_1.ActivityCancelledError('cancelled');
        }
        else if (reset) {
            throw new errors_1.ActivityResetError('reset');
        }
        else if (paused) {
            throw new errors_1.ActivityPausedError('paused');
        }
    }
}
exports.AsyncCompletionClient = AsyncCompletionClient;
//# sourceMappingURL=async-completion-client.js.map