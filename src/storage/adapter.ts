import type { Installment, InstallmentPlanRecord } from "../types.js";

/**
 * Implement this interface against your own database (Postgres, Mongo, Prisma, etc).
 * The package ships an in-memory adapter for local development and tests only —
 * it is not durable and should never be used in production.
 */
export interface StorageAdapter {
  savePlan(plan: InstallmentPlanRecord): Promise<void>;
  getPlan(id: string): Promise<InstallmentPlanRecord | null>;
  updatePlan(id: string, patch: Partial<InstallmentPlanRecord>): Promise<void>;

  saveInstallments(installments: Installment[]): Promise<void>;
  getInstallmentsByPlan(planId: string): Promise<Installment[]>;
  getInstallmentByReference(reference: string): Promise<Installment | null>;
  updateInstallment(reference: string, patch: Partial<Installment>): Promise<void>;

  /** Returns installments that are due and not yet paid, for the collection job to process. */
  getDueInstallments(asOf: Date): Promise<Installment[]>;
}
