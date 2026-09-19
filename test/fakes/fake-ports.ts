import type { ChatPort, IncomingChat } from '../../src/core/chat.port.js'
import type {
  Connection,
  ConnectionEvent,
  ConnectionInfo,
  ConnectionState,
  ConnectTarget,
} from '../../src/core/connection.port.js'
import type {
  LanDiscovery,
  LanDiscoveryOptions,
  LanWorld,
} from '../../src/core/lan-discovery.port.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Vitals, VitalsReader } from '../../src/core/vitals.port.js'

export class FakeConnection implements Connection {
  state: ConnectionState = 'disconnected'
  target: ConnectTarget | undefined
  connectResult: Result<ConnectionInfo> = ok({ username: 'ClaudeBot', version: '1.21.1' })
  readonly connectCalls: ConnectTarget[] = []
  disconnectCalls = 0
  private listeners: ((event: ConnectionEvent) => void)[] = []

  connect(target: ConnectTarget): Promise<Result<ConnectionInfo>> {
    this.connectCalls.push(target)
    this.target = target
    this.state = this.connectResult.ok ? 'connected' : 'disconnected'
    return Promise.resolve(this.connectResult)
  }

  disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.state = 'disconnected'
    return Promise.resolve()
  }

  onEvent(listener: (event: ConnectionEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  emit(event: ConnectionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  failWith(reason: string): void {
    this.connectResult = err(reason)
  }
}

export class FakeChatPort implements ChatPort {
  connected = true
  readonly said: string[] = []
  readonly whispered: { player: string; text: string }[] = []
  private listeners: ((message: IncomingChat) => void)[] = []

  say(text: string): Result<void> {
    if (!this.connected) return err('Not connected to a Minecraft world.')
    this.said.push(text)
    return ok(undefined)
  }

  whisper(player: string, text: string): Result<void> {
    if (!this.connected) return err('Not connected to a Minecraft world.')
    this.whispered.push({ player, text })
    return ok(undefined)
  }

  onMessage(listener: (message: IncomingChat) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  receive(message: IncomingChat): void {
    for (const listener of this.listeners) listener(message)
  }
}

export class FakeVitals implements VitalsReader {
  vitals: Vitals | undefined

  read(): Vitals | undefined {
    return this.vitals
  }
}

export class FakeLanDiscovery implements LanDiscovery {
  world: LanWorld | undefined
  readonly calls: LanDiscoveryOptions[] = []

  discover(options: LanDiscoveryOptions): Promise<LanWorld | undefined> {
    this.calls.push(options)
    return Promise.resolve(this.world)
  }
}
