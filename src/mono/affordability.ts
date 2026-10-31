import { randomUUID, timingSafeEqual } from "node:crypto";
import { MonoClient } from "./client.js";
import type { AffordabilityCheck, AffordabilityStore, MonoClientConfig, MonoWebhook } from "./types.js";

export class InMemoryAffordabilityStore implements AffordabilityStore {
  private checks = new Map<string, AffordabilityCheck>();
  async save(c: AffordabilityCheck) { this.checks.set(c.id, c); }
  async get(id: string) { return this.checks.get(id) ?? null; }
  async getByAccountId(accountId: string) {
    return [...this.checks.values()].find((c) => c.accountId === accountId) ?? null;
  }
  async update(id: string, patch: Partial<AffordabilityCheck>) {
    const e = this.checks.get(id);
    if (!e) throw new Error(`Affordability check not found: ${id}`);
    this.checks.set(id, { ...e, ...patch, updatedAt: new Date().toISOString() });
  }
}

/** Mono sends your webhook secret back as-is in the `mono-webhook-secret` header. */
export function verifyMonoWebhook(headerValue: string | undefined, secret: string): boolean {
  if (!headerValue || !secret) return false;
  const a = Buffer.from(headerValue), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AffordabilityConfig {
  mono: MonoClientConfig;
  /** Where the customer lands after linking their account. */
  redirectUrl: string;
  store?: AffordabilityStore;
  /** Monthly interest rate sent to Mono. Default 0 (interest-free). Confirm Mono accepts 0 in sandbox. */
  interestRate?: number;
  /** Include credit-bureau history in the decision. Needs the customer's consent. Default true. */
  runCreditCheck?: boolean;
  /** How long a passed check stays usable. Default 30 days. */
  checkTtlDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class AffordabilityChecker {
  private mono: MonoClient;
  private store: AffordabilityStore;
  private cfg: Required<Pick<AffordabilityConfig, "redirectUrl" | "interestRate" | "runCreditCheck" | "checkTtlDays">>;

  constructor(config: AffordabilityConfig) {
    this.mono = new MonoClient(config.mono);
    this.store = config.store ?? new InMemoryAffordabilityStore();
    this.cfg = {
      redirectUrl: config.redirectUrl,
      interestRate: config.interestRate ?? 0,
      runCreditCheck: config.runCreditCheck ?? true,
      checkTtlDays: config.checkTtlDays ?? 30,
    };
  }

  /** Months a plan runs over: what Mono is asked to assess. Rounded up, at least 1. */
  static termMonths(numberOfInstallments: number, intervalDays = 30): number {
    return Math.max(1, Math.ceil((numberOfInstallments * intervalDays) / 30));
  }

  /**
   * Step 1. Creates a check and returns a link for the customer to connect their
   * bank account. The whole plan amount is assessed, which is the conservative choice.
   */
  async start(input: {
    customerId: string; name: string; email: string;
    totalAmount: number; numberOfInstallments: number; intervalDays?: number;
  }): Promise<{ check: AffordabilityCheck; linkUrl: string }> {
    const id = randomUUID();
    const res = await this.mono.initiateLinking({
      customer: { name: input.name, email: input.email }, ref: id, redirectUrl: this.cfg.redirectUrl,
    });
    const now = Date.now();
    const check: AffordabilityCheck = {
      id, customerId: input.customerId, status: "awaiting_link",
      principalKobo: Math.round(input.totalAmount * 100),
      termMonths: AffordabilityChecker.termMonths(input.numberOfInstallments, input.intervalDays),
      interestRate: this.cfg.interestRate, linkUrl: res.data.mono_url,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.cfg.checkTtlDays * DAY_MS).toISOString(),
    };
    await this.store.save(check);
    return { check, linkUrl: res.data.mono_url };
  }

  /**
   * Step 3, once the check is `data_ready`. The BVN is passed straight to Mono and
   * is never stored by this package.
   */
  async requestAssessment(checkId: string, input: { bvn: string }): Promise<void> {
    const check = await this.require(checkId);
    if (check.status !== "data_ready") throw new Error(`Check is "${check.status}", expected "data_ready"`);
    await this.mono.requestCreditworthiness(check.accountId!, {
      bvn: input.bvn, principal: check.principalKobo, interest_rate: check.interestRate,
      term: check.termMonths, run_credit_check: this.cfg.runCreditCheck,
    });
    await this.store.update(checkId, { status: "assessing" });
  }

  /**
   * Step 2 and 4. Feed every verified Mono webhook body in here. Safe to call
   * repeatedly: retried or out-of-order webhooks never move a check backwards.
   */
  async handleWebhook(payload: MonoWebhook): Promise<AffordabilityCheck | null> {
    const d = payload.data ?? {};
    switch (payload.event) {
      case "mono.events.account_connected": {
        const check = d.meta?.ref ? await this.store.get(d.meta.ref) : null;
        if (!check) return null;
        if (check.status === "awaiting_link") await this.store.update(check.id, { status: "linked", accountId: d.id });
        else if (!check.accountId) await this.store.update(check.id, { accountId: d.id });
        return this.store.get(check.id);
      }
      case "mono.events.account_updated": {
        const ref = d.meta?.ref;
        const check = (ref ? await this.store.get(ref) : null) ?? (d.account?._id ? await this.store.getByAccountId(d.account._id) : null);
        if (!check) return null;
        const status = String(d.meta?.data_status ?? "").toUpperCase();
        const early = check.status === "awaiting_link" || check.status === "linked";
        if (early && status === "AVAILABLE") await this.store.update(check.id, { status: "data_ready", accountId: d.account?._id ?? check.accountId });
        else if (early && status === "FAILED") await this.store.update(check.id, { status: "failed", reason: "Mono could not retrieve account data" });
        return this.store.get(check.id);
      }
      case "mono.events.account_credit_worthiness": {
        const check = d.account ? await this.store.getByAccountId(d.account) : null;
        if (!check || check.status !== "assessing") return check;
        if (d.summary) {
          await this.store.update(check.id, d.summary.can_afford
            ? { status: "passed", monthlyPaymentKobo: d.summary.monthly_payment }
            : { status: "failed", reason: "Assessed as unable to afford this plan", monthlyPaymentKobo: d.summary.monthly_payment });
        } else {
          await this.store.update(check.id, { status: "inconclusive", reason: d.message ?? "Not enough account history to assess" });
        }
        return this.store.get(check.id);
      }
      default:
        return null;
    }
  }

  getCheck(id: string) { return this.store.get(id); }

  /**
   * Call this when creating a plan. Throws unless the check passed, is unexpired,
   * belongs to this customer, and covers this plan. Marks it used so one passed
   * check can't back several plans.
   */
  async consumeForPlan(checkId: string, plan: { customerId: string; totalAmount: number; numberOfInstallments: number; intervalDays?: number }) {
    const check = await this.require(checkId);
    if (check.status === "consumed") throw new Error("Affordability check was already used for a plan");
    if (check.status !== "passed") throw new Error(`Affordability check has not passed (status: ${check.status})`);
    if (new Date(check.expiresAt).getTime() < Date.now()) throw new Error("Affordability check has expired");
    if (check.customerId !== plan.customerId) throw new Error("Affordability check belongs to a different customer");
    if (Math.round(plan.totalAmount * 100) > check.principalKobo) throw new Error("Plan amount is higher than the amount assessed");
    if (AffordabilityChecker.termMonths(plan.numberOfInstallments, plan.intervalDays) < check.termMonths)
      throw new Error("Plan is shorter than the term assessed, so payments would be larger");
    await this.store.update(checkId, { status: "consumed" });
  }

  private async require(id: string) {
    const c = await this.store.get(id);
    if (!c) throw new Error(`Affordability check not found: ${id}`);
    return c;
  }
}
