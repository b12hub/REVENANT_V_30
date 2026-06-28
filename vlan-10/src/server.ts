import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { Client as TemporalClient, WorkflowIdReusePolicy } from '@temporalio/client';
import { v4 as uuidv4 } from 'uuid';
import { P2PTransferRequestSchema } from './schemas/p2p.schema';
import type {  P2PTransferWorkflowInput } from './types';

// Load the protobuf definition
const PROTO_PATH = path.resolve(__dirname, '../proto/p2p.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as any;
const P2PService = proto.uzbekistan.bank.revenant.p2p.v1.P2PService;

/**
 * Creates and starts the gRPC server. The server listens on the given port
 * and uses the provided Temporal client to dispatch workflows.
 */
export function startGrpcServer(temporalClient: TemporalClient, port: number = 50051): void {
  const server = new grpc.Server();

  server.addService(P2PService.service, {
    async InitiateTransfer(
      call: grpc.ServerUnaryCall<typeof P2PService.InitiateTransferRequest__type,
                                typeof P2PService.InitiateTransferResponse__type>,
      callback: grpc.sendUnaryData<typeof P2PService.InitiateTransferResponse__type>
    ) {
      try {
        const rawRequest = call.request;

        // --- Step 1: Validate with Zod ---
        // Align input properties to match the schema's internal structural expectations
        const parsed = P2PTransferRequestSchema.safeParse({
          phone: rawRequest.target_phone,
          amountUzs: rawRequest.amount_uzs,
          rawRecipientText: rawRequest.target_phone,
        });

        if (!parsed.success) {
          const errors = parsed.error.issues.map((e: any) => e.message).join(', ');
          callback({
            code: grpc.status.INVALID_ARGUMENT,
            message: `Validation failed: ${errors}`,
          });
          return;
        }

        // --- Step 2: Use Idempotency Key from rawRequest as the Workflow ID ---
        const workflowId = rawRequest.idempotency_key;
        const traceId = uuidv4();

        // --- Step 3: Align parameters cleanly with P2PTransferWorkflowInput ---
        const workflowInput: P2PTransferWorkflowInput = {
          phone: parsed.data.phone,
          customerId: rawRequest.sender_email,
          amountUzs: parsed.data.amountUzs,
          idempotencyKey: rawRequest.idempotency_key,
          traceId: traceId,
          tenantId: 'mikrokredit-default-vlan10',
          rawRecipientText: parsed.data.rawRecipientText,
        };

        // --- Step 4: Start the Temporal workflow (non‑blocking execution) ---
        await temporalClient.workflow.start('P2PTransferWorkflow', {
          workflowId: workflowId,
          taskQueue: 'p2p-transfer-queue',
          args: [workflowInput],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });

        // --- Step 5: Return immediately to the API Gateway ---
        callback(null, {
          transfer_id: workflowId,
          status: 'PENDING_CONFIRMATION',
          created_at: new Date().toISOString(),
          customer_message: 'Iltimos, tasdiqlash uchun Telegram tugmasini bosing.',
        });
      } catch (err) {
        console.error('InitiateTransfer failure:', err);

        const errorMessage = err instanceof Error ? err.message : 'Unknown execution error';
        const isDuplicate = err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError';

        if (isDuplicate) {
          callback({
            code: grpc.status.ALREADY_EXISTS,
            message: 'This transaction identity is already active or spent.'
          });
        } else {
          callback({
            code: grpc.status.INTERNAL,
            message: `Internal tracking engine error: ${errorMessage}`
          });
        }
      }
    },
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        console.error('Failed to bind gRPC server:', err);
        return;
      }
      console.log(`gRPC server listening on port ${boundPort}`);
      server.start();
    }
  );
}