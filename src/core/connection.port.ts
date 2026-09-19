import type { Result } from './result.js'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface ConnectTarget {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly version: string
  readonly auth: 'offline' | 'microsoft'
}

/** Facts about an established connection. */
export interface ConnectionInfo {
  readonly username: string
  readonly version: string
}

export type ConnectionEvent =
  | { readonly type: 'connected'; readonly username: string }
  | { readonly type: 'disconnected'; readonly reason: string }
  | { readonly type: 'kicked'; readonly reason: string }
  | { readonly type: 'error'; readonly message: string }

export type Unsubscribe = () => void

export interface Connection {
  readonly state: ConnectionState
  /** The target of the current or last connection attempt. */
  readonly target: ConnectTarget | undefined
  /** Resolves after the bot has spawned in the world, or with the reason it failed. */
  connect(target: ConnectTarget): Promise<Result<ConnectionInfo>>
  disconnect(): Promise<void>
  onEvent(listener: (event: ConnectionEvent) => void): Unsubscribe
}
