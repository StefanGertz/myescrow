# MyEscrow operational recovery runbook

The compiled operational worker is the only automated recovery entry point:

```bash
cd myescrow-api
npm run operations:run
```

Run it at least once per minute. Jobs are stored before execution, claimed conditionally, retried with backoff, and recover stale worker locks after ten minutes. Operators use `/operations` for health and failed-job retries. Support APIs require a `support` or `admin` role, an authenticated session, and an idempotency key for every mutation.

In the Docker deployment, `operations-worker` runs continuously from the same image as the API. Its database heartbeat must show a successful cycle within the last two minutes. External cron platforms may run `npm run operations:once` every minute instead.

## Operator access

1. Create and verify the intended administrator account through the normal signup flow.
2. Run `docker compose -f docker-compose.staging.yml --env-file .env.staging run --rm api npm run operators:bootstrap -- admin@example.com` once on the deployment host. A checked-out built release may run `npm run operators:bootstrap -- admin@example.com` with production `DATABASE_URL` instead.
3. The bootstrap refuses to run after any administrator exists.
4. Administrators grant, change, and revoke operator access from `/operations`.
5. Use `support` for recovery work and `admin` only for role management. The final administrator cannot be demoted.
6. Role changes are immediately effective because every operations request checks the database, and every change is written to the audit log.

## Payment or ledger mismatch

1. Stop manual payouts and do not edit wallet or ledger rows.
2. Inspect the latest recorded reconciliation and the escrow audit trail.
3. Compare each ledger entry with its linked wallet transaction and provider reference.
4. If the mismatch is external, record the provider reference before retrying the original domain command with its original idempotency key.
5. Escalate any remaining variance; reconciliation exceptions remain visible until a later clean run.

## Suspected duplicate payment

1. Search command replay counts and ledger business references.
2. Confirm whether the second request was an idempotent replay. A replay returns the first successful response and creates no second transfer.
3. If two provider references exist, freeze external settlement and reconcile them against the single MyEscrow ledger entry.
4. Never “fix” a duplicate by deleting a ledger entry. Use an approved compensating transaction after review.

## Email outage

1. Confirm failed invitation outbox counts on `/operations`.
2. Correct the recipient first if the address is wrong.
3. Retry the failed outbox event through the support API; do not modify its status in the database.
4. Extend the active invitation deadline when the outage consumed the response window.
5. Confirm delivery status and the corresponding support audit event.

## Stuck dispute or cancellation

1. Inspect the dispute evidence, deadline, frozen amount, cancellation state, and audit history.
2. Confirm ledger-held funds still cover the frozen amount.
3. Evidence-window and cancellation-response jobs notify both parties and escalate overdue work without moving money.
4. Retry a failed recovery job from `/operations`. A unilateral cancellation or expired evidence window never authorizes an automatic payout.
5. Resolution must still allocate every frozen cent through the normal settlement command or an approved future staff-resolution command.

## Ownership and service targets

| State | Owner | Initial target | Missed-target behavior |
| --- | --- | --- | --- |
| Invitation queued or failed | System, then creator | Retry within minutes | Backoff, alert, creator resend or support retry |
| Invitation awaiting response | Counterparty | 7 days | Reminder, then expiry at 14 days |
| Funding pending | Buyer | 7 days | Notify both parties and mark funding overdue |
| Milestone review | Buyer | 7 days | Reminder after 5 days; hold and escalate at deadline |
| Dispute evidence | Both parties | 7 days | Reminder with 2 days left; close evidence window and escalate |
| Mutual cancellation response | Counterparty | 3 days | Escalate without moving disputed funds |
| Unilateral cancellation | Support/legal | 1 business day | Keep all eligible funds held pending governed review |
| Reconciliation exception | Operations | Same day | Notify operators and retain the exception report |
