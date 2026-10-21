/**
 * The close code a Router answers a second lane MCP server in one Claude session with: same join
 * key, same conversation, while the first channel is still open. The client must take it as final.
 * Reconnecting is exactly what turned two servers into a loop (Vikunja LR-30).
 */
export const DUPLICATE_CHANNEL_CLOSE_CODE = 4409;
