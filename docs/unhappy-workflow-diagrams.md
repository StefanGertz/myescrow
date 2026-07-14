# MyEscrow unhappy workflow diagrams

These diagrams map the implemented escrow lifecycle, its current unhappy paths, and a target recovery model. They are intended to support product decisions, acceptance criteria, and implementation sequencing.

## Legend

- Green nodes are successful or safely recoverable outcomes.
- Amber nodes require user action or can become stalled.
- Red nodes are dead ends, integrity risks, or unsupported recovery paths.
- Dashed arrows represent recovery transitions that should exist but do not exist today.

## 1. Current end-to-end lifecycle

```mermaid
flowchart TD
    A[Creator enters transaction details] --> B[Creator defines milestones]
    B --> C[Creator reviews and signs]
    C --> D[API persists escrow]
    D --> E[Invitation email attempted]

    E -->|Delivered| F{Counterparty account ready?}
    E -->|Delivery fails| E1[UI reports creation failure<br/>escrow may already exist]
    E1 -. No idempotent retry .-> D2[Duplicate escrow risk]

    F -->|No account or unverified| G[Pending signup or verification]
    G -->|Signup and verification complete| H[Pending counterparty approval]
    G -->|No response| G1[Stalled indefinitely]

    F -->|Verified account| H
    H -->|Approve and sign| I[Funding pending]
    H -->|Request changes| J[Changes requested]
    H -->|Reject| H1[Rejected terminal state]
    H -->|No response| H2[Stalled indefinitely]

    J -->|Creator accepts or keeps original| H
    J -->|No response| J1[Stalled indefinitely]

    I -->|Buyer has funds| K[Funded]
    I -->|Insufficient balance| I1[Wallet top-up required]
    I1 --> I
    I -->|Buyer does not fund| I2[Stalled indefinitely]

    K --> L[Milestone execution]
    L -->|All milestones released| M[Completed]
    L -->|Milestone rejected| N[Seller resubmits]
    N --> L
    L -->|Parties disagree| L1[No escrow-linked dispute path]

    classDef safe fill:#dcfce7,stroke:#15803d,color:#14532d;
    classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#7f1d1d;
    class A,B,C,D,F,H,I,J,K,L,M,N,I1 safe;
    class G warning;
    class E1,D2,G1,H1,H2,J1,I2,L1 danger;
```

## 2. Invitation, review, and agreement changes

```mermaid
flowchart TD
    A[Escrow persisted] --> B[Send invitation]
    B -->|Success| C{Counterparty status}
    B -->|Provider error or timeout| B1[Request fails after persistence]
    B1 -. Desired: delivery status and retry .-> B

    C -->|New user| D[Signup]
    D --> E[Email verification]
    E -->|Valid code| F[Claim pending invitation]
    E -->|Expired code| E1[Resend verification code]
    E1 --> E
    C -->|Existing unverified user| E
    C -->|Existing verified user| G[Review agreement]
    F --> G

    G -->|Accept| H[Counterparty signs]
    H --> I[Funding pending]
    G -->|Request changes| J[Creator reviews proposal]
    J -->|Accept changes| K[Agreement terms mutated]
    J -->|Keep original| G
    K --> K1[Creator's old signature remains attached]
    K1 --> G
    G -->|Reject| L[Rejected]

    L -. Desired: revise and resend .-> G
    G -. Desired: reminders or expiry .-> M[Cancel or extend invitation]
    K1 -. Desired: invalidate signatures<br/>and create new agreement version .-> N[Both parties sign final version]
    N --> I

    classDef safe fill:#dcfce7,stroke:#15803d,color:#14532d;
    classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#7f1d1d;
    class A,B,C,D,E,E1,F,G,H,I,J safe;
    class M,N warning;
    class B1,K,K1,L danger;
```

## 3. Current funding and release integrity risks

