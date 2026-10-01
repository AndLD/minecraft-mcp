import type { ConnectTarget } from './connection.port.js'
import type { Position } from './position.types.js'

/**
 * What the server tells the client about the world. Each signal may be missing.
 * Together they recognize the same world across sessions, even when the LAN port changes.
 */
export interface WorldFingerprint {
  /** The hashed world seed from the login packet (hex). Stable for a world. */
  readonly seed: string | null
  /** From the server message of the day: the LAN world name, or the server's MOTD. */
  readonly worldName: string | null
  /** The world spawn point. */
  readonly spawn: Position | null
}

export interface WorldIdentifier {
  /** Reads the fingerprint of the connected world. `worldNameHint` skips asking the server for its name. */
  identify(target: ConnectTarget, worldNameHint?: string): Promise<WorldFingerprint>
}
