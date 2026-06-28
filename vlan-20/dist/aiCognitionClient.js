// src/aiCognitionClient.ts
//
// Deliberately NOT retrying internally. A 5000ms absolute deadline with a
// retry loop inside it would mean each retry attempt gets a shrinking,
// unpredictable slice of whatever time is left — worse latency
// predictability than just trying once and failing fast. If retry is ever
// wanted, it belongs at the GATEWAY's layer, which already owns per-VLAN
// timeout/circuit-breaker policy for exactly this reason.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, '../proto/ai-cognition.proto');
const ABSOLUTE_DEADLINE_MS = 5000;
function loadAICognitionClientConstructor() {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        // keepCase: true ensures proto-loader does not silently mutate our snake_case
        // proto definitions into camelCase. This guarantees the snake_case request
        // object constructed below maps perfectly to the generated protobuf serialization.
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition);
    return loaded.revenant.aicognition.v1.AICognitionService;
}
export class AICognitionClient {
    client;
    constructor(address, tlsEnabled) {
        const ClientConstructor = loadAICognitionClientConstructor();
        const credentials = tlsEnabled ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
        this.client = new ClientConstructor(address, credentials);
    }
    async generateAdvisory(request) {
        return new Promise((resolve) => {
            const metadata = new grpc.Metadata();
            metadata.set('trace-id', request.traceId);
            metadata.set('tenant-id', request.tenantId);
            this.client.GenerateAdvisory({
                trace_id: request.traceId,
                tenant_id: request.tenantId,
                customer_id: request.customerId,
                query: request.query,
                language: request.language,
            }, metadata, 
            // The absolute-deadline guarantee the task requires: Date.now() +
            // 5000, not a relative timeout option. A relative timeout measures
            // from when the gRPC library happens to start its internal clock;
            // an absolute deadline is anchored to wall-clock time at the
            // moment THIS call was made, which is the actual guarantee "the
            // thread pool never hangs past 5 seconds" requires.
            { deadline: Date.now() + ABSOLUTE_DEADLINE_MS }, (error, response) => {
                if (error) {
                    if (error.code === grpc.status.DEADLINE_EXCEEDED) {
                        resolve({ outcome: 'TIMEOUT' });
                        return;
                    }
                    if (error.code === grpc.status.UNAVAILABLE) {
                        resolve({ outcome: 'UNAVAILABLE', detail: error.message });
                        return;
                    }
                    // Any other gRPC failure from AI Cognition is still an
                    // "unavailable for this purpose" outcome from THIS client's
                    // point of view — server.ts only needs to know whether it got
                    // a usable answer, not the full taxonomy of why it didn't.
                    resolve({ outcome: 'UNAVAILABLE', detail: `${error.code}: ${error.message}` });
                    return;
                }
                if (!response) {
                    resolve({ outcome: 'UNAVAILABLE', detail: 'Empty response with no error.' });
                    return;
                }
                resolve({
                    outcome: 'SUCCESS',
                    answer: response.answer,
                    route: response.route,
                    confidence: response.confidence,
                });
            });
        });
    }
    close() {
        this.client.close();
    }
}
//# sourceMappingURL=aiCognitionClient.js.map