# Arbitration report

## Purpose

The MyEscrow arbitration report is a system-generated evidence packet for a dispute that has been moved to arbitration. It gives an authorized arbitrator or case administrator one chronological record of the agreement, parties, dispute, communications, submitted evidence, and money movements.

It is not a legal pleading, legal conclusion, or substitute for any demand, answer, affirmation, filing form, fee, or exhibit format required by the selected arbitration provider or governing law. The external responsible party should confirm its exact filing requirements.

## Availability and access

The report exists only when `Dispute.arbitrationRequestedAt` is populated. This preserves access after a later status change while preventing report access for ordinary open disputes.

- Support and administrator accounts can view and download the report from the operations arbitration queue.
- The linked escrow buyer and seller can view and download their copy from the dispute workspace.
- Other authenticated customers receive `403`.
- A dispute that has not entered arbitration receives `409`.
- Legacy disputes without a linked escrow and operative agreement cannot produce the packet.

The operations and customer experiences use the same canonical report service. The generation timestamp can differ between requests, but unchanged source data produces the same report integrity SHA-256.

Managed exhibit bytes use the same arbitration-only boundary. The linked buyer, linked seller, and support/administrator accounts may retrieve them only after arbitration has been requested. Exhibit responses are private, are not cached, and cannot be used to retrieve a file from another dispute.

## Included sections

1. **Cover and integrity**
   - Report ID and version
   - Generation timestamp
   - Confidentiality label
   - SHA-256 of the canonical report data, excluding generation time
2. **Case summary**
   - Dispute and escrow references
   - Status, priority, dates, disputed amount, and currency
   - Party that opened the dispute and party that requested arbitration
   - Recorded dispute reason
   - System summary of the determination requested
3. **Parties**
   - Buyer and seller names, email addresses, roles, and agreement identity snapshots
4. **Operative agreement**
   - Exact locked agreement version, terms, amount, currency, milestones, dates, and terms hash
   - Electronic signature images when valid
   - Signer identity, role, signing time, and signature evidence hash
5. **Disputed milestone and work record**
   - Affected milestone
   - Work submissions, notes, reviews, and managed milestone evidence files
6. **Formal dispute evidence**
   - Submitter, submission time, note, managed evidence files, and file hashes
   - Metadata-only legacy references, clearly distinguished from managed files
7. **Complete escrow chat**
   - Every stored message in chronological order
   - Immutable message ID, sender identity and role, timestamp, and body
8. **Financial ledger**
   - Escrow movements, amounts, currency, timestamps, and business references
9. **Chronology**
   - Agreement, signature, funding, work, dispute, evidence, arbitration, ledger, and audit events
10. **Scope and limitations**
   - Plain-language qualifications about the generated record

## Download and embedded exhibits

The portal generates one PDF containing the report, signature images, and every managed exhibit as an embedded original-file attachment. Each exhibit receives a cover page containing its source context, original filename, media type, byte count, SHA-256, and attachment name. Valid PDF, JPEG, and PNG exhibits also receive visible preview pages after their cover so the most common exhibits can be reviewed in the report itself.

Other managed formats remain available as their original embedded attachments. They are not converted into PDF pages. This includes formats such as Word documents, spreadsheets, text files, HEIC/HEIF, and WebP. A PDF reader with an Attachments panel may be required to extract or open embedded originals.

The filename is based on the dispute reference. Page footers contain the report ID and a shortened integrity hash so printed or separated report pages can be associated with the packet.

The complete integrity SHA-256 appears on the cover and in the web view.

## Exhibit integrity and limits

Managed evidence is stored with its original filename, media type, byte count, and SHA-256. Before returning an arbitration exhibit, the API reads the stored file and verifies its byte count and SHA-256 against the database. The browser verifies both values again before embedding it. If a managed exhibit is unavailable or fails either check, PDF generation stops instead of silently producing an incomplete packet.

The combined managed exhibits may total no more than 100 MB (`100,000,000` bytes) for one downloadable packet. PDF and image previews also have page and pixel safety limits. Reaching a preview limit does not convert or omit the original attachment; the original managed file remains embedded.

Evidence submitted through the older metadata-only JSON flow has no file managed by MyEscrow. Those references remain in the report manifest and cannot be embedded unless their complete metadata matches a managed file belonging to the same arbitration. A filename, object key, or hash by itself is not treated as proof that file bytes are available.

The report integrity SHA-256 identifies the canonical report data, excluding generation time. Original exhibits are represented in that data by their metadata and SHA-256 values; the final PDF itself is not separately signed.

## Current claim and agreement limitations

The arbitration request currently records who requested arbitration and when, but it does not collect a separate party-authored statement of claim, requested remedy, legal theory, representative/counsel details, or certification. The report therefore includes the dispute reason and a clearly identified system summary requesting allocation of the frozen amount.

The agreement schema also does not separately model an arbitration clause, selected provider, procedural rules, seat, governing law, language, or fee allocation. If those terms are required for jurisdiction or filing, they must appear in the stored agreement description or be supplied separately.

## External filing rationale

The structure follows common filing elements rather than a jurisdiction-specific legal template. Current AAA/ICDR guidance calls for a contract or arbitration agreement, a written claim describing the dispute and requested relief, party information, and supporting documents or exhibits:

- [AAA/ICDR: How to File Your Arbitration Case](https://www.adr.org/sites/default/files/document_repository/How%20to%20File%20Your%20Arbitration%20Case.pdf)
- [UNCITRAL Arbitration Rules procedures administered by ICDR](https://www.adr.org/rules-forms-and-fees/international/procedures-for-cases-under-the-uncitral-arbitration-rules-2017-1/)
- [AAA Commercial Arbitration](https://www.adr.org/industries/commercial/)

The selected provider, contract, seat, governing law, and case-management orders remain authoritative.
