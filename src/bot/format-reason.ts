/** Kick reasons arrive as plain strings or as Minecraft chat components; make them readable. */
export function formatReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}
