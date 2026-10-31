import type { MonoClientConfig } from "./types.js";

/** Thin wrapper over Mono Connect (docs.mono.co). Auth is the `mono-sec-key` header. */
export class MonoClient {
  private secretKey: string;
  private baseUrl: string;

  constructor(config: MonoClientConfig) {
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl ?? "https://api.withmono.com/v2";
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "mono-sec-key": this.secretKey, "Content-Type": "application/json", accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Mono API error (${res.status}): ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** Starts account linking. The customer opens `data.mono_url` and links their bank account. */
  initiateLinking(params: { customer: { name: string; email: string }; ref: string; redirectUrl: string }) {
    return this.request<{ data: { mono_url: string } }>("/accounts/initiate", "POST", {
      customer: params.customer,
      meta: { ref: params.ref },
      scope: "auth",
      redirect_url: params.redirectUrl,
    });
  }

  /** Asks Mono to assess affordability. The result arrives later as a webhook. Amounts are in kobo. */
  requestCreditworthiness(
    accountId: string,
    params: { bvn: string; principal: number; interest_rate: number; term: number; run_credit_check: boolean }
  ) {
    return this.request<{ status: string; message: string }>(`/accounts/${accountId}/creditworthiness`, "POST", params);
  }
}
