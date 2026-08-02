# Administrative Cancellation Review

## What is it?

Administrative Cancellation Review is a safety checkpoint used when someone asks to cancel a funded escrow agreement. While the request is being reviewed, the money stays protected and no automatic payout or refund takes place.

Think of the admin as a **traffic controller, not a judge**. The admin checks that the request follows the rules, asks for missing information, and sends genuine disagreements into the proper dispute process. The admin does not decide whether the buyer or seller broke the agreement.

> **Plain-language summary:** The admin can ask, close, refer, or execute—but cannot decide the dispute.

## What can the admin do?

| Admin action | What it means | Example |
| --- | --- | --- |
| **Ask for information** | Request missing facts or documents while the funds remain held. | “Please provide the delivery date and the cancellation notice.” |
| **Close for a procedural reason** | Close a request that cannot be processed under the rules. This does not declare a winner. | The same cancellation request was submitted twice, so the admin selects **Duplicate request** and records the applicable policy. |
| **Refer a milestone to a formal dispute** | Move a genuine disagreement into the evidence, settlement, and arbitration process. Only the selected funded milestone is reserved. | The parties disagree about a **Website homepage design · $500** milestone. That $500 is placed in dispute while unrelated website milestones continue normally. |
| **Execute a final refund decision** | Carry out an existing final court order or arbitration award. The admin is implementing the decision, not making it. | A final arbitration award orders the exact $500 held for the agreement to be refunded to the buyer. |

## What do the fields mean?

- **Administrative rationale or information request:** A plain-language explanation of what the admin needs or why an action is being taken. It becomes part of the permanent audit record.
- **Reason code and policy reference:** The rule that allows a request to be closed for a procedural reason, such as a duplicate or ineligible request.
- **Fully funded milestone:** The specific milestone that will enter the formal dispute process. Other funds are not pulled into that dispute.
- **Authority type and reference:** Identifies the final court order or arbitration award that authorizes a refund.
- **Effective date:** The date on which the final order or award took effect.
- **Retained document SHA-256:** A digital fingerprint used to identify the exact retained copy of the order or award. It does not replace storing the document.
- **Attestation:** The admin’s confirmation that the retained decision is authentic, final, effective, and authorizes the exact refund shown.

## Example: a disputed $500 homepage design

A buyer hired a designer for a website project with several milestones. The buyer asks to cancel the funded **Website homepage design · $500** milestone, saying the agreed design was not delivered. The designer says the completed files were delivered as promised.

1. The $500 remains protected while the request is reviewed.
2. If important information is missing, the admin asks for it.
3. If the request is a duplicate or otherwise procedurally invalid, the admin closes the request without deciding who is right.
4. If the parties genuinely disagree about delivery, the admin refers only the $500 homepage-design milestone to the formal dispute process. Other website milestones continue normally.
5. If a court or arbitrator later issues a final decision, the admin records the authority and carries out the exact result it requires.

## How is this different from arbitration?

**Administrative review manages the process. Arbitration decides the disagreement.**

An admin checks procedure and routes the case. An arbitrator considers evidence, decides the contractual merits, and may issue a binding award. A final award can then return to the admin panel for execution.
