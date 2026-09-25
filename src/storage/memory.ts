import type { StorageAdapter } from "./adapter.js";
import type { Installment, InstallmentPlanRecord } from "../types.js";

/**
 * In-memory implementation of StorageAdapter.
 * Useful for local development, tests, and prototyping only — data is lost on restart.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private plans = new Map<string, InstallmentPlanRecord>();
  private installments = new Map<string, Installment>();

  async savePlan(plan: InstallmentPlanRecord): Promise<void> {
    this.plans.set(plan.id, plan);
  }

  async getPlan(id: string): Promise<InstallmentPlanRecord | null> {
    return this.plans.get(id) ?? null;
  }

  async updatePlan(id: string, patch: Partial<InstallmentPlanRecord>): Promise<void> {
    const existing = this.plans.get(id);
    if (!existing) throw new Error(`Plan not found: ${id}`);
    this.plans.set(id, { ...existing, ...patch });
  }

  async saveInstallments(installments: Installment[]): Promise<void> {
    for (const inst of installments) {
      this.installments.set(inst.reference, inst);
    }
  }

  async getInstallmentsByPlan(planId: string): Promise<Installment[]> {
    return [...this.installments.values()]
      .filter((i) => i.planId === planId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getInstallmentByReference(reference: string): Promise<Installment | null> {
    return this.installments.get(reference) ?? null;
  }

  async updateInstallment(reference: string, patch: Partial<Installment>): Promise<void> {
    const existing = this.installments.get(reference);
    if (!existing) throw new Error(`Installment not found: ${reference}`);
    this.installments.set(reference, { ...existing, ...patch });
  }

  async getDueInstallments(asOf: Date): Promise<Installment[]> {
    return [...this.installments.values()].filter(
      (i) => i.status !== "paid" && new Date(i.dueDate) <= asOf
    );
  }
}
