/**
 * Serializable token identifying a Nexus operation target.
 *
 * @internal
 * @hidden
 */
export interface OperationToken {
    /**
     * Version of the token, by default we assume we're on version 0, this field is not emitted as part of the output,
     * it's only used to reject newer token versions on load.
     */
    v?: number;
    /**
     * Type of the Operation.
     */
    t: OperationTokenType;
    /**
     * Namespace of the operation.
     */
    ns: string;
    /**
     * ID of the workflow.
     */
    wid?: string;
}
/**
 * An OperationToken that identifies a WorkflowRun operation.
 *
 * @internal
 * @hidden
 */
export interface WorkflowRunOperationToken extends OperationToken {
    t: typeof OperationTokenType.WORKFLOW_RUN;
    wid: string;
}
/**
 * OperationTokenType is used to identify the type of Operation token.
 * Currently, we only have one type of Operation token: WorkflowRun.
 *
 * @internal
 * @hidden
 */
export type OperationTokenType = (typeof OperationTokenType)[keyof typeof OperationTokenType];
/**
 * @internal
 * @hidden
 */
export declare const OperationTokenType: {
    readonly WORKFLOW_RUN: 1;
};
/**
 * Generate a workflow run Operation token.
 */
export declare function generateWorkflowRunOperationToken(namespace: string, workflowId: string): string;
/**
 * Load and validate the common fields of an Operation token.
 */
export declare function loadOperationToken(data: string): OperationToken;
/**
 * Load and validate a workflow run Operation token.
 */
export declare function loadWorkflowRunOperationToken(data: string): WorkflowRunOperationToken;
/**
 * Assert that an OperationToken identifies a workflow run.
 */
export declare function assertWorkflowRunOperationToken(token: OperationToken): asserts token is WorkflowRunOperationToken;
export declare function base64URLEncodeNoPadding(str: string): string;
