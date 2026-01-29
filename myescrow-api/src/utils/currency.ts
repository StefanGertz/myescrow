const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCurrencyFromCents(valueInCents: number): string {
  const dollars = valueInCents / 100;
  return currencyFormatter.format(dollars);
}

export function formatAmountWithSuffix(valueInCents: number, suffix = "held"): string {
  return `${formatCurrencyFromCents(valueInCents)} ${suffix}`.trim();
}

export function dollarsToCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * 100);
}
