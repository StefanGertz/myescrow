import { describe, expect, it } from "vitest";
import {
  allocateStagedFunding,
  milestoneIsFullyFunded,
} from "../utils/stagedFunding";

const milestones = [
  { id: 1, title: "Discovery", amountCents: 50_000, orderIndex: 0 },
  { id: 2, title: "Build", amountCents: 50_000, orderIndex: 1 },
  { id: 3, title: "Launch", amountCents: 100_000, orderIndex: 2 },
];

describe("staged funding allocation", () => {
  it("allocates an arbitrary deposit across milestones in order", () => {
    expect(allocateStagedFunding(milestones, 125_000)).toEqual([
      {
        milestoneId: 1,
        amountCents: 50_000,
        fundedCents: 50_000,
        remainingCents: 0,
        fundingStatus: "funded",
      },
      {
        milestoneId: 2,
        amountCents: 50_000,
        fundedCents: 50_000,
        remainingCents: 0,
        fundingStatus: "funded",
      },
      {
        milestoneId: 3,
        amountCents: 100_000,
        fundedCents: 25_000,
        remainingCents: 75_000,
        fundingStatus: "partially_funded",
      },
    ]);
  });

  it("does not unlock a partially funded milestone", () => {
    expect(milestoneIsFullyFunded(milestones, 125_000, 3)).toBe(false);
    expect(milestoneIsFullyFunded(milestones, 200_000, 3)).toBe(true);
  });
});
