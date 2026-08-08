ALTER TABLE "CancellationReviewMessage"
ADD COLUMN "requestRecipient" TEXT,
ADD COLUMN "respondingParty" TEXT,
ADD COLUMN "inResponseToId" INTEGER;

UPDATE "CancellationReviewMessage"
SET "requestRecipient" = 'both'
WHERE "kind" = 'request_information';

UPDATE "CancellationReviewMessage" AS response
SET "respondingParty" = CASE
    WHEN response."authorId" = escrow."buyerId" THEN 'buyer'
    WHEN response."authorId" = escrow."sellerId" THEN 'seller'
    ELSE NULL
  END,
  "inResponseToId" = (
    SELECT request."id"
    FROM "CancellationReviewMessage" AS request
    WHERE request."cancellationRequestId" = response."cancellationRequestId"
      AND request."kind" = 'request_information'
      AND request."id" < response."id"
    ORDER BY request."id" DESC
    LIMIT 1
  )
FROM "CancellationRequest" AS cancellation
JOIN "Escrow" AS escrow ON escrow."id" = cancellation."escrowId"
WHERE response."cancellationRequestId" = cancellation."id"
  AND response."kind" = 'party_response';

CREATE INDEX "CancellationReviewMessage_inResponseToId_respondingParty_idx"
ON "CancellationReviewMessage"("inResponseToId", "respondingParty");

ALTER TABLE "CancellationReviewMessage"
ADD CONSTRAINT "CancellationReviewMessage_inResponseToId_fkey"
FOREIGN KEY ("inResponseToId") REFERENCES "CancellationReviewMessage"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
