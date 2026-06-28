import type { GenerateAdvisoryRequestModel, GenerateAdvisoryResult } from './types.js';
export declare class AICognitionClient {
    private readonly client;
    constructor(address: string, tlsEnabled: boolean);
    generateAdvisory(request: GenerateAdvisoryRequestModel): Promise<GenerateAdvisoryResult>;
    close(): void;
}
