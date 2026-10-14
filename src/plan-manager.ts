import { randomUUID } from "node:crypto";
import { KoraClient } from "./kora-client.js";
import { buildSchedule } from "./scheduler.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { CreatePlanInput, Installment, InstallmentPlanRecord, KoraClientConfig, RetryPolicy } from "./types.js";

export interface InstallmentPlanManagerConfig {
  kora: KoraClientConfig;
  storage: StorageAdapter;
  retry?: RetryPolicy;
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ATTEMPT_SUFFIX = /-e\d+-a\d+$/; // "<installmentRef>-e<extensions>-a<attempt>"
const toInstallmentReference = (ref: string) => ref.replace(ATTEMPT_SUFFIX, "");

export class InstallmentPlanManager {
  private client: KoraClient;
  private storage: StorageAdapter;
  private retry: Required<RetryPolicy>;

  constructor(config: InstallmentPlanManagerConfig) {
    this.client = new KoraClient(config.kora);
    this.storage = config.storage;
    this.retry = {
      maxAttempts: config.retry?.maxAttempts ?? 3,
      retryDelayHours: config.retry?.retryDelayHours ?? 24,
      extensionDays: config.retry?.extensionDays ?? 7,
      maxExtensions: config.retry?.maxExtensions ?? 2,
    };
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
  if (installment.status === "paid" || installment.status === "failed") return;
  if (installment.status === "due") {
    await this.reconcileInstallment(reference);
    return;
  }

  const plan = await this.storage.getPlan(installment.planId);
  if (!plan?.authorizationCode) throw new Error(`Plan ${installment.planId} has no active authorization`);

  const attempts = (installment.attempts ?? 0) + 1;
  const attemptReference = `${reference}-e${installment.extensions ?? 0}-a${attempts}`;

  await this.storage.updateInstallment(reference, {
    status: "due",
    attempts,
    lastAttemptReference: attemptReference,
  });

  await this.client.debitAuthorization(plan.authorizationCode, {
    reference: attemptReference,
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
  const installmentReference = toInstallmentReference(reference);
  const installment = await this.storage.getInstallmentByReference(installmentReference);
  if (!installment) throw new Error(`Installment not found: ${installmentReference}`);

  if (installment.status !== "due") return;    // settled already, nothing in flight

  const currentAttempt = installment.lastAttemptReference ?? installment.reference;
  if (reference !== installmentReference && reference !== currentAttempt) return; // stale webhook

  const verification = await this.client.verifyCharge(currentAttempt);

  if (verification.data.status === "success") {
    await this.storage.updateInstallment(installmentReference, {
      status: "paid",
      chargedAt: new Date().toISOString(),
    });
    await this.maybeCompletePlan(installment.planId);
  } else if (verification.data.status === "failed") {
    await this.handleFailedAttempt(installment);
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

  private async handleFailedAttempt(installment: Installment): Promise<void> {
  const attempts = installment.attempts ?? 0;
  const extensions = installment.extensions ?? 0;
  const now = Date.now();

  if (attempts < this.retry.maxAttempts) {
    await this.storage.updateInstallment(installment.reference, {
      status: "pending",
      dueDate: new Date(now + this.retry.retryDelayHours * HOUR_MS).toISOString(),
      originalDueDate: installment.originalDueDate ?? installment.dueDate,
    });
  } else if (extensions < this.retry.maxExtensions) {
    await this.storage.updateInstallment(installment.reference, {
      status: "pending",
      dueDate: new Date(now + this.retry.extensionDays * DAY_MS).toISOString(),
      originalDueDate: installment.originalDueDate ?? installment.dueDate,
      attempts: 0,
      extensions: extensions + 1,
    });
  } else {
    await this.storage.updateInstallment(installment.reference, { status: "failed" });
  }
}
  
  /**
   * Checks if all installments for a plan are paid, and if so marks the plan as completed. Called after each successful installment charge.
   */
  private async maybeCompletePlan(planId: string): Promise<void> {
    const installments = await this.storage.getInstallmentsByPlan(planId);
    const allPaid = installments.every((i) => i.status === "paid");
    if (allPaid) {
      await this.storage.updatePlan(planId, { status: "completed" });
    }
  }
}