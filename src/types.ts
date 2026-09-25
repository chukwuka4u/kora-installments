export type InstallmentStatus = "pending" | "due" | "paid" | "failed";

export type PlanStatus = "awaiting_mandate" | "active" | "completed" | "cancelled";

export interface Installment {
  /** Unique reference sent to Kora for this specific charge. Used for idempotency. */
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
  mandateReference?: string;
  status: PlanStatus;
  createdAt: string;
}

export interface CreatePlanInput {
  customerId: string;
  totalAmount: number;
  currency: string;
  numberOfInstallments: number;
  /** Days between each installment. Defaults to 30. */
  intervalDays?: number;
  /** If true, the first installment is charged immediately rather than scheduled. */
  chargeFirstImmediately?: boolean;
}

export interface KoraClientConfig {
  apiKey: string;
  baseUrl?: string;
}
