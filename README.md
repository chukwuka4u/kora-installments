# kora-installments

Installment scheduling built on top of [Kora](https://korapay.com)'s
Direct Debit and charge APIs. Kora doesn't track "installment 2 of 4" natively — this
package owns that state on your side while delegating actual money movement to Kora.

> **Status:** currently an early scaffold. `KoraClient` endpoint paths and payload shapes are
> placeholders and must be verified against the current
> [Kora API docs](https://developers.korapay.com) before production use.

## Install

```bash
npm install kora-installments
```

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

const { plan, installments, authorizationUrl } = await manager.createPlan({
  customerId: "cust_123",
  customerEmail: "buyer@example.com",
  totalAmount: 120000,
  currency: "NGN",
  numberOfInstallments: 3,
});

// Redirect the customer to authorizationUrl to approve the mandate.
// Once your webhook confirms authorization:
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

```ts
import { verifyKoraSignature } from "kora-installments";

const isValid = verifyKoraSignature(
  rawBody,
  req.headers["x-kora-signature"],
  process.env.KORA_WEBHOOK_SECRET!,
);
```

## Development

```bash
npm install
npm run build       # tsup -> dist/ (cjs + esm + .d.ts)
npm test            # vitest
npm run typecheck
```

## License

MIT
