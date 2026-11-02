-- How an MCP server tells the client that the user must connect an app first:
--   'text'        — an isError tool result containing the connect link (works with every client)
--   'elicitation' — a standard MCP URL elicitation (JSON-RPC error -32042), which clients such as Paperclip
--                   surface to the responsible human as an authorization step
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS connect_handoff TEXT NOT NULL DEFAULT 'text';
