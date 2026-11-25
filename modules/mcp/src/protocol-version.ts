/** Six-month transition window for clients still opening 2025-era MCP transports. */
export const MCP_2025_PROTOCOL_CUTOFF = Date.UTC(2027, 0, 28);

export function isMcpStrict(now = Date.now()): boolean {
  return now >= MCP_2025_PROTOCOL_CUTOFF;
}
