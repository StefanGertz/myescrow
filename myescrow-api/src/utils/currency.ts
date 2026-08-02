const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCurrencyFromCents(valueInCents: number | bigint): string {
  const dollars = centsToNumber(valueInCents) / 100;
  return currencyFormatter.format(dollars);
}

export function formatAmountWithSuffix(valueInCents: number | bigint, suffix = "held"): string {
  return `${formatCurrencyFromCents(valueInCents)} ${suffix}`.trim();
}

export function dollarsToCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError("Amount exceeds the supported exact-cent range.");
  }
  return cents;
}

export function centsToBigInt(valueInCents: number | bigint): bigint {
  if (typeof valueInCents === "bigint") return valueInCents;
  if (!Number.isSafeInteger(valueInCents)) {
    throw new RangeError("Amount must be an exact number of cents.");
  }
  return BigInt(valueInCents);
}

export function centsToNumber(valueInCents: number | bigint): number {
  const cents = Number(valueInCents);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError("Stored amount exceeds the supported exact-cent range.");
  }
  return cents;
}
