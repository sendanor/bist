ALTER TABLE revisions ADD COLUMN documentation_hash TEXT;
--> statement-breakpoint
ALTER TABLE revisions ADD COLUMN instructions_hash TEXT;
--> statement-breakpoint
ALTER TABLE revisions ADD COLUMN fingerprints_ready INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
DROP INDEX revisions_unhashed;
--> statement-breakpoint
CREATE INDEX revisions_unhashed ON revisions(id) WHERE fingerprints_ready = 0 AND files IS NOT NULL;
--> statement-breakpoint
CREATE INDEX revisions_documentation_hash ON revisions(documentation_hash) WHERE documentation_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX revisions_instructions_hash ON revisions(instructions_hash) WHERE instructions_hash IS NOT NULL;
