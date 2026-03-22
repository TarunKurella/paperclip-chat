ALTER TABLE "chat_sessions"
  ADD COLUMN "last_crystallized_seq" integer,
  ADD COLUMN "last_crystallized_issue_id" uuid;