```mermaid
flowchart TD
    A[Both parties approved] --> B[Funding pending]
    B -->|Insufficient wallet balance| C[Top up wallet]
    C --> B
    B -->|Fund request| D{Balance check}
    D -->|Sufficient| E[Debit buyer wallet]
    E --> F[Mark escrow funded]
    D -->|Insufficient| C

    F --> G{Release path}
    G -->|Approve one milestone| H[Credit milestone amount to seller]
    H --> I{Any milestones remaining?}
    I -->|Yes| G
    I -->|No| J[Complete escrow]

    G -->|Full release endpoint| K[Credit full escrow amount to seller]
    H -->|Full release called later| K
    K --> K1[Previously released amounts can be paid again]

    F -->|Cancel endpoint| L[Mark cancelled]
    L --> L1[No refund or held-funds ledger adjustment]

    F -->|Concurrent approval requests| M[Both requests may pass stale state check]
    M --> M1[Double-credit risk]

    classDef safe fill:#dcfce7,stroke:#15803d,color:#14532d;
    classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#7f1d1d;
    class A,B,C,D,E,F,G,H,I,J safe;
    class K,K1,L,L1,M,M1 danger;
```

## 4. Current milestone rejection and dispute flow

```mermaid
flowchart TD
    A[Escrow funded] --> B[Milestones immediately pending review]
    B --> C{Buyer decision}
    C -->|Approve| D[Funds released]
    C -->|Reject| E[Milestone marked rejected]
    E --> F[Seller receives revision notification]
    F --> G[Seller selects resubmit]
    G --> B

    C -->|No response| H[No reminder, timeout, or auto-release]
    C -->|Disagreement| I[No dispute action on escrow]
    I --> J[Standalone dispute records only]

    E --> E1[No rejection reason required]
    G --> G1[No revised deliverable, evidence, or note required]
    B --> B1[No seller submission or evidence step]
    B --> B2[No ordering or deadline enforcement]

    classDef safe fill:#dcfce7,stroke:#15803d,color:#14532d;
    classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f;
    classDef danger fill:#fee2e2,stroke:#dc2626,color:#7f1d1d;
    class A,C,D,E,F,G safe;
    class B warning;
    class H,I,J,E1,G1,B1,B2 danger;
```

## 5. Target recoverable escrow process

```mermaid
flowchart TD
    A[Save versioned draft] --> B[Creator signs agreement version]
    B --> C[Persist escrow with idempotency key]
    C --> D[Queue invitation through transactional outbox]

    D -->|Delivered| E[Counterparty reviews]
    D -->|Bounced or failed| D1[Notify creator]
    D1 -->|Correct address| D
    D1 -->|Retry| D

    E -->|Request changes| F[Create new agreement version]
    F --> G[Invalidate prior signatures]
    G --> H[Creator reviews and signs]
    H --> E
    E -->|Reject| E1[Creator may revise, resend, or close]
    E1 --> A
    E -->|Accept and sign| I[Agreement locked]

    I --> J[Funding pending with expiry]
    J -->|Funding fails| J1[Retry, change method, or cancel]
    J1 --> J
    J -->|Timeout| J2[Cancel without moving funds]
    J -->|Success| K[Create held-funds ledger balance]

    K --> L[Seller submits milestone deliverable and evidence]
    L --> M{Buyer response window}
    M -->|Approve| N[Atomically release remaining milestone balance]
    M -->|Request revision with reason| O[Seller revises and resubmits]
    O --> L
    M -->|No response| P[Reminder then policy-based auto-release or escalation]
    M -->|Dispute| Q[Freeze affected milestone funds]

    Q --> R[Both parties provide evidence]
    R --> S{Resolution}
    S -->|Seller prevails| N
    S -->|Buyer prevails| T[Refund affected balance]
    S -->|Settlement| U[Split release and refund]

    N --> V{Held balance remaining?}
    T --> V
    U --> V
    V -->|Yes| L
    V -->|No| W[Complete with immutable audit trail]

    K -->|Mutual cancellation| X[Freeze new releases]
    X --> Y[Refund unreleased balance]
    Y --> W

    classDef safe fill:#dcfce7,stroke:#15803d,color:#14532d;
    classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f;
    class A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y safe;
    class D1,E1,J1,J2 warning;
```

## Recommended implementation order

1. Enforce held-balance invariants and eliminate competing full-release behavior.
2. Add atomic conditional transitions and idempotency for every money-moving action.
3. Version agreements and invalidate signatures after any material change.
4. Add explicit timeout, reminder, cancellation, and refund transitions.
5. Introduce seller submission evidence and buyer rejection reasons.
6. Link disputes to escrows and milestones, then freeze affected funds during resolution.
