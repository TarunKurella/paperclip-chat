ALTER TABLE "turns" ALTER COLUMN "seq" DROP IDENTITY IF EXISTS;
ALTER TABLE "turns" ALTER COLUMN "seq" DROP DEFAULT;
DROP INDEX IF EXISTS "turns_session_id_seq_idx";
CREATE UNIQUE INDEX "turns_session_id_seq_idx" ON "turns" USING btree ("session_id","seq");
