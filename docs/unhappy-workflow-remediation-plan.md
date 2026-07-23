# MyEscrow unhappy-path remediation plan

## Objective

Make every escrow state safe, recoverable, and understandable to both parties. The plan prioritizes preventing financial loss first, then improves agreement integrity, delivery and response recovery, milestone evidence, and dispute handling.

This is a delivery sequence rather than a calendar commitment. Each phase should be released only after its exit criteria pass in staging and any existing escrow data has been reconciled.

## Confirmed starting point

The current implementation has several useful foundations: escrow and milestone records, buyer and seller roles, signatures, notifications, transactional service methods, and API integration tests. The main gaps are:

- Funding, full release, milestone release, and cancellation rely on status fields and wallet updates rather than an authoritative escrow balance ledger.
- The full-release and milestone-release routes can act on the same funded escrow.
- Funded cancellation changes lifecycle status without recording a refund.
- State checks are read before writes, so concurrent requests can act on the same stale state.
- Agreement changes update milestone terms without creating an immutable agreement version or invalidating earlier signatures.
- Invitation email is sent after the escrow transaction commits, but delivery status and retries are not persisted.
- Milestone rejection and resubmission do not require reasons, deliverables, or evidence.
- Disputes are standalone records and do not reserve or resolve escrow funds.
- Waiting states have no standard owner, deadline, reminder cadence, expiry, or escalation rule.

## Guiding rules

These rules apply across every phase:

1. Every dollar funded must leave escrow exactly once through release, refund, or settlement.
2. Every money-moving request must be atomic and safe to retry.
3. Both signatures must refer to the same immutable agreement version.
4. Every non-terminal state must have an owner, a response deadline, and an allowed recovery action.
5. A dispute should freeze only the affected balance unless policy requires the entire escrow to pause.
6. Every important transition must produce an immutable audit event.
7. User-facing status must be derived from authoritative process data, not used as the financial record itself.

## Delivery overview

| Phase | Outcome | Main unhappy paths addressed |
| --- | --- | --- |
| 0. Contain immediate risk | Unsafe actions are blocked while the durable model is built | Double release, funded cancellation without refund, concurrent payout |
| 1. Establish money integrity | One authoritative held-funds ledger controls every movement | Over-release, stranded funds, duplicate requests, weak reconciliation |
| 2. Protect agreement consent | Invitations are reliable and both parties sign one final version | Failed invitations, duplicate creation, stale signatures, terminal rejection |
| 3. Make milestone review evidence-based | Work, reasons, revisions, and response windows are recorded | Empty resubmission, unexplained rejection, indefinite review |
| 4. Connect disputes and cancellation to funds | Frozen amounts are resolved through release, refund, or settlement | Standalone disputes, whole-process dead ends, unsafe cancellation |
| 5. Operationalize recovery | Reminders, monitoring, reconciliation, and support tools make recovery dependable | Silent stalls, unnoticed failures, manual database intervention |

## Phase 0 — Contain immediate financial risk

### Changes

- Remove the full-release action from the web interface.
- Make the legacy full-release API unavailable for milestone-based escrows, or temporarily calculate and release only unreleased milestones through the same service used by milestone approval.
- Reject cancellation after funding until the ledger-backed refund path exists.
- Add conditional state updates so only one request can move a pending milestone to released.
- Add temporary request identifiers to funding and release commands and reject replays.
- Log every attempted fund, release, and cancellation with escrow, milestone, actor, request identifier, and result.

### Exit criteria

- Repeating or concurrently submitting the same milestone approval credits the seller once.
- A full-release call after a partial milestone release cannot pay any milestone twice.
- A funded escrow cannot be marked cancelled without a corresponding refund operation.
- Regression tests cover duplicate, concurrent, stale-state, and unauthorized requests.

## Phase 1 — Establish the money-integrity foundation

**Implementation status (2026-07-19):** The database migration, legacy backfill, immutable ledger, atomic transfer service, derived balances, idempotency enforcement for create/fund/milestone approval, and reconciliation command are implemented locally. Production rollout still requires staging reconciliation with zero unexplained variance. Refund and settlement movements will begin using the same transfer service when their Phase 4 workflows are introduced.

