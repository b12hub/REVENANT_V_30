/** Mirrors FAQStatus in proto/faq.proto exactly as serialized by proto-loader */
export type FAQStatus = 'FAQ_STATUS_ANSWERED' | 'FAQ_STATUS_NO_ANSWER_FOUND' | 'FAQ_STATUS_DEGRADED_FALLBACK';
export interface FAQRequestModel {
    readonly interactionId: string;
    readonly tenantId: string;
    readonly customerId: string;
    readonly query: string;
    readonly language: string;
}
export interface FAQResponseModel {
    readonly interactionId: string;
    readonly answer: string;
    readonly status: FAQStatus;
    readonly route: string;
}
export interface GenerateAdvisoryRequestModel {
    readonly traceId: string;
    readonly tenantId: string;
    readonly customerId: string;
    readonly query: string;
    readonly language: string;
}
export interface GenerateAdvisorySuccess {
    readonly outcome: 'SUCCESS';
    readonly answer: string;
    readonly route: string;
    readonly confidence: number;
}
export interface GenerateAdvisoryTimeout {
    readonly outcome: 'TIMEOUT';
}
export interface GenerateAdvisoryUnavailable {
    readonly outcome: 'UNAVAILABLE';
    readonly detail: string;
}
/**
 * Discriminated union, not a thrown exception, for the two anticipated
 * failure modes. Forcing the caller (server.ts) to switch on `.outcome`
 * means a missing-handling case is a compile error, not a runtime surprise.
 */
export type GenerateAdvisoryResult = GenerateAdvisorySuccess | GenerateAdvisoryTimeout | GenerateAdvisoryUnavailable;
export declare function assertUnreachable(value: never): never;
