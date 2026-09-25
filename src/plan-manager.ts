import { randomUUID } from "node:crypto";
import { KoraClient } from "./kora-client.js";
import { buildSchedule } from "./scheduler.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { CreatePlanInput, Installment, InstallmentPlanRecord, KoraClientConfig } from "./types.js";

export interface InstallmentPlanManagerConfig {
  kora: KoraClientConfig;
  storage: StorageAdapter;
}

export class InstallmentPlanManager {
  private client: KoraClient;
  private storage: StorageAdapter;

  constructor(config: InstallmentPlanManagerConfig) {
    this.client = new KoraClient(config.kora);
    this.storage = config.storage;
  }

  /**
   * Creates a plan, starts the mandate authorization flow, and persists the
   * installment schedule. The plan stays in "awaiting_mandate" until the
   * customer completes authorization at the returned authorizationUrl.
   */
  async createPlan(
    input: CreatePlanInput & { customerEmail: string }
  ): Promise<{ plan: InstallmentPlanRecord; installments: Installment[]; authorizationUrl: string }> {
    const planId = randomUUID();

    const mandate = await this.client.createMandate({
      customerEmail: input.customerEmail,
      customerReference: input.customerId,
    });

    const plan: InstallmentPlanRecord = {
      id: planId,
      customerId: input.customerId,
      totalAmount: input.totalAmount,
      currency: input.currency,
      mandateReference: mandate.data.mandate_reference,
      status: "awaiting_mandate",
      createdAt: new Date().toISOString(),
    };

    const installments = buildSchedule(planId, input);

    await this.storage.savePlan(plan);
    await this.storage.saveInstallments(installments);

    return { plan, installments, authorizationUrl: mandate.data.authorization_url };
  }

  /** Call this once your webhook confirms the mandate was successfully authorized. */
  async activatePlan(planId: string): Promise<void> {
    await this.storage.updatePlan(planId, { status: "active" });
  }

  /**
   * Charges a single due installment. Idempotent: if the installment is
   * already marked "paid", this is a no-op.
   */
  async chargeInstallment(reference: string): Promise<void> {
    const installment = await this.storage.getInstallmentByReference(reference);
    if (!installment) throw new Error(`Installment not found: ${reference}`);
    if (installment.status === "paid") return; // idempotency guard

    const plan = await this.storage.getPlan(installment.planId);
    if (!plan?.mandateReference) throw new Error(`Plan ${installment.planId} has no active mandate`);

    await this.storage.updateInstallment(reference, { status: "due" });

    const result = await this.client.chargeMandate({
      mandateReference: plan.mandateReference,
      amount: installment.amount,
      reference,
    });

    // Never trust the immediate response alone — verify before marking paid.
    const verification = await this.client.verifyCharge(result.data.reference);

    if (verification.data.status === "success") {
      await this.storage.updateInstallment(reference, {
        status: "paid",
        chargedAt: new Date().toISOString(),
      });
      await this.maybeCompletePlan(installment.planId);
    } else {
      await this.storage.updateInstallment(reference, { status: "failed" });
    }
  }

  /**
   * Run this on a schedule (cron, queue worker, etc). Finds every due,
   * unpaid installment across all plans and attempts to charge it.
   */
  async runDueCollections(asOf: Date = new Date()): Promise<{ attempted: number }> {
    const due = await this.storage.getDueInstallments(asOf);
    for (const installment of due) {
      await this.chargeInstallment(installment.reference);
    }
    return { attempted: due.length };
  }

  private async maybeCompletePlan(planId: string): Promise<void> {
    const installments = await this.storage.getInstallmentsByPlan(planId);
    const allPaid = installments.every((i) => i.status === "paid");
    if (allPaid) {
      await this.storage.updatePlan(planId, { status: "completed" });
    }
  }
}