### Data model

Introduce an immutable ledger entry for each escrow movement. Each entry should include:

- Escrow and, when relevant, milestone identifiers.
- Movement type: `fund`, `release`, `refund`, `settlement_release`, or `settlement_refund`.
- Signed amount in cents and currency.
- Idempotency key and a unique business reference.
- Actor, source command, timestamp, and optional payment-provider reference.

Add an idempotency record for write commands and a concurrency field or conditional transition mechanism for mutable process records. Expose held, released, refunded, and disputed totals as derived balances.

The core invariant is:

```text
funded amount = held amount + released amount + refunded amount
held amount >= 0
released amount + refunded amount <= funded amount
```

### API and service changes

- Replace direct wallet balance mutations with one ledger-backed transfer service.
- Execute the process transition, ledger entry, wallet entries, and audit event in one database transaction.
- Require an idempotency key for create, fund, release, refund, and dispute resolution commands.
- Return the original successful result when the same key and payload are replayed.
- Reject reuse of an idempotency key with a different payload.
- Derive completion from a zero held balance and resolved milestones, rather than setting it independently.
- Add an internal reconciliation command that compares ledger totals, wallet transactions, and escrow balances.

### Migration and rollout

1. Add the new tables and fields without changing production behavior.
2. Backfill funded, released, and completed escrows from current escrow, milestone, and wallet records.
3. Produce an exception report for any escrow that cannot be reconciled automatically.
4. Dual-write existing actions to the new ledger in staging and compare results.
5. Switch reads and money-moving decisions to the ledger only after reconciliation reaches zero unexplained variance.

### Exit criteria

- Funding, release, refund, and settlement all use one transfer service.
- Automated tests prove the invariant after every supported command sequence.
- Concurrent and repeated requests cannot change the financial result.
- Every funded escrow can produce a complete balance history.
- The legacy full-release implementation is removed.

## Phase 2 — Protect invitation delivery and agreement consent

**Implementation status (2026-07-19):** The agreement-version and invitation-outbox migration, legacy backfill, version-bound signatures, funding consent gate, retryable invitation delivery, deadline extension, recipient correction/resend flow, and user-facing agreement/invitation status are implemented locally. API tests cover idempotent creation, provider failure recovery, signature invalidation after term changes, and funding only after both parties sign the locked current version. Production rollout still requires applying the migration in staging, running the invitation worker on a schedule, and verifying delivery with the configured email provider.

### Data model

- Add immutable agreement versions containing the complete terms and milestone snapshot.
- Store signatures separately with agreement-version ID, signer, signed timestamp, and signature evidence.
- Add an outbox event and invitation-delivery record with recipient, attempt count, provider identifier, status, next attempt, and failure reason.
- Add invitation expiry and agreement response deadline fields.

### Process changes

- Accept an idempotency key when creating an escrow so a client retry returns the existing transaction.
- Persist the escrow and invitation outbox event in the same database transaction.
- Send email from an outbox worker with retry and backoff; do not turn an email-provider failure into an escrow-creation failure.
- Show invitation state in the UI: queued, delivered, failed, corrected, expired, or accepted.
- Allow the creator to correct the recipient address and resend without creating another escrow.
- Make every material term change create a new agreement version.
- Invalidate both prior signatures when a new version is created.
- Lock the accepted version before funding and require both valid signatures on that version.
- Replace terminal rejection with explicit creator choices: revise and resend, or close the proposal.
- Add reminder, extend, and close actions for unanswered invitations.

### Exit criteria

- Repeating escrow creation with the same idempotency key produces one escrow.
- An invitation-provider outage leaves one visible escrow with a retryable delivery state.
- Changing any signed term makes the agreement ineligible for funding until both parties sign the new version.
- The API cannot fund an unsigned or superseded agreement version.
- Rejected and expired proposals have clear revise, resend, extend, or close paths.

