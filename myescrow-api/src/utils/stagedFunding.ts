import { centsToNumber } from "./currency";

export type FundingMilestone = {
  id: number;
  title?: string;
  amountCents: number | bigint;
  orderIndex: number;
};

export type MilestoneFundingAllocation = {
  milestoneId: number;
  amountCents: number;
  fundedCents: number;
  remainingCents: number;
  fundingStatus: "not_funded" | "partially_funded" | "funded";
};

export function allocateStagedFunding(
  milestones: FundingMilestone[],
  totalFundedCents: number | bigint,
): MilestoneFundingAllocation[] {
  let availableCents = Math.max(0, centsToNumber(totalFundedCents));

  return [...milestones]
    .sort((left, right) => left.orderIndex - right.orderIndex)
    .map((milestone) => {
      const amountCents = Math.max(0, centsToNumber(milestone.amountCents));
      const fundedCents = Math.min(amountCents, availableCents);
      availableCents = Math.max(0, availableCents - fundedCents);
      const remainingCents = amountCents - fundedCents;

      return {
        milestoneId: milestone.id,
        amountCents,
        fundedCents,
        remainingCents,
        fundingStatus:
          remainingCents === 0
            ? "funded"
            : fundedCents > 0
              ? "partially_funded"
              : "not_funded",
      };
    });
}

export function totalFundedFromLedger(
  entries: Array<{ movementType: string; amountCents: number | bigint }>,
) {
  return entries
    .filter((entry) => entry.movementType === "fund")
    .reduce((total, entry) => total + centsToNumber(entry.amountCents), 0);
}

export function milestoneIsFullyFunded(
  milestones: FundingMilestone[],
  totalFundedCents: number | bigint,
  milestoneId: number,
) {
  return allocateStagedFunding(milestones, totalFundedCents)
    .some((allocation) =>
      allocation.milestoneId === milestoneId
      && allocation.fundingStatus === "funded");
}
