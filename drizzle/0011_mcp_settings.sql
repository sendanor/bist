CREATE TABLE mcp_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  enabled_tools TEXT NOT NULL CHECK (json_valid(enabled_tools))
);
