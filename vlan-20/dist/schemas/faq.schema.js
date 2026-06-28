// src/schemas/faq.schema.ts
//
// Validates the plain JS object @grpc/grpc-js hands the server handler —
// proto-loader enforces wire-level field types, but it does NOT enforce
// "query is non-empty," "language is a real code we support," or generate
// a missing interaction_id. That's this schema's job, and it's a real job,
// not a formality: the old node tolerated a missing contract_id by falling
// back to a second field. This schema reproduces that same tolerance, just
// correctly, with an explicit generated default instead of an untyped `||`.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
const SUPPORTED_LANGUAGES = ['uz', 'ru', 'en'];
const DEFAULT_LANGUAGE = 'uz';
const QUERY_MAX_LENGTH = 2000;
export const FAQRequestSchema = z
    .object({
    interactionId: z
        .string()
        .trim()
        // Proto3 default for missing strings is an empty string (""), not undefined.
        // We must intercept the empty string and generate the UUID here, avoiding
        // .min(1) which would falsely reject a perfectly normal fresh request.
        .transform((value) => value === '' ? randomUUID() : value),
    tenantId: z.string().trim().min(1, 'tenantId is required.'),
    customerId: z.string().trim().min(1, 'customerId is required.'),
    query: z
        .string()
        .trim()
        .min(1, 'query must not be empty.')
        .max(QUERY_MAX_LENGTH, `query exceeds the ${QUERY_MAX_LENGTH}-character limit.`),
    language: z
        .string()
        .trim()
        .toLowerCase()
        .optional()
        .transform((value) => {
        if (value && SUPPORTED_LANGUAGES.includes(value)) {
            return value;
        }
        // An unrecognized or absent language code degrades to the default
        // rather than rejecting the request outright — language is
        // advisory context for AI Cognition, not a field worth failing a
        // customer's FAQ query over.
        return DEFAULT_LANGUAGE;
    }),
})
    .strict();
/**
 * Renders a ZodError into the flat, loggable structure server.ts attaches
 * to a grpc.status.INVALID_ARGUMENT response — kept as a named, reusable
 * function rather than inlined at the one call site, since "how we explain
 * a validation failure" is exactly the kind of detail worth being
 * consistent about if a second RPC method is ever added to this service.
 */
export function formatValidationIssues(error) {
    return error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
}
//# sourceMappingURL=faq.schema.js.map