## Phase 3 — Make milestone review evidence-based

### Data model

- Add milestone submissions with submitter, submission number, note, evidence references, and submission timestamp.
- Add milestone reviews with reviewer, decision, reason, and timestamp.
- Replace the broad `pending` state with explicit states such as `not_started`, `submitted`, `revision_requested`, `approved`, and `disputed`.
- Add review deadline and reminder timestamps.

Evidence files should use private object storage, short-lived access links, malware scanning, file-size and type limits, and retention rules. The database should store evidence metadata rather than large files.

### Process changes

- Require the seller to submit a milestone before the buyer can review it.
- Require a reason when the buyer requests a revision.
- Require a new submission note or changed evidence when the seller resubmits.
- Preserve the complete submission and review history.
- Enforce milestone order where the agreement requires sequential work.
- Start the buyer response window only after a valid submission.
- Send reminders before the deadline and apply the configured no-response policy afterward.

### Exit criteria

- A milestone cannot release before a seller submission exists.
- Every revision cycle has a buyer reason and a distinct seller submission.
- Both parties can see the same chronological evidence and decision history.
- No-response handling is deterministic and tested.
- Released amounts always use the remaining ledger balance for that milestone.

**Implementation status (2026-07-22):** Phase 3 is implemented locally. Milestones now move through `not_started`, `submitted`, `revision_requested`, and `released`; a seller submission is required before buyer review; revision reasons and distinct resubmissions are enforced; submission, evidence-metadata, and review history is returned to both parties; and earlier milestones must be released before later work can be submitted. Buyer review opens for seven days, receives a reminder after five days, and follows a deterministic `hold_and_escalate` policy when overdue, so missed reviews never release funds automatically. The dashboard exposes submission notes, revision reasons, review deadlines, overdue state, and chronological submission history. Private evidence upload, malware scanning, and short-lived download links still require the planned object-storage integration before file attachments are enabled in production.

## Phase 4 — Connect disputes and cancellation to escrow funds

### Data model

- Link disputes to an escrow and optional milestone.
- Record the amount frozen, reason, opened-by party, evidence window, status, and resolution authority.
- Store evidence submissions and resolution outcomes.
- Represent resolution as one or more ledger allocations whose total equals the frozen amount.

### Process changes

- Let either eligible party open a dispute from a submitted or revision-requested milestone.
- Atomically mark the milestone disputed and reserve its remaining held balance.
- Keep unrelated milestone funds available unless the dispute policy explicitly pauses them.
- Support three resolution outcomes: release to seller, refund to buyer, or split settlement.
- Require the resolution allocations to equal the frozen amount before closing the dispute.
- Support mutual cancellation by stopping new releases and refunding the unreleased, undisputed balance.
- Define a separate governed path for unilateral cancellation after funding.

### Exit criteria

- A dispute cannot freeze or allocate more than the milestone's remaining balance.
- Opening the same dispute twice creates one active dispute and one frozen amount.
- Every resolution reconciles completely to ledger entries.
- Mutual cancellation refunds only money that has not already been released or otherwise allocated.
- The escrow audit trail links the issue, evidence, decision, and resulting money movement.

**Implementation status (2026-07-22):** Phase 4 is implemented locally. Either escrow party can open one active dispute against an eligible milestone, and the dispute freezes only that milestone's remaining held balance. Evidence notes and private file metadata are retained during a seven-day evidence window. A party may propose release, refund, or a split, but the seller and buyer allocations must add up to every frozen cent and the other party must accept before ledger-backed settlement entries move money. Concurrent dispute opening and proposal changes use conditional transitions, and all money-moving commands are idempotent.

Funded mutual cancellation is now a request-and-accept workflow: new milestone activity stops, the unreleased and undisputed balance returns to the buyer, and disputed funds remain held until their linked dispute is resolved. A unilateral request moves the escrow into governed review without moving money. The dashboard shows the frozen amount, evidence deadline and history, complete resolution proposal, cancellation status, and the counterparty action required. Automated deadline escalation, staff resolution authority, and operational support tooling remain Phase 5 work.

