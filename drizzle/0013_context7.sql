ALTER TABLE assistant_docs_mcp ADD COLUMN context7_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (context7_enabled IN (0, 1));
