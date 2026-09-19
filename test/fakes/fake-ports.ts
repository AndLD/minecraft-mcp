import type {
  BlockInfo,
  BlockQuery,
  BlockScanner,
  BlockSummary,
} from '../../src/core/block-scanner.port.js'
import type { ChatPort, IncomingChat } from '../../src/core/chat.port.js'
import type { EntityInfo, EntityScanner, PlayerInfo } from '../../src/core/entity-scanner.port.js'
import type { InventoryReader, InventorySnapshot } from '../../src/core/inventory.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import type { Position } from '../../src/core/position.types.js'
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

export class FakeBlockScanner implements BlockScanner {
  names: string[] = ['stone', 'dirt', 'oak_log', 'iron_ore', 'crafting_table']
  blocks: BlockInfo[] = []
  summaries: BlockSummary[] = []
  blockNames = new Map<string, string>()
  readonly queries: BlockQuery[] = []

  knownBlockNames(): readonly string[] {
    return this.names
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    this.queries.push(query)
    return this.blocks.filter((b) => query.names.includes(b.name)).slice(0, query.count)
  }

  blockAt(position: Position): string | undefined {
    return this.blockNames.get(`${String(position.x)},${String(position.y)},${String(position.z)}`)
  }

  sampleBlocks(): readonly BlockSummary[] {
    return this.summaries
  }
}

export class FakeEntityScanner implements EntityScanner {
  entities: EntityInfo[] = []
  players = new Map<string, PlayerInfo>()

  nearby(maxDistance: number): readonly EntityInfo[] {
    return this.entities.filter((e) => e.distance <= maxDistance)
  }

  player(name: string): PlayerInfo | undefined {
    return this.players.get(name.toLowerCase())
  }
}

export class FakeInventory implements InventoryReader {
  value: InventorySnapshot | undefined

  snapshot(): InventorySnapshot | undefined {
    return this.value
  }
}

/** A navigator whose trips finish only when the test says so, and which honors the abort signal. */
export class FakeNavigator implements Navigator {
  readonly calls: { kind: string; target: unknown; within: number }[] = []
  private pending: { finish: (result: NavResult) => void }[] = []

  goToPosition(target: Position, within: number, options: NavigationOptions): Promise<NavResult> {
    return this.trip({ kind: 'position', target, within }, options)
  }

  goToPlayer(player: string, within: number, options: NavigationOptions): Promise<NavResult> {
    return this.trip({ kind: 'player', target: player, within }, options)
  }

  async follow(player: string, distance: number, options: NavigationOptions) {
    this.calls.push({ kind: 'follow', target: player, within: distance })
    await new Promise<void>((resolve) => {
      options.signal.addEventListener('abort', () => {
        resolve()
      })
      this.pending.push({
        finish: () => {
          resolve()
        },
      })
    })
    return ok(undefined)
  }

  /** Completes the oldest running trip successfully at `position`. */
  arrive(position: Position): void {
    this.pending.shift()?.finish(ok(position))
  }

  /** Completes the oldest running trip with a failure. */
  fail(failure: NavigationFailure): void {
    this.pending.shift()?.finish(err(failure))
  }

  private trip(
    call: { kind: string; target: unknown; within: number },
    options: NavigationOptions,
  ): Promise<NavResult> {
    this.calls.push(call)
    return new Promise<NavResult>((resolve) => {
      if (options.signal.aborted) {
        resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
        return
      }
      options.signal.addEventListener('abort', () => {
        resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
      })
      this.pending.push({ finish: resolve })
    })
  }
}

type NavResult = Result<Position, NavigationFailure>
