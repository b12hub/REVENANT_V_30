import { z } from 'zod';
export declare const FAQRequestSchema: z.ZodObject<{
    interactionId: z.ZodEffects<z.ZodString, string, string>;
    tenantId: z.ZodString;
    customerId: z.ZodString;
    query: z.ZodString;
    language: z.ZodEffects<z.ZodOptional<z.ZodString>, "uz" | "ru" | "en", string | undefined>;
}, "strict", z.ZodTypeAny, {
    interactionId: string;
    tenantId: string;
    customerId: string;
    query: string;
    language: "uz" | "ru" | "en";
}, {
    interactionId: string;
    tenantId: string;
    customerId: string;
    query: string;
    language?: string | undefined;
}>;
export type ValidatedFAQRequest = z.infer<typeof FAQRequestSchema>;
/**
 * Renders a ZodError into the flat, loggable structure server.ts attaches
 * to a grpc.status.INVALID_ARGUMENT response — kept as a named, reusable
 * function rather than inlined at the one call site, since "how we explain
 * a validation failure" is exactly the kind of detail worth being
 * consistent about if a second RPC method is ever added to this service.
 */
export declare function formatValidationIssues(error: z.ZodError): string;
