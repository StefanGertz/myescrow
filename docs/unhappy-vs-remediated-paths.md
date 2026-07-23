# MyEscrow: Original unhappy paths vs. remediated paths

## Executive summary

The original workflows could leave users stuck, duplicate important actions, or move money without a complete financial record. The remediated workflows now give every active state a clear next action, protect every money movement with an authoritative ledger, and retain an audit trail of what happened.

In each comparison below, the left side shows the original unhappy path. The right side shows the remediated path. Every node on the remediated side is green because failures and delays now lead to a safe recovery action rather than a dead end.

## 1. Escrow creation and invitation delivery

### The unhappy path, in everyday language

An escrow could be successfully created even though the invitation email failed. The creator would see an error and might try again, potentially creating a duplicate escrow without realizing the first one already existed.

**Example:** Alex creates a $5,000 escrow for Jordan. The escrow is saved, but the email provider times out. Alex sees “creation failed” and presses submit again. Two escrows may now exist for the same deal.

### What was done to remediate it

Creation now uses an idempotency key, so repeating the same request returns the original escrow instead of creating another one. The invitation is placed in a durable outbox in the same transaction as the escrow. Delivery is tracked separately and can be retried, corrected, extended, or escalated without recreating the deal.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 Creator submits escrow → escrow is saved → invitation email fails → UI reports failure → creator retries → duplicate escrow risk | 🟢 Creator submits once → escrow and invitation job are saved atomically → the same request can be safely retried → delivery status stays visible → failed delivery is retried or the address is corrected → one escrow and one accountable invitation remain |

## 2. Agreement changes and valid consent

### The unhappy path, in everyday language

The terms of a deal could change after someone signed, while the old signature remained attached. That made it possible for a signature to appear to approve terms the signer had never actually seen.

**Example:** Priya signs an agreement for three milestones. A milestone amount is later changed, but Priya’s original signature still appears valid. The escrow could move toward funding even though both parties did not sign the same final terms.

### What was done to remediate it

Every material change now creates a new, immutable agreement version. Earlier signatures are invalidated, both parties must sign the current version, and funding is blocked until the fully signed version is locked. Rejected or expired proposals can be revised, resent, extended, or closed instead of becoming unexplained dead ends.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 Parties sign → terms are changed in place → an old signature remains attached → changed terms may appear approved → funding can rely on stale consent | 🟢 A change creates a new agreement version → prior signatures are invalidated → both parties review and sign the same version → the agreement is locked → only that fully signed version can be funded |

## 3. Funding, release, and refund integrity

### The unhappy path, in everyday language

More than one release route could act on the same escrow, simultaneous requests could both pass an outdated status check, and a funded escrow could be marked cancelled without recording a refund. Status labels were being asked to do the job of a financial ledger.

**Example:** A buyer releases the first $1,000 milestone. Later, a separate “release all” action pays the full $5,000 deal amount. The seller could receive $6,000 even though only $5,000 was funded. In another case, cancellation could say “cancelled” while the buyer’s remaining funds were still unaccounted for.

### What was done to remediate it

All money movement now uses one immutable escrow ledger and one atomic transfer service. Funding, release, refund, and settlement commands are idempotent; conditional transitions prevent concurrent requests from succeeding twice; and balances are derived from ledger entries. The system enforces that released plus refunded funds can never exceed the funded amount.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 Fund escrow → release a milestone → a competing full-release or concurrent request also succeeds → seller may be paid twice; or cancel → status changes without a refund record | 🟢 Fund through one ledger-backed service → held balance is recorded → each release atomically reduces the remaining balance once → duplicate or concurrent requests return the original result or fail safely → cancellation refunds only the eligible remainder → every dollar ends as held, released, refunded, or settled |

## 4. Milestone submission, revision, and buyer response

### The unhappy path, in everyday language

A milestone could be placed in review without a real seller submission. A buyer could reject it without explaining why, and the seller could “resubmit” without providing changed work or evidence. If the buyer did nothing, the milestone could wait indefinitely.

