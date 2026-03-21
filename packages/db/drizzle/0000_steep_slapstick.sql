CREATE TYPE "public"."agent_channel_status" AS ENUM('absent', 'observing', 'active');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('company_general', 'project', 'dm', 'task_thread');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('agent_initiated', 'unread_message', 'decision_pending');--> statement-breakpoint
CREATE TYPE "public"."participant_type" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TABLE "agent_channel_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"status" "agent_channel_status" DEFAULT 'absent' NOT NULL,
	"anchor_seq" integer DEFAULT 0 NOT NULL,
	"cli_session_id" text,
	"cli_session_path" text,
	"idle_turn_count" integer DEFAULT 0 NOT NULL,
	"tokens_this_session" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"participant_type" "participant_type" NOT NULL,
	"participant_id" uuid NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "channel_type" NOT NULL,
	"company_id" uuid NOT NULL,
	"paperclip_ref_id" text,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"chunk_window_w_tokens" integer DEFAULT 1200 NOT NULL,
	"verbatim_k_tokens" integer DEFAULT 800 NOT NULL,
	"current_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_summaries" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL,
	"chunk_seq_covered" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trunk_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"chunk_start" integer NOT NULL,
	"chunk_end" integer NOT NULL,
	"summary" text NOT NULL,
	"summary_token_count" integer NOT NULL,
	"input_token_count" integer NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "turns_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"from_participant_id" uuid NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"summarize" boolean DEFAULT true NOT NULL,
	"mentioned_ids" text[],
	"is_decision" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_channel_states" ADD CONSTRAINT "agent_channel_states_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_summaries" ADD CONSTRAINT "session_summaries_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunk_chunks" ADD CONSTRAINT "trunk_chunks_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channel_states_session_participant_idx" ON "agent_channel_states" USING btree ("session_id","participant_id");--> statement-breakpoint
CREATE INDEX "notifications_unread_by_user_idx" ON "notifications" USING btree ("user_id","read_at") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "trunk_chunks_session_range_idx" ON "trunk_chunks" USING btree ("session_id","chunk_start","chunk_end");--> statement-breakpoint
CREATE INDEX "turns_session_id_seq_idx" ON "turns" USING btree ("session_id","seq");