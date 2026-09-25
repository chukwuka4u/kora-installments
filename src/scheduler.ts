import type { CreatePlanInput, Installment } from "./types.js";

/**
 * Splits totalAmount into numberOfInstallments, distributing any rounding
 * remainder onto the final installment so the sum always equals totalAmount exactly.
 */
export function buildSchedule(planId: string, input: CreatePlanInput): Installment[] {
  const { totalAmount, numberOfInstallments, intervalDays = 30, chargeFirstImmediately = true } = input;

  if (numberOfInstallments < 1) {
    throw new Error("numberOfInstallments must be at least 1");
  }
  if (totalAmount <= 0) {
    throw new Error("totalAmount must be greater than 0");
  }

  const baseAmount = Math.floor((totalAmount / numberOfInstallments) * 100) / 100;
  const installments: Installment[] = [];

  let allocated = 0;
  const now = new Date();

  for (let i = 0; i < numberOfInstallments; i++) {
    const isLast = i === numberOfInstallments - 1;
    const amount = isLast ? Math.round((totalAmount - allocated) * 100) / 100 : baseAmount;
    allocated += amount;

    const dueDate = new Date(now);
    if (i === 0 && chargeFirstImmediately) {
      // first installment due now
    } else {
      const intervalMultiplier = chargeFirstImmediately ? i : i + 1;
      dueDate.setDate(dueDate.getDate() + intervalMultiplier * intervalDays);
    }

    installments.push({
      reference: `${planId}-inst-${i + 1}`,
      planId,
      sequence: i + 1,
      amount,
      dueDate: dueDate.toISOString(),
      status: "pending",
    });
  }

  return installments;
}
