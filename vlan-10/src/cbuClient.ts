import axios, { AxiosInstance } from 'axios';
import type { CbuClient, CbuAccountResolution } from './types';

class CbuError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'CbuError';
  }
}

/**
 * Concrete implementation of the Central Bank of Uzbekistan (CBU) Open API client.
 * Simulates HTTP calls for development; in production points to the CBU lookup endpoint.
 */
export class HttpCbuClient implements CbuClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string = 'https://api.cbu.uz/v1') {
    this.http = axios.create({
      baseURL,
      timeout: 5_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': 'revenant-p2p',
      },
    });
  }

  /**
   * Look up a beneficiary by phone number.
   * If the phone is not registered with any bank, throws a non-retryable error
   * so the Temporal Activity will fail immediately without retries.
   */
  async resolvePhoneToAccount(phone: string): Promise<CbuAccountResolution> {
    // --- Simulate CBU Open API call ---
    // In production, replace with: this.http.get(`/kyc/phone/${encodeURIComponent(phone)}`)
    // For now, we return deterministic data based on the phone’s last digit.

    const lastDigit = parseInt(phone.slice(-1), 10);
    if (lastDigit === 0) {
      // Simulate phone not found in CBU registry.
      throw new CbuError(`Phone ${phone} is not registered with any bank`, 'PHONE_NOT_REGISTERED');
    }

    // Mock successful lookup strictly matching CbuAccountResolution interface
    const resolution: CbuAccountResolution = {
      accountHolderName: 'Murodjon Karimov',
      maskedAccountNumber: '8600 **** **** 1234',
      providerReference: 'cbu-ref-987654321',
    };
    return resolution;
  }
}