## Phase 5 — Operationalize recovery and eliminate silent stalls

### Capabilities

- Add a durable job runner for invitation retries, reminders, expiries, funding timeouts, and review deadlines.
- Define an owner and service-level target for every non-terminal state.
- Add dashboards and alerts for failed outbox jobs, aged escrows, reconciliation variance, duplicate-command attempts, and disputes approaching deadlines.
- Add support tools for safe resend, deadline extension, evidence inspection, and retrying failed jobs. Support tools must call the same domain commands as the user-facing API.
- Add a complete audit-event view for users and support staff.
- Document incident procedures for payment mismatch, duplicate-payment suspicion, email outage, and stuck dispute resolution.

### Exit criteria

- No active escrow can remain beyond its policy deadline without a reminder, expiry, or escalation event.
- Failed jobs are visible and retryable without database edits.
- Daily reconciliation produces a recorded result and pages an owner on variance.
- Support actions are permissioned, audited, and idempotent.

## Cross-cutting API and web work

### API

- Move lifecycle rules into small domain services rather than adding more direct status mutations to `dashboardService.ts`.
- Use typed state values instead of unrestricted strings for lifecycle, milestone, delivery, and dispute status.
- Separate commands from read models: commands enforce transitions; dashboard responses explain current state, owner, deadline, and available actions.
- Use consistent conflict responses for stale state and idempotency mismatches.

### Web application

- Send an idempotency key with every consequential mutation and retain it across retry attempts.
- Present a successful creation separately from invitation-delivery status.
- Show who must act next, by when, and what happens if they do not.
- Disable actions based on authoritative available actions returned by the API, not inferred client-side status alone.
- Add agreement-version comparison and clear re-signing prompts.
- Add milestone submission, evidence, revision, dispute, settlement, and refund views.

## Required policy decisions

Product, legal/compliance, and operations should decide these before their dependent phases begin:

1. How long invitations, funding requests, milestone reviews, evidence windows, and disputes remain open.
2. Whether buyer non-response causes auto-release, escalation, or continued holding, and in which markets or transaction types.
3. Who may cancel before funding, after funding, during a milestone review, and during a dispute.
4. Who decides disputes, what evidence is allowed, whether fees apply, and whether decisions can be appealed.
5. Whether milestones must always be completed in order.
6. How legacy escrows with ambiguous balances will be reconciled and approved.
7. Which payment provider is the source of truth once real payment rails replace the internal wallet model.

## Critical acceptance scenarios

The end-to-end suite must include at least these cases:

1. The client times out during creation and retries; one escrow and one invitation remain.
2. Email delivery fails after creation; the escrow remains visible and the invitation can be corrected and retried.
3. Agreement terms change after signing; previous signatures cannot authorize funding.
4. Two funding requests arrive together; the buyer is debited once.
5. Two milestone approvals arrive together; the seller is credited once.
6. A full-release attempt follows a partial release; total payout cannot exceed the funded amount.
7. Cancellation follows partial release; only the unreleased eligible balance is refunded.
8. A buyer requests revision without a reason; the request is rejected.
9. A seller resubmits without a new submission record; the request is rejected.
10. A dispute freezes one milestone while an unrelated milestone proceeds according to policy.
11. A split settlement allocates the exact frozen amount between release and refund.
12. Every final state satisfies the ledger invariant and has a complete audit history.

## Suggested delivery gates

- **Gate A — Contained:** Phase 0 protections are live and high-risk legacy actions are blocked.
- **Gate B — Financially safe:** Ledger reconciliation is clean and all money movement uses the new service.
- **Gate C — Consent safe:** Versioned agreements and reliable invitations are live; unsigned versions cannot be funded.
- **Gate D — Operationally recoverable:** Evidence-based milestones, deadlines, and reminders are live.
- **Gate E — Fully recoverable:** Disputes, settlements, refunds, cancellation, monitoring, and support recovery are ledger-backed and audited.

No later gate should be used to bypass an unmet financial or consent-safety gate.
