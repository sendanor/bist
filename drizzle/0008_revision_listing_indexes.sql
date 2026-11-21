CREATE INDEX revision_review_listing ON revisions(created DESC, id DESC)
WHERE state IN ('pending','approved','quarantined')
   OR (removal_reason IS NOT NULL AND state != 'removed');
--> statement-breakpoint
CREATE INDEX revision_author_listing ON revisions(author, created DESC, id DESC)
WHERE state != 'removed';
--> statement-breakpoint
CREATE INDEX revision_published_listing ON revisions(state, published_at DESC, id DESC)
WHERE published_at IS NOT NULL;
--> statement-breakpoint
DROP INDEX revisions_queue;
--> statement-breakpoint
CREATE INDEX revisions_queue ON revisions(state, created DESC, id DESC);
