import type { KoraClientConfig } from "./types.js";

export class KoraClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: KoraClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.korapay.com";
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kora API error (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /** Initiates a direct debit mandate authorization for a customer. */
  async createMandate(params: { customerEmail: string; customerReference: string }) {
    return this.request<{ data: { mandate_reference: string; authorization_url: string } }>(
      "/v1/direct-debit/mandates",
      "POST",
      params
    );
  }

  /** Charges an already-authorized mandate for a specific installment amount. */
  async chargeMandate(params: { mandateReference: string; amount: number; reference: string }) {
    return this.request<{ data: { status: string; reference: string } }>(
      "/v1/direct-debit/charge",
      "POST",
      params
    );
  }

  /** Verifies the final status of a charge — always call this rather than trusting webhooks alone. */
  async verifyCharge(reference: string) {
    return this.request<{ data: { status: string; amount: number; reference: string } }>(
      `/v1/charges/verify/${reference}`,
      "GET"
    );
  }
}
