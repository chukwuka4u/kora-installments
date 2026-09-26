import type { AuthorizationData, ChargeQueryData, CreateAuthorizationParams, DebitAuthorizationParams, DebitData, KoraClientConfig, KoraResponse, RetrieveAuthorizationData } from "./types.js";

export class KoraClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: KoraClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.korapay.com/merchant/api/v1";
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
  async createAuthorization(params: CreateAuthorizationParams) {
    return this.request<KoraResponse<AuthorizationData>>(
      "/merchant/api/v1/direct-debit/initiate",
      "POST",
      params
    );
  }

  /** Confirms the current status of an authorization (pending/active/suspended/deactivated/expired). */
  async retrieveAuthorization(reference: string) {
    return this.request<KoraResponse<RetrieveAuthorizationData>>(
      `/merchant/api/v1/direct-debit/authorizations/${reference}`,
      "GET"
    );
  }

  /** Triggers a single debit against an already-active variable authorization. */
  async debitAuthorization(authorizationCode: string, params: DebitAuthorizationParams) {
    return this.request<KoraResponse<DebitData>>(
      `/merchant/api/v1/direct-debit/authorizations/${authorizationCode}/debits`,
      "POST",
      params
    );
  }

  /** Verifies the final status of any charge, including direct debit debits, by your own reference. */
  async verifyCharge(reference: string) {
    return this.request<KoraResponse<ChargeQueryData>>(`/merchant/api/v1/charges/${reference}`, "GET");
  }
}
