export interface ServerStatus {
  /** The message of the day, as plain text. */
  readonly motd: string
}

export interface ServerStatusProbe {
  /** Asks a server for its status without joining. Undefined when it does not answer. */
  probe(host: string, port: number): Promise<ServerStatus | undefined>
}
