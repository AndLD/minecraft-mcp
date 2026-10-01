import { describe, expect, it } from '@jest/globals'
import { WorldKnowledgeStore } from '../../src/knowledge/world-knowledge-store.js'
import { TaskLauncher } from '../../src/mcp/task-launcher.js'
import { LeadPlayerTool } from '../../src/mcp/tools/lead-player-tool.js'
import { LeadPlayerSkill } from '../../src/skills/movement/lead-player-skill.js'
import { LeadTargetResolver } from '../../src/skills/movement/lead-target.js'
import { ContainerIndex } from '../../src/state/container-index.js'
import { FarmRegistry } from '../../src/state/farm-registry.js'
import { TaskManager } from '../../src/tasks/task-manager.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { FakeLogger } from '../fakes/fake-logger.js'
import { FakeChatPort } from '../fakes/fake-ports.js'
import { FakeScheduler } from '../fakes/fake-scheduler.js'
import { LeadWorld } from '../fakes/lead-fakes.js'
import { InMemoryStateStore } from '../fakes/state-fakes.js'

/** "Come to me and lead me to the village", through the tool layer, with a player who lags and wanders. */
describe('leading a player through the tool layer', () => {
  it('brings a wandering, lagging player to the village that was found earlier', async () => {
    const world = new LeadWorld()
    world.bot = { x: 0, y: 64, z: 0 }
    world.playerAt = { x: 25, y: 64, z: 25 }
    world.behaviour = { kind: 'follow', speed: 2 }
    let wandered = false
    world.onTime = (w) => {
      if (!wandered && w.bot.x > 30) {
        wandered = true
        w.behaviour = { kind: 'walk', dx: 0, dz: -1, speed: 2 }
      }
      if (wandered && w.playerAt !== undefined && w.playerAt.z < 5)
        w.behaviour = { kind: 'follow', speed: 2 }
    }

    const clock = new FakeClock(0)
    const tasks = new TaskManager({
      clock,
      scheduler: new FakeScheduler(clock),
      logger: new FakeLogger(),
    })
    const store = new InMemoryStateStore()
    const knowledge = new WorldKnowledgeStore(clock)
    const containers = new ContainerIndex(clock)
    const farms = new FarmRegistry(clock)
    await knowledge.attach(store)
    await containers.attach(store)
    await farms.attach(store)
    knowledge.record('village', { x: 90, y: 64, z: 0 }, { source: 'scan' })
    const chat = new FakeChatPort()
    const tool = new LeadPlayerTool(
      new LeadPlayerSkill({
        navigator: world,
        entities: world,
        vitals: world,
        gaze: world,
        chat,
        scheduler: world.scheduler,
        clock: world.clock,
      }),
      new TaskLauncher(tasks, clock),
      new LeadTargetResolver({ knowledge, containers, farms, vitals: world }),
      world,
      'Steve',
    )

    const result = await tool.execute(tool.inputSchema.parse({ target: 'the village' }), {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ ok: true, data: { status: 'succeeded' } })
    expect(Math.hypot(world.bot.x - 90, world.bot.z)).toBeLessThanOrEqual(8)
    expect(chat.said.at(-1)).toContain('We are at the village')
    expect(chat.said).toContain('Follow me to the village')
    expect(world.maxSeparation).toBeLessThan(8 * 3)
  })
})