**Example:** A designer marks a logo milestone ready without attaching a note or deliverable. The buyer clicks reject without a reason. The designer clicks resubmit without changing anything, and the same unproductive loop repeats. If the buyer stops responding, nobody knows what happens next.

### What was done to remediate it

A seller submission is now required before review begins. Each submission has a note, submission number, evidence metadata, and timestamp. Revision requests require a reason, resubmissions must be distinct, milestone order is enforced, and the buyer receives a seven-day response window with a reminder after five days. Overdue reviews follow a deterministic hold-and-escalate policy and never release funds automatically.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 Milestone appears ready → no submission or evidence is required → buyer rejects without a reason → seller resubmits without new information → review can loop or stall forever | 🟢 Seller creates a distinct submission with a note and evidence history → buyer reviews within a defined window → approval releases the remaining milestone balance once, or a reasoned revision request returns it to the seller → reminders run → no response holds funds safely and escalates |

## 5. Disputes and funded cancellation

### The unhappy path, in everyday language

Disputes were separate records that did not control the escrow balance. The system could not reliably freeze only the money being argued about or guarantee that a settlement, refund, or cancellation reconciled to the funds actually held.

**Example:** A buyer disputes a $2,000 milestone in a $10,000 escrow. The dispute exists as a record, but it does not reserve that $2,000. Staff cannot safely resolve it without manual intervention, and unrelated milestones may also become stuck.

### What was done to remediate it

Either party can open one active dispute against an eligible milestone. The remaining balance for that milestone is frozen atomically while unrelated funds stay available according to policy. Both parties can submit evidence and propose a seller release, buyer refund, or split. Allocations must equal every frozen cent, the other party must accept, and the ledger records the result. Mutual cancellation refunds only unreleased, undisputed funds; unilateral requests move into governed review without moving money.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 Parties disagree → standalone dispute record is created → affected funds are not authoritatively reserved → resolution or cancellation requires manual balance decisions → money can remain stranded or be allocated incorrectly | 🟢 Open one escrow-linked dispute → freeze exactly the affected milestone balance → collect evidence during a defined window → agree to release, refund, or an exact split → record ledger-backed settlement entries → continue unrelated work or complete with a reconciled audit trail |

## 6. Deadlines, monitoring, and operational recovery

### The unhappy path, in everyday language

Invitations, funding requests, milestone reviews, disputes, and cancellations could quietly age without reminders or escalation. Failed background work was difficult to see and often required someone to inspect or edit the database directly.

**Example:** An invitation retry job fails over a weekend. No alert is raised, the creator sees no clear recovery action, and support cannot safely retry it from an operator tool. The escrow simply appears stuck.

### What was done to remediate it

A persistent recovery queue now schedules invitation handling, funding escalation, milestone deadline sweeps, dispute reminders, cancellation escalation, and daily reconciliation. Workers safely claim and retry jobs, recover stale locks, and retain terminal failures. Operator dashboards expose failed jobs, aged escrows, delivery failures, dispute deadlines, worker health, duplicate attempts, and reconciliation variance. Support actions reuse the same permissioned, idempotent, audited domain commands as the main product.

| Original unhappy path | Remediated path — all green |
| --- | --- |
| 🔴 A party or background job stops responding → no standard reminder, expiry, or escalation runs → failure stays hidden → support needs manual database intervention | 🟢 Every waiting state has an owner and deadline → durable jobs send reminders or escalate → failed work is visible and safely retryable → reconciliation and health alerts notify operators → support actions are permissioned, idempotent, and audited |

## Result

The remediated process is recoverable end to end:

1. One retry-safe escrow is created and its invitation remains accountable.
2. Both parties sign one immutable final agreement.
3. Every money movement is atomic, idempotent, ledger-backed, and reconcilable.
4. Milestone review is based on distinct submissions, reasons, evidence history, and deadlines.
5. Disputed funds are precisely frozen and fully allocated through release, refund, or settlement.
6. Waiting states, job failures, and reconciliation issues are visible, owned, and recoverable.

The governing financial invariant is:

```text
funded amount = held amount + released amount + refunded amount
held amount >= 0
released amount + refunded amount <= funded amount
```

Every funded dollar therefore has one—and only one—final accounting outcome.
