# kora-installments

Installment / Buy-Now-Pay-Later scheduling built on top of [Kora](https://korapay.com)'s
Direct Debit authorization API. Kora has no native concept of "installment 2 of 4" — it
only knows how to debit a bank account once, or on a fixed recurring cadence. This
package owns the installment schedule and state on your side while Kora handles the
actual bank debit.

> **Status:** early scaffold, typed directly against Kora's published docs
> (developers.korapay.com/docs/overview-1). Not yet tested against a live NIBSS
> authorization — verify in Kora's sandbox before production use.

## Install

```bash
npm install kora-installments
```

## How activation actually works (important — no redirect URL)

Unlike hosted-checkout flows, Kora's direct debit authorization is activated by the
**customer transferring a N50 verification token** to their own bank account via their
banking app or USSD — there is no page to redirect them to. `createPlan` returns
`activationInstructions` (a description plus the account/bank to send the token to) for
you to display. Once the bank confirms, Kora fires a `direct_debit.auth` webhook and the
authorization becomes debit-ready.

## Usage

```ts
import {
  InstallmentPlanManager,
  InMemoryStorageAdapter,
} from "kora-installments";

const manager = new InstallmentPlanManager({
  kora: { apiKey: process.env.KORA_SECRET_KEY! },
  storage: new InMemoryStorageAdapter(), // swap for your own StorageAdapter in production
});

const { plan, installments, activationInstructions } = await manager.createPlan(
  {
    customerId: "cust_123",
    customer: {
      name: "Jane Doe",
      email: "jane@example.com",
      account_number: "0112345678",
      bank_code: "058",
      phone_number: "08012345678",
    },
    totalAmount: 120000,
    currency: "NGN",
    numberOfInstallments: 3,
  },
);

// Show activationInstructions.description to the customer (the N50 token payment
// details). Once your webhook confirms `direct_debit.auth` status "success":
await manager.activatePlan(plan.id);

// Run this on a cron / queue worker:
await manager.runDueCollections();
```

## Bringing your own storage

Implement `StorageAdapter` against your real database — the in-memory adapter is for
local development and tests only.

```ts
import type { StorageAdapter } from "kora-installments";

class PostgresStorageAdapter implements StorageAdapter {
  // ...
}
```

## Webhooks

Kora signs webhooks with `x-korapay-signature`, an HMAC-SHA256 of **only the `data`
object** of the payload (not the full body):

```ts
import { verifyKoraSignature } from "kora-installments";

const isValid = verifyKoraSignature(
  req.body.data, // not req.body itself
  req.headers["x-korapay-signature"],
  process.env.KORA_WEBHOOK_SECRET!,
);
```

Two webhook events matter for this flow:

- `direct_debit.auth` (`status: "success" | "failed"`) — the authorization was
  approved or rejected. Call `manager.activatePlan(planId)` on success.
- `charge.success` / `charge.failed` — an individual debit finished. Call
  `manager.reconcileInstallment(reference)` to finalize local state (debits are
  processed asynchronously by NIBSS, so an immediate verify right after charging can
  still return `"pending"`/`"processing"`).

## Development

```bash
npm install
npm run build       # tsup -> dist/ (cjs + esm + .d.ts)
npm test            # vitest
npm run typecheck
```
