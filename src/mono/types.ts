export type AffordabilityStatus =
  | "awaiting_link"  // customer hasn't linked their bank account yet
  | "linked"         // account linked, Mono is still fetching its data
  | "data_ready"     // data available, ready to assess
  | "assessing"      // creditworthiness requested, waiting for Mono's webhook
  | "passed"         // Mono says the customer can afford the plan
  | "failed"         // Mono says they can't, or linking/data failed
  | "inconclusive"   // not enough account history to decide
  | "consumed";      // already used to create a plan

export interface AffordabilityCheck {
  id: string;
  customerId: string;
  status: AffordabilityStatus;
  /** Amount assessed, in kobo (Mono's unit). */
  principalKobo: number;
  /** Months the plan runs over. */
  termMonths: number;
  /** Monthly interest rate sent to Mono. */
  interestRate: number;
  accountId?: string;
  linkUrl?: string;
  /** Monthly payment Mono assessed, in kobo. */
  monthlyPaymentKobo?: number;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AffordabilityStore {
  save(check: AffordabilityCheck): Promise<void>;
  get(id: string): Promise<AffordabilityCheck | null>;
  getByAccountId(accountId: string): Promise<AffordabilityCheck | null>;
  update(id: string, patch: Partial<AffordabilityCheck>): Promise<void>;
}

export interface MonoClientConfig {
  secretKey: string;
  baseUrl?: string;
}

/** Shape of the webhooks Mono sends (docs.mono.co/docs/quickstart). */
export interface MonoWebhook {
  event: string;
  data: any;
}
