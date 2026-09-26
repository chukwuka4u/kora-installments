import { randomUUID } from "node:crypto";
import { KoraClient } from "./kora-client.js";
import { buildSchedule } from "./scheduler.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { CreatePlanInput, Installment, InstallmentPlanRecord, KoraClientConfig } from "./types.js";

export interface InstallmentPlanManagerConfig {
  kora: KoraClientConfig;
  storage: StorageAdapter;
}

export interface ActivationInstructions {
  /** Human-readable instructions from Kora to relay to the customer. */
  description: string;
  accountNumber: string;
  bankCode: string;
}

function toKoraDate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class InstallmentPlanManager {
  private client: KoraClient;
  private storage: StorageAdapter;

  constructor(config: InstallmentPlanManagerConfig) {
    this.client = new KoraClient(config.kora);
    this.storage = config.storage;
  }

  /**
   * Creates a plan, requests a Kora direct debit authorization, and persists
   * the installment schedule. There is no redirect/authorization URL in
   * Kora's flow — the customer activates the authorization themselves by
   * transferring a N50 NIBSS verification token to the account described in
   * `activationInstructions`. The plan stays "awaiting_authorization" until
   * your webhook handler confirms activation (see `activatePlan`).
   */
  async createPlan(
    input: CreatePlanInput
  ): Promise<{ plan: InstallmentPlanRecord; installments: Installment[]; activationInstructions: ActivationInstructions }> {
    const planId = randomUUID();
    const installments = buildSchedule(planId, input);

    const lastDueDate = new Date(installments[installments.length - 1].dueDate);
    const bufferDays = input.authorizationEndBufferDays ?? 7;
    const endDate = new Date(lastDueDate);
    endDate.setDate(endDate.getDate() + bufferDays);

    // "variable" authorizations cap the amount allowed per single debit, not
    // the plan total, so the ceiling must be at least the largest installment.
    const maxInstallmentAmount = Math.max(...installments.map((i) => i.amount));

    const authorization = await this.client.createAuthorization({
      debit_type: "variable",
      amount: maxInstallmentAmount,
      currency: input.currency,
      description: input.description ?? `Installment plan for ${input.customerId}`,
      start_date: toKoraDate(new Date()),
      end_date: toKoraDate(endDate),
      customer: input.customer,
    });

    const plan: InstallmentPlanRecord = {
      id: planId,
      customerId: input.customerId,
      totalAmount: input.totalAmount,
      currency: input.currency,
      authorizationReference: authorization.data.reference,
      authorizationCode: authorization.data.authorization_code,
      status: "awaiting_authorization",
      createdAt: new Date().toISOString(),
    };

    await this.storage.savePlan(plan);
    await this.storage.saveInstallments(installments);

    return {
      plan,
      installments,
      activationInstructions: {
        description: authorization.data.description,
        accountNumber: authorization.data.customer_account_number,
        bankCode: authorization.data.customer_bank_code,
      },
    };
  }

  /** Call this from your webhook handler once `direct_debit.auth` fires with status "success". */
  async activatePlan(planId: string): Promise<void> {
    await this.storage.updatePlan(planId, { status: "active" });
  }

  /**
   * Charges a single due installment. Idempotent: if the installment is
   * already marked "paid", this is a no-op.
   *
   * Debits are processed asynchronously by NIBSS, so an immediate verify
   * call may still return "pending"/"processing" rather than a final
   * status — in that case the installment is left as "due" for your
   * `charge.success` / `charge.failed` webhook handler to finalize.
   */
  async chargeInstallment(reference: string): Promise<void> {
    const installment = await this.storage.getInstallmentByReference(reference);
    if (!installment) throw new Error(`Installment not found: ${reference}`);
    if (installment.status === "paid") return; // idempotency guard

    const plan = await this.storage.getPlan(installment.planId);
    if (!plan?.authorizationCode) throw new Error(`Plan ${installment.planId} has no active authorization`);

    await this.storage.updateInstallment(reference, { status: "due" });

    await this.client.debitAuthorization(plan.authorizationCode, {
      reference,
      amount: installment.amount,
      currency: plan.currency as "NGN",
      narration: `Installment ${installment.sequence} for plan ${plan.id}`,
    });

    await this.reconcileInstallment(reference);
  }

  /**
   * Re-checks a debit's final status against Kora and updates local state
   * accordingly. Call this from your `charge.success` / `charge.failed`
   * webhook handler (recommended), or periodically for any installment
   * still stuck in "due".
   */
  async reconcileInstallment(reference: string): Promise<void> {
    const verification = await this.client.verifyCharge(reference);

    if (verification.data.status === "success") {
      await this.storage.updateInstallment(reference, {
        status: "paid",
        chargedAt: new Date().toISOString(),
      });
      const installment = await this.storage.getInstallmentByReference(reference);
      if (installment) await this.maybeCompletePlan(installment.planId);
    } else if (verification.data.status === "failed") {
      await this.storage.updateInstallment(reference, { status: "failed" });
    }
    // "pending" / "processing": leave as "due", not yet final.
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