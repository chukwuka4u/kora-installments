// ---- Domain types (this package's own model — not Kora's) ----

export type InstallmentStatus = "pending" | "due" | "paid" | "failed";

export type PlanStatus = "awaiting_authorization" | "active" | "completed" | "cancelled";

export interface Installment {
  /** Unique reference sent to Kora for this specific debit. Used for idempotency. */
  reference: string;
  planId: string;
  sequence: number;
  amount: number;
  dueDate: string; // ISO date
  status: InstallmentStatus;
  chargedAt?: string;
}

export interface InstallmentPlanRecord {
  id: string;
  customerId: string;
  totalAmount: number;
  currency: string;
  /** Kora's "reference" for the authorization (from the create-authorization response). */
  authorizationReference?: string;
  /** Kora's "authorization_code" — required to trigger debits. Distinct from authorizationReference. */
  authorizationCode?: string;
  status: PlanStatus;
  createdAt: string;
}

export interface CreatePlanInput {
  customerId: string;
  /** Kora requires these exact fields to create the direct debit authorization. */
  customer: KoraCustomer;
  totalAmount: number;
  currency: "NGN";
  numberOfInstallments: number;
  /** Days between each installment. Defaults to 30. */
  intervalDays?: number;
  /** If true, the first installment is charged immediately rather than scheduled. */
  chargeFirstImmediately?: boolean;
  /** Days of buffer added after the final installment's due date when setting the authorization's end_date. Defaults to 7. */
  authorizationEndBufferDays?: number;
  /** Shown to the customer as the authorization description. Defaults to a generic message. */
  description?: string;
}

export interface KoraClientConfig {
  apiKey: string;
  baseUrl?: string;
}

// ---- Kora API types (mirrors developers.korapay.com/docs/creating-an-authorization etc.) ----

export type DebitType = "variable" | "fixed";

export type AuthorizationStatus = "pending" | "active" | "suspended" | "deactivated" | "expired";

export type DebitStatus = "pending" | "processing" | "success" | "failed";

export type KoraFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "bimonthly"
  | "quarterly"
  | "semi_annually"
  | "yearly"
  | "days"
  | "weeks"
  | "months";

/** Every Kora response is wrapped in this envelope. */
export interface KoraResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface KoraCustomer {
  name: string;
  email: string;
  /** 10-digit NUBAN. */
  account_number: string;
  /** NIBSS bank code (3-6 chars). */
  bank_code: string;
  /** 11-digit Nigerian phone, leading 0 (e.g. 08012345678). */
  phone_number: string;
  billing_address?: string;
}

interface CreateAuthorizationBaseParams {
  currency: "NGN";
  description: string;
  /** YYYY-MM-DD */
  start_date: string;
  /** YYYY-MM-DD */
  end_date: string;
  customer: KoraCustomer;
}

export interface CreateVariableAuthorizationParams extends CreateAuthorizationBaseParams {
  debit_type: "variable";
  /** Max amount that can be debited in a single transaction under this authorization. */
  amount: number;
}

export interface CreateFixedAuthorizationParams extends CreateAuthorizationBaseParams {
  debit_type: "fixed";
  /** The amount charged on each scheduled run. */
  amount: number;
  frequency: KoraFrequency;
  /** Required (1-365) when frequency is "days" | "weeks" | "months"; forbidden otherwise. */
  interval?: number;
  retrial_frequency: 1 | 2 | 3;
  /** YYYY-MM-DD, must fall within start_date-end_date. */
  initial_debit_date: string;
}

export type CreateAuthorizationParams = CreateVariableAuthorizationParams | CreateFixedAuthorizationParams;

export interface AuthorizationData {
  status: AuthorizationStatus;
  reference: string;
  authorization_code: string;
  amount: number;
  currency: string;
  debit_type: DebitType;
  /** Human-readable activation instructions, e.g. "make a token payment of N50 to the account below." */
  description: string;
  customer_account_number: string;
  customer_bank_code: string;
  customer_account_name: string;
  customer_bank_name?: string;
  start_date: string;
  end_date: string;
}

export interface RetrieveAuthorizationData {
  reference: string;
  status: AuthorizationStatus;
  amount: number;
  currency: string;
  type: DebitType;
  account_name: string;
  account_number: string;
  bank_code: string;
  bank_name: string;
  status_update_reason: string | null;
  start_date: string;
  end_date: string;
}

export interface DebitAuthorizationParams {
  /** Your own idempotency reference for this specific debit. */
  reference: string;
  amount: number;
  currency: "NGN";
  narration: string;
}

export interface DebitData {
  transaction_reference: string;
  authorization_code: string;
  status: DebitStatus;
  amount: number;
  fee: number;
  vat: number;
  currency: string;
  nibss_transaction_id: string;
  processed_at: string;
}

export interface ChargeQueryData {
  reference: string;
  status: "success" | "failed" | "pending" | "processing";
  amount: string;
  amount_paid: string;
  fee: number;
  currency: string;
  description: string;
  customer: { name: string; email: string };
}

// ---- Webhook payloads ----

export interface DirectDebitAuthWebhook {
  type: "direct_debit.auth";
  status: "success" | "failed";
  data: {
    reference: string;
    authorization_code: string;
    amount: number;
    currency: string;
    authorization_type: DebitType;
    start_date: string;
    end_date: string;
    status: "success" | "failed";
    date: string;
    customer_account: {
      account_number: string;
      account_name: string;
      bank_code: string;
    };
  };
}

export interface ChargeOutcomeWebhook {
  event: "charge.success" | "charge.failed";
  data: {
    fee: number;
    payment_reference: string;
    amount: number;
    currency: string;
    reference: string;
    payment_method: string;
    status: "success" | "failed";
    direct_debit?: {
      authorization_code: string;
      account_number: string;
      account_name: string;
      bank_code: string;
    };
  };
}
