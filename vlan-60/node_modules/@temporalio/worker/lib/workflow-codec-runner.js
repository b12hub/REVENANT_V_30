"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkflowCodecRunner = void 0;
const internal_non_workflow_1 = require("@temporalio/common/lib/internal-non-workflow");
const proto_1 = require("@temporalio/proto");
/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
class WorkflowCodecRunner {
    codecs;
    workflowContext;
    pendingCompletionContexts = {
        activity: new Map(),
        childWorkflowStart: new Map(),
        childWorkflowComplete: new Map(),
        signalWorkflow: new Map(),
        cancelWorkflow: new Map(),
    };
    constructor(codecs, workflowContext) {
        this.codecs = codecs;
        this.workflowContext = workflowContext;
    }
    consumeContext(map, seq) {
        if (seq == null)
            return undefined;
        const context = map.get(seq);
        if (context !== undefined) {
            map.delete(seq);
        }
        return context;
    }
    activityContext(command, isLocal) {
        return {
            type: 'activity',
            namespace: this.workflowContext.namespace,
            workflowId: this.workflowContext.workflowId,
            activityId: command.activityId || undefined,
            isLocal,
        };
    }
    childWorkflowContext(command) {
        if (command.workflowId == null)
            return undefined;
        return {
            type: 'workflow',
            namespace: command.namespace || this.workflowContext.namespace,
            workflowId: command.workflowId,
        };
    }
    externalWorkflowContext(command) {
        const workflowId = command.workflowExecution?.workflowId ?? ('childWorkflowId' in command ? command.childWorkflowId : undefined);
        if (workflowId == null)
            return undefined;
        return {
            type: 'workflow',
            namespace: command.workflowExecution?.namespace || this.workflowContext.namespace,
            workflowId,
        };
    }
    async encodeUserMetadata(context, userMetadata) {
        if (!(userMetadata && (userMetadata.summary || userMetadata.details))) {
            return undefined;
        }
        return {
            summary: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, userMetadata.summary, context),
            details: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, userMetadata.details, context),
        };
    }
    /**
     * Run codec.decode on the Payloads in the Activation message.
     */
    async decodeActivation(activation) {
        return proto_1.coresdk.workflow_activation.WorkflowActivation.fromObject({
            ...activation,
            jobs: activation.jobs
                ? await Promise.all(activation.jobs.map(async (job) => {
                    const resolveActivityContext = job.resolveActivity
                        ? this.consumeContext(this.pendingCompletionContexts.activity, job.resolveActivity.seq)
                        : undefined;
                    const resolveChildWorkflowExecutionContext = job.resolveChildWorkflowExecution
                        ? this.consumeContext(this.pendingCompletionContexts.childWorkflowComplete, job.resolveChildWorkflowExecution.seq)
                        : undefined;
                    const resolveChildWorkflowStartContext = job.resolveChildWorkflowExecutionStart
                        ? this.consumeContext(this.pendingCompletionContexts.childWorkflowStart, job.resolveChildWorkflowExecutionStart.seq)
                        : undefined;
                    const resolveSignalContext = job.resolveSignalExternalWorkflow
                        ? this.consumeContext(this.pendingCompletionContexts.signalWorkflow, job.resolveSignalExternalWorkflow.seq)
                        : undefined;
                    const resolveCancelContext = job.resolveRequestCancelExternalWorkflow
                        ? this.consumeContext(this.pendingCompletionContexts.cancelWorkflow, job.resolveRequestCancelExternalWorkflow.seq)
                        : undefined;
                    return {
                        ...job,
                        initializeWorkflow: job.initializeWorkflow
                            ? {
                                ...job.initializeWorkflow,
                                arguments: await (0, internal_non_workflow_1.decodeOptional)(this.codecs, job.initializeWorkflow.arguments, this.workflowContext),
                                headers: (0, internal_non_workflow_1.noopDecodeMap)(job.initializeWorkflow.headers),
                                continuedFailure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.initializeWorkflow.continuedFailure, this.workflowContext),
                                memo: {
                                    ...job.initializeWorkflow.memo,
                                    fields: await (0, internal_non_workflow_1.decodeOptionalMap)(this.codecs, job.initializeWorkflow.memo?.fields, this.workflowContext),
                                },
                                lastCompletionResult: {
                                    ...job.initializeWorkflow.lastCompletionResult,
                                    payloads: await (0, internal_non_workflow_1.decodeOptional)(this.codecs, job.initializeWorkflow.lastCompletionResult?.payloads, this.workflowContext),
                                },
                                searchAttributes: job.initializeWorkflow.searchAttributes
                                    ? {
                                        ...job.initializeWorkflow.searchAttributes,
                                        indexedFields: job.initializeWorkflow.searchAttributes.indexedFields
                                            ? (0, internal_non_workflow_1.noopDecodeMap)(job.initializeWorkflow.searchAttributes.indexedFields)
                                            : undefined,
                                    }
                                    : undefined,
                            }
                            : null,
                        queryWorkflow: job.queryWorkflow
                            ? {
                                ...job.queryWorkflow,
                                arguments: await (0, internal_non_workflow_1.decodeOptional)(this.codecs, job.queryWorkflow.arguments, this.workflowContext),
                                headers: (0, internal_non_workflow_1.noopDecodeMap)(job.queryWorkflow.headers),
                            }
                            : null,
                        doUpdate: job.doUpdate
                            ? {
                                ...job.doUpdate,
                                input: await (0, internal_non_workflow_1.decodeOptional)(this.codecs, job.doUpdate.input, this.workflowContext),
                                headers: (0, internal_non_workflow_1.noopDecodeMap)(job.doUpdate.headers),
                            }
                            : null,
                        signalWorkflow: job.signalWorkflow
                            ? {
                                ...job.signalWorkflow,
                                input: await (0, internal_non_workflow_1.decodeOptional)(this.codecs, job.signalWorkflow.input, this.workflowContext),
                                headers: (0, internal_non_workflow_1.noopDecodeMap)(job.signalWorkflow.headers),
                            }
                            : null,
                        resolveActivity: job.resolveActivity
                            ? {
                                ...job.resolveActivity,
                                result: job.resolveActivity.result
                                    ? {
                                        ...job.resolveActivity.result,
                                        completed: job.resolveActivity.result.completed
                                            ? {
                                                ...job.resolveActivity.result.completed,
                                                result: await (0, internal_non_workflow_1.decodeOptionalSingle)(this.codecs, job.resolveActivity.result.completed.result, resolveActivityContext),
                                            }
                                            : null,
                                        failed: job.resolveActivity.result.failed
                                            ? {
                                                ...job.resolveActivity.result.failed,
                                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveActivity.result.failed.failure, resolveActivityContext),
                                            }
                                            : null,
                                        cancelled: job.resolveActivity.result.cancelled
                                            ? {
                                                ...job.resolveActivity.result.cancelled,
                                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveActivity.result.cancelled.failure, resolveActivityContext),
                                            }
                                            : null,
                                    }
                                    : null,
                            }
                            : null,
                        resolveChildWorkflowExecution: job.resolveChildWorkflowExecution
                            ? {
                                ...job.resolveChildWorkflowExecution,
                                result: job.resolveChildWorkflowExecution.result
                                    ? {
                                        ...job.resolveChildWorkflowExecution.result,
                                        completed: job.resolveChildWorkflowExecution.result.completed
                                            ? {
                                                ...job.resolveChildWorkflowExecution.result.completed,
                                                result: await (0, internal_non_workflow_1.decodeOptionalSingle)(this.codecs, job.resolveChildWorkflowExecution.result.completed.result, resolveChildWorkflowExecutionContext),
                                            }
                                            : null,
                                        failed: job.resolveChildWorkflowExecution.result.failed
                                            ? {
                                                ...job.resolveChildWorkflowExecution.result.failed,
                                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveChildWorkflowExecution.result.failed.failure, resolveChildWorkflowExecutionContext),
                                            }
                                            : null,
                                        cancelled: job.resolveChildWorkflowExecution.result.cancelled
                                            ? {
                                                ...job.resolveChildWorkflowExecution.result.cancelled,
                                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveChildWorkflowExecution.result.cancelled.failure, resolveChildWorkflowExecutionContext),
                                            }
                                            : null,
                                    }
                                    : null,
                            }
                            : null,
                        resolveChildWorkflowExecutionStart: job.resolveChildWorkflowExecutionStart
                            ? {
                                ...job.resolveChildWorkflowExecutionStart,
                                cancelled: job.resolveChildWorkflowExecutionStart.cancelled
                                    ? {
                                        ...job.resolveChildWorkflowExecutionStart.cancelled,
                                        failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveChildWorkflowExecutionStart.cancelled.failure, resolveChildWorkflowStartContext),
                                    }
                                    : null,
                            }
                            : null,
                        resolveNexusOperation: job.resolveNexusOperation
                            ? {
                                ...job.resolveNexusOperation,
                                result: {
                                    completed: job.resolveNexusOperation.result?.completed
                                        ? await (0, internal_non_workflow_1.decodeOptionalSingle)(this.codecs, job.resolveNexusOperation.result.completed, this.workflowContext)
                                        : null,
                                    failed: job.resolveNexusOperation.result?.failed
                                        ? await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveNexusOperation.result.failed, this.workflowContext)
                                        : null,
                                    cancelled: job.resolveNexusOperation.result?.cancelled
                                        ? await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveNexusOperation.result.cancelled, this.workflowContext)
                                        : null,
                                    timedOut: job.resolveNexusOperation.result?.timedOut
                                        ? await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveNexusOperation.result.timedOut, this.workflowContext)
                                        : null,
                                },
                            }
                            : null,
                        resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                            ? {
                                ...job.resolveSignalExternalWorkflow,
                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveSignalExternalWorkflow.failure, resolveSignalContext),
                            }
                            : null,
                        resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                            ? {
                                ...job.resolveRequestCancelExternalWorkflow,
                                failure: await (0, internal_non_workflow_1.decodeOptionalFailure)(this.codecs, job.resolveRequestCancelExternalWorkflow.failure, resolveCancelContext),
                            }
                            : null,
                    };
                }))
                : null,
        });
    }
    /**
     * Run codec.encode on the Payloads inside the Completion message.
     */
    async encodeCompletion(completion) {
        const encodedCompletion = {
            ...completion,
            failed: completion.failed
                ? {
                    ...completion.failed,
                    failure: await (0, internal_non_workflow_1.encodeOptionalFailure)(this.codecs, completion.failed.failure, this.workflowContext),
                }
                : null,
            successful: completion.successful
                ? {
                    ...completion.successful,
                    commands: completion.successful.commands
                        ? await Promise.all(completion.successful.commands.map(async (command) => {
                            let userMetadataContext = this.workflowContext;
                            const scheduleActivityContext = command.scheduleActivity
                                ? this.activityContext(command.scheduleActivity, false)
                                : undefined;
                            if (command.scheduleActivity?.seq != null && scheduleActivityContext) {
                                this.pendingCompletionContexts.activity.set(command.scheduleActivity.seq, scheduleActivityContext);
                                userMetadataContext = scheduleActivityContext;
                            }
                            const scheduleLocalActivityContext = command.scheduleLocalActivity
                                ? this.activityContext(command.scheduleLocalActivity, true)
                                : undefined;
                            if (command.scheduleLocalActivity?.seq != null && scheduleLocalActivityContext) {
                                this.pendingCompletionContexts.activity.set(command.scheduleLocalActivity.seq, scheduleLocalActivityContext);
                                userMetadataContext = scheduleLocalActivityContext;
                            }
                            const childWorkflowContext = command.startChildWorkflowExecution
                                ? this.childWorkflowContext(command.startChildWorkflowExecution)
                                : undefined;
                            if (command.startChildWorkflowExecution?.seq != null && childWorkflowContext) {
                                this.pendingCompletionContexts.childWorkflowStart.set(command.startChildWorkflowExecution.seq, childWorkflowContext);
                                this.pendingCompletionContexts.childWorkflowComplete.set(command.startChildWorkflowExecution.seq, childWorkflowContext);
                                userMetadataContext = childWorkflowContext;
                            }
                            const signalWorkflowContext = command.signalExternalWorkflowExecution
                                ? this.externalWorkflowContext(command.signalExternalWorkflowExecution)
                                : undefined;
                            if (command.signalExternalWorkflowExecution?.seq != null && signalWorkflowContext) {
                                this.pendingCompletionContexts.signalWorkflow.set(command.signalExternalWorkflowExecution.seq, signalWorkflowContext);
                            }
                            const cancelWorkflowContext = command.requestCancelExternalWorkflowExecution
                                ? this.externalWorkflowContext(command.requestCancelExternalWorkflowExecution)
                                : undefined;
                            if (command.requestCancelExternalWorkflowExecution?.seq != null && cancelWorkflowContext) {
                                this.pendingCompletionContexts.cancelWorkflow.set(command.requestCancelExternalWorkflowExecution.seq, cancelWorkflowContext);
                            }
                            return {
                                ...command,
                                scheduleActivity: command.scheduleActivity
                                    ? {
                                        ...command.scheduleActivity,
                                        arguments: await (0, internal_non_workflow_1.encodeOptional)(this.codecs, command.scheduleActivity.arguments, scheduleActivityContext),
                                        headers: (0, internal_non_workflow_1.noopEncodeMap)(command.scheduleActivity.headers),
                                    }
                                    : undefined,
                                upsertWorkflowSearchAttributes: command.upsertWorkflowSearchAttributes
                                    ? {
                                        ...command.upsertWorkflowSearchAttributes,
                                        searchAttributes: (0, internal_non_workflow_1.noopEncodeSearchAttrs)(command.upsertWorkflowSearchAttributes.searchAttributes),
                                    }
                                    : undefined,
                                respondToQuery: command.respondToQuery
                                    ? {
                                        ...command.respondToQuery,
                                        succeeded: {
                                            ...command.respondToQuery.succeeded,
                                            response: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, command.respondToQuery.succeeded?.response, this.workflowContext),
                                        },
                                        failed: await (0, internal_non_workflow_1.encodeOptionalFailure)(this.codecs, command.respondToQuery.failed, this.workflowContext),
                                    }
                                    : undefined,
                                updateResponse: command.updateResponse
                                    ? {
                                        ...command.updateResponse,
                                        rejected: await (0, internal_non_workflow_1.encodeOptionalFailure)(this.codecs, command.updateResponse.rejected, this.workflowContext),
                                        completed: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, command.updateResponse.completed, this.workflowContext),
                                    }
                                    : undefined,
                                completeWorkflowExecution: command.completeWorkflowExecution
                                    ? {
                                        ...command.completeWorkflowExecution,
                                        result: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, command.completeWorkflowExecution.result, this.workflowContext),
                                    }
                                    : undefined,
                                failWorkflowExecution: command.failWorkflowExecution
                                    ? {
                                        ...command.failWorkflowExecution,
                                        failure: await (0, internal_non_workflow_1.encodeOptionalFailure)(this.codecs, command.failWorkflowExecution.failure, this.workflowContext),
                                    }
                                    : undefined,
                                continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                                    ? {
                                        ...command.continueAsNewWorkflowExecution,
                                        arguments: await (0, internal_non_workflow_1.encodeOptional)(this.codecs, command.continueAsNewWorkflowExecution.arguments, this.workflowContext),
                                        memo: await (0, internal_non_workflow_1.encodeMap)(this.codecs, command.continueAsNewWorkflowExecution.memo, this.workflowContext),
                                        headers: (0, internal_non_workflow_1.noopEncodeMap)(command.continueAsNewWorkflowExecution.headers),
                                        searchAttributes: (0, internal_non_workflow_1.noopEncodeSearchAttrs)(command.continueAsNewWorkflowExecution.searchAttributes),
                                    }
                                    : undefined,
                                startChildWorkflowExecution: command.startChildWorkflowExecution
                                    ? {
                                        ...command.startChildWorkflowExecution,
                                        input: await (0, internal_non_workflow_1.encodeOptional)(this.codecs, command.startChildWorkflowExecution.input, childWorkflowContext),
                                        memo: await (0, internal_non_workflow_1.encodeMap)(this.codecs, command.startChildWorkflowExecution.memo, childWorkflowContext),
                                        headers: (0, internal_non_workflow_1.noopEncodeMap)(command.startChildWorkflowExecution.headers),
                                        searchAttributes: (0, internal_non_workflow_1.noopEncodeSearchAttrs)(command.startChildWorkflowExecution.searchAttributes),
                                    }
                                    : undefined,
                                signalExternalWorkflowExecution: command.signalExternalWorkflowExecution
                                    ? {
                                        ...command.signalExternalWorkflowExecution,
                                        args: await (0, internal_non_workflow_1.encodeOptional)(this.codecs, command.signalExternalWorkflowExecution.args, signalWorkflowContext),
                                        headers: (0, internal_non_workflow_1.noopEncodeMap)(command.signalExternalWorkflowExecution.headers),
                                    }
                                    : undefined,
                                scheduleLocalActivity: command.scheduleLocalActivity
                                    ? {
                                        ...command.scheduleLocalActivity,
                                        arguments: await (0, internal_non_workflow_1.encodeOptional)(this.codecs, command.scheduleLocalActivity.arguments, scheduleLocalActivityContext),
                                        headers: (0, internal_non_workflow_1.noopEncodeMap)(command.scheduleLocalActivity.headers),
                                    }
                                    : undefined,
                                scheduleNexusOperation: command.scheduleNexusOperation
                                    ? {
                                        ...command.scheduleNexusOperation,
                                        input: await (0, internal_non_workflow_1.encodeOptionalSingle)(this.codecs, command.scheduleNexusOperation.input, this.workflowContext),
                                    }
                                    : undefined,
                                modifyWorkflowProperties: command.modifyWorkflowProperties
                                    ? {
                                        ...command.modifyWorkflowProperties,
                                        upsertedMemo: {
                                            ...command.modifyWorkflowProperties.upsertedMemo,
                                            fields: await (0, internal_non_workflow_1.encodeMap)(this.codecs, command.modifyWorkflowProperties.upsertedMemo?.fields, this.workflowContext),
                                        },
                                    }
                                    : undefined,
                                userMetadata: await this.encodeUserMetadata(userMetadataContext, command.userMetadata),
                            };
                        }))
                        : null,
                }
                : null,
        };
        return proto_1.coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(encodedCompletion).finish();
    }
}
exports.WorkflowCodecRunner = WorkflowCodecRunner;
//# sourceMappingURL=workflow-codec-runner.js.map