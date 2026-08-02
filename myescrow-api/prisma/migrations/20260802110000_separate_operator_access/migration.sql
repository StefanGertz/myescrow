ALTER TABLE "User"
ADD COLUMN "operatorRole" TEXT;

UPDATE "User"
SET "operatorRole" = "role",
    "role" = 'customer'
WHERE "role" IN ('support', 'admin');

CREATE INDEX "User_operatorRole_idx"
ON "User"("operatorRole");
