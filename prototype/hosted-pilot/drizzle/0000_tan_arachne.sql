CREATE TABLE `native_attempts` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`proposal` text NOT NULL,
	`status` text NOT NULL,
	`comment_id` integer,
	FOREIGN KEY (`intent_id`) REFERENCES `native_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_json" CHECK(json_valid("native_attempts"."proposal")),
	CONSTRAINT "attempt_status" CHECK("native_attempts"."status" IN ('sending','unknown','acknowledged')),
	CONSTRAINT "positive_comment" CHECK("native_attempts"."comment_id" > 0),
	CONSTRAINT "attempt_reference" CHECK(("native_attempts"."status" = 'acknowledged' AND "native_attempts"."comment_id" IS NOT NULL) OR ("native_attempts"."status" IN ('sending','unknown') AND "native_attempts"."comment_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `native_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`quarantined` integer NOT NULL,
	CONSTRAINT "control_singleton" CHECK("native_control"."id" = 1),
	CONSTRAINT "control_quarantined" CHECK("native_control"."quarantined" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `pilot_evidence` (
	`name` text PRIMARY KEY NOT NULL,
	`evidence` text NOT NULL,
	CONSTRAINT "evidence_json" CHECK(json_valid("pilot_evidence"."evidence"))
);
--> statement-breakpoint
CREATE TABLE `native_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "finding_status" CHECK("native_findings"."status" IN ('proposed','published','closed'))
);
--> statement-breakpoint
CREATE TABLE `native_transition_guard` (
	`id` integer,
	CONSTRAINT "impossible_transition_guard" CHECK("native_transition_guard"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `native_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`proposal` text NOT NULL,
	`status` text NOT NULL,
	`external_reference` text,
	FOREIGN KEY (`finding_id`) REFERENCES `native_findings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_json" CHECK(json_valid("native_outbox"."proposal")),
	CONSTRAINT "outbox_status" CHECK("native_outbox"."status" IN ('pending','acknowledged')),
	CONSTRAINT "outbox_reference" CHECK(("native_outbox"."status" = 'pending' AND "native_outbox"."external_reference" IS NULL) OR ("native_outbox"."status" = 'acknowledged' AND "native_outbox"."external_reference" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_finding` ON `native_outbox` (`finding_id`);