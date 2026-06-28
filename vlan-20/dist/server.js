// src/server.ts
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { FAQRequestSchema, formatValidationIssues } from './schemas/faq.schema.js';
import { AICognitionClient } from './aiCognitionClient.js';
import { assertUnreachable } from './types.js';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, '../proto/faq.proto');
const PORT = process.env.PORT ?? '50051';
const AI_COGNITION_ADDRESS = process.env.AI_COGNITION_GRPC_ADDR;
const AI_COGNITION_TLS_ENABLED = process.env.AI_COGNITION_TLS_ENABLED !== 'false';
if (!AI_COGNITION_ADDRESS) {
    // Fail at boot, not on first request — same philosophy applied
    // consistently across every service in this build so far.
    throw new Error('AI_COGNITION_GRPC_ADDR is required and was not set.');
}
function logInfo(fields) {
    console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), ...fields }));
}
function logWarn(fields) {
    console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), ...fields }));
}
function logError(fields) {
    console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), ...fields }));
}
const aiCognitionClient = new AICognitionClient(AI_COGNITION_ADDRESS, AI_COGNITION_TLS_ENABLED);
/**
 * Resolves a fallback answer string. This is the direct, faithful
 * successor to the old node's `advisory.draft_customer_response ||
 * message_to_user` chain — preserved as a named function specifically so
 * the provenance comment travels with the logic, not just in this file's
 * header.
 */
function buildFallbackAnswer(language) {
    const fallbackByLanguage = {
        uz: "Hozircha javob topa olmadik. Iltimos, birozdan keyin qaytadan urinib ko'ring.",
        ru: 'Не удалось найти ответ. Пожалуйста, попробуйте снова через некоторое время.',
        en: 'We were unable to find an answer right now. Please try again shortly.',
    };
    return fallbackByLanguage[language] ?? fallbackByLanguage['en'] ?? '';
}
function buildGetFAQAnswerHandler() {
    return function getFAQAnswer(call, callback) {
        const parseResult = FAQRequestSchema.safeParse({
            interactionId: call.request['interaction_id'],
            tenantId: call.request['tenant_id'],
            customerId: call.request['customer_id'],
            query: call.request['query'],
            language: call.request['language'],
        });
        if (!parseResult.success) {
            // Explicit requirement: validation failures map to INVALID_ARGUMENT,
            // not a generic INTERNAL or a malformed/empty FAQResponse.
            callback({
                name: 'ValidationError',
                message: formatValidationIssues(parseResult.error),
                code: grpc.status.INVALID_ARGUMENT,
                details: formatValidationIssues(parseResult.error),
                metadata: new grpc.Metadata(),
            });
            return;
        }
        const validated = parseResult.data;
        logInfo({
            interactionId: validated.interactionId,
            event: 'faq_request_received',
            tenantId: validated.tenantId,
            language: validated.language,
        });
        aiCognitionClient
            .generateAdvisory({
            traceId: validated.interactionId,
            tenantId: validated.tenantId,
            customerId: validated.customerId,
            query: validated.query,
            language: validated.language,
        })
            .then((result) => {
            let response;
            switch (result.outcome) {
                case 'SUCCESS': {
                    const hasUsableAnswer = result.answer.trim().length > 0;
                    response = {
                        interactionId: validated.interactionId,
                        answer: hasUsableAnswer ? result.answer : buildFallbackAnswer(validated.language),
                        status: hasUsableAnswer ? 'FAQ_STATUS_ANSWERED' : 'FAQ_STATUS_NO_ANSWER_FOUND',
                        route: result.route,
                    };
                    logInfo({
                        interactionId: validated.interactionId,
                        event: 'faq_request_completed',
                        status: response.status,
                        confidence: result.confidence,
                    });
                    break;
                }
                case 'TIMEOUT': {
                    // Graceful degradation, not a propagated transport error — see
                    // the conversational note above this codeblock for why. The
                    // Gateway's own per-VLAN deadline for VLAN 20 is the layer that
                    // decides whether ITS caller sees an error; this service's job
                    // is to never hand a blank or broken response to a customer
                    // just because one upstream dependency was momentarily slow.
                    response = {
                        interactionId: validated.interactionId,
                        answer: buildFallbackAnswer(validated.language),
                        status: 'FAQ_STATUS_DEGRADED_FALLBACK',
                        route: 'UNAVAILABLE',
                    };
                    logWarn({
                        interactionId: validated.interactionId,
                        event: 'ai_cognition_deadline_exceeded',
                    });
                    break;
                }
                case 'UNAVAILABLE': {
                    response = {
                        interactionId: validated.interactionId,
                        answer: buildFallbackAnswer(validated.language),
                        status: 'FAQ_STATUS_DEGRADED_FALLBACK',
                        route: 'UNAVAILABLE',
                    };
                    logWarn({
                        interactionId: validated.interactionId,
                        event: 'ai_cognition_unavailable',
                        detail: result.detail,
                    });
                    break;
                }
                default:
                    return assertUnreachable(result);
            }
            callback(null, {
                interaction_id: response.interactionId,
                answer: response.answer,
                status: response.status,
                route: response.route,
            });
        })
            .catch((err) => {
            // Reaching here means something genuinely unexpected happened —
            // not an anticipated AI Cognition failure mode (those are handled
            // above without ever rejecting this promise), but a real bug.
            // THIS is the case that gets a real transport-level error back to
            // the Gateway, mapped explicitly rather than left to whatever
            // default @grpc/grpc-js would otherwise produce.
            const message = err instanceof Error ? err.message : 'Unknown internal error.';
            logError({
                interactionId: validated.interactionId,
                event: 'unexpected_internal_error',
                error: message,
            });
            callback({
                name: 'InternalError',
                message,
                code: grpc.status.INTERNAL,
                details: message,
                metadata: new grpc.Metadata(),
            });
        });
    };
}
function buildServer() {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition);
    const server = new grpc.Server();
    server.addService(loaded.revenant.faq.v1.FAQService.service, {
        GetFAQAnswer: buildGetFAQAnswerHandler(),
    });
    return server;
}
function main() {
    const server = buildServer();
    server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
            logError({ interactionId: 'STARTUP', event: 'bind_failed', error: err.message });
            process.exit(1);
            return;
        }
        logInfo({ interactionId: 'STARTUP', event: 'server_listening', port: boundPort });
    });
    let shuttingDown = false;
    const SHUTDOWN_TIMEOUT_MS = 10_000;
    function shutdown(signal) {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logInfo({ interactionId: 'SHUTDOWN', event: 'signal_received', signal });
        const forceExitTimer = setTimeout(() => {
            logError({ interactionId: 'SHUTDOWN', event: 'graceful_drain_timeout_forcing_exit' });
            server.forceShutdown();
            aiCognitionClient.close();
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        server.tryShutdown((err) => {
            clearTimeout(forceExitTimer);
            if (err) {
                logError({ interactionId: 'SHUTDOWN', event: 'graceful_drain_error', error: err.message });
            }
            else {
                logInfo({ interactionId: 'SHUTDOWN', event: 'graceful_drain_complete' });
            }
            aiCognitionClient.close();
            process.exit(err ? 1 : 0);
        });
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
main();
//# sourceMappingURL=server.js.map