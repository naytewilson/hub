CREATE TABLE "control_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"op" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"execution_id" uuid,
	"capability" text NOT NULL,
	"subject" text NOT NULL,
	"correlation_id" text,
	"effect" jsonb,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_operations_op_check" CHECK ("control_operations"."op" in ('resume', 'cancel', 'retry', 'acknowledge', 'execution_start')),
	CONSTRAINT "control_operations_status_check" CHECK ("control_operations"."status" in ('recorded', 'applied'))
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" DROP CONSTRAINT "organization_api_keys_scopes_check";--> statement-breakpoint
CREATE UNIQUE INDEX "control_operations_organization_idempotency_key_unique" ON "control_operations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "control_operations_organization_execution_idx" ON "control_operations" USING btree ("organization_id","execution_id");--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_scopes_check" CHECK ("organization_api_keys"."scopes" <@ ARRAY['projects:read', 'configuration:validate', 'configuration:install', 'runs:dispatch', 'daemons:enroll', 'rooms:read', 'controls:operate', 'controls:read']::text[] and cardinality("organization_api_keys"."scopes") > 0);