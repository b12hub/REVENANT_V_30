import type { PayloadCodec, WorkflowSerializationContext } from '@temporalio/common';
import type { Decoded } from '@temporalio/common/lib/internal-non-workflow';
import { coresdk } from '@temporalio/proto';
/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export declare class WorkflowCodecRunner {
    private readonly codecs;
    private readonly workflowContext;
    private readonly pendingCompletionContexts;
    constructor(codecs: PayloadCodec[], workflowContext: WorkflowSerializationContext);
    private consumeContext;
    private activityContext;
    private childWorkflowContext;
    private externalWorkflowContext;
    private encodeUserMetadata;
    /**
     * Run codec.decode on the Payloads in the Activation message.
     */
    decodeActivation<T extends coresdk.workflow_activation.IWorkflowActivation>(activation: T): Promise<Decoded<T>>;
    /**
     * Run codec.encode on the Payloads inside the Completion message.
     */
    encodeCompletion(completion: coresdk.workflow_completion.IWorkflowActivationCompletion): Promise<Uint8Array>;
}
