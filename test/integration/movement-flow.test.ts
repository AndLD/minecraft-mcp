import { afterEach, describe, expect, it } from '@jest/globals'
import { toVec3 } from '../../src/bot/vec3.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function connected(config: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = await createHarness(config)
  harness = h
  await h.call('connect', { port: 34231 })
  await h.call('wait_for_chat', { timeout_seconds: 1 }) // drain the "joined" event
  return h
}

const taskOf = (result: { data: unknown }): Record<string, unknown> =>
  result.data as Record<string, unknown>

describe('movement through the MCP server', () => {
  describe('goto', () => {
    it('walks to coordinates and returns the finished task', async () => {
      const h = await connected()

      const pending = h.call('goto', { x: 20, y: 64, z: -5, wait_seconds: 10 })
      await h.settle()
      h.bot.entity = { position: { x: 19, y: 64, z: -5 } }
      h.bot.pathfinder.arrive()
      const result = await pending

      expect(h.bot.pathfinder.gotoGoals).toEqual([{ kind: 'near', x: 20, y: 64, z: -5, range: 2 }])
      expect(result.data).toMatchObject({
        status: 'succeeded',
        result: { arrivedAt: { x: 19, y: 64, z: -5 } },
      })
    })

    it('returns "running" when the wait budget is used up, then completes in the background', async () => {
      const h = await connected()

      const pending = h.call('goto', { x: 200, y: 64, z: 0, wait_seconds: 5 })
      await h.settle()
      h.bot.entity = { position: { x: 60, y: 64, z: 0 } }
      h.scheduler.advance(5000)
      const running = await pending

      expect(running.data).toMatchObject({ status: 'running', taskId: 'task-1' })
      const status = await h.call('get_task_status')
      expect(taskOf(status).task).toMatchObject({
        status: 'running',
        progress: expect.stringContaining('blocks to go'),
      })

      h.bot.entity = { position: { x: 199, y: 64, z: 0 } }
      h.bot.pathfinder.arrive()
      await h.settle()
      expect(taskOf(await h.call('get_task_status')).task).toMatchObject({ status: 'succeeded' })
    })

    it('can walk again right after a trip finished (regression: no stale stop request)', async () => {
      const h = await connected()

      const first = h.call('goto', { x: 10, y: 64, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()
      await first

      const second = h.call('goto', { x: 30, y: 64, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()

      expect((await second).data).toMatchObject({ status: 'succeeded' })
      expect(h.bot.pathfinder.stopCalls).toBe(0)
    })

    it('can walk again after an unreachable target', async () => {
      const h = await connected()
      const first = h.call('goto', { x: 1, y: -50, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.failWith('NoPath')
      expect((await first).isError).toBe(true)

      const second = h.call('goto', { x: 30, y: 64, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()

      expect((await second).data).toMatchObject({ status: 'succeeded' })
    })

    it('can walk again after following a player and stopping (regression: stale stop request)', async () => {
      const h = await connected()
      h.bot.players['Andrey_Knight'] = {
        username: 'Andrey_Knight',
        entity: {
          id: 9,
          type: 'player',
          username: 'Andrey_Knight',
          position: { x: 4, y: 64, z: 4 },
        },
      }
      const started = h.call('follow_player', { wait_seconds: 0 })
      await h.settle()
      await started
      await h.call('stop')

      const next = h.call('goto', { x: 30, y: 64, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()

      expect((await next).data).toMatchObject({ status: 'succeeded' })
    })

    it('can walk again after a cancelled trip', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()
      await h.call('stop')

      const next = h.call('goto', { x: 30, y: 64, z: 0, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()

      expect((await next).data).toMatchObject({ status: 'succeeded' })
    })

    it('reports an unreachable target with the reason', async () => {
      const h = await connected()

      const pending = h.call('goto', { x: 1, y: 2, z: 3 })
      await h.settle()
      h.bot.pathfinder.failWith('NoPath')
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.text).toContain('(reason: unreachable)')
    })

    it('opens a closed door in the way, walks through, and closes it behind the bot', async () => {
      const h = await connected()
      h.bot.registry = { ...h.bot.registry, blocksByName: { ...h.bot.registry.blocksByName, oak_door: { id: 900 } } }
      const doorAt = { x: 5, y: 64, z: 5 }
      h.bot.setBlock(doorAt, 'oak_door')

      const pending = h.call('goto', { x: 10, y: 64, z: 10, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.failWith('NoPath') // the closed door blocks the first attempt
      await h.settle()

      expect(h.bot.activateBlockCalls).toEqual([doorAt]) // opened once, so far
      expect(h.bot.blockAt(toVec3(doorAt))?.getProperties?.()).toEqual({ open: true })

      h.bot.pathfinder.arrive() // the retried trip succeeds now that the door is open
      const result = await pending
      await h.settle()

      expect(result.data).toMatchObject({ status: 'succeeded' })
      expect(h.bot.pathfinder.gotoGoals).toHaveLength(2)
      expect(h.bot.activateBlockCalls).toEqual([doorAt, doorAt]) // closed again behind the bot
      expect(h.bot.blockAt(toVec3(doorAt))?.getProperties?.()).toEqual({ open: false })
    })

    it('leaves the door open when close_doors is false', async () => {
      const h = await connected()
      h.bot.registry = { ...h.bot.registry, blocksByName: { ...h.bot.registry.blocksByName, oak_door: { id: 900 } } }
      const doorAt = { x: 5, y: 64, z: 5 }
      h.bot.setBlock(doorAt, 'oak_door')

      const pending = h.call('goto', {
        x: 10,
        y: 64,
        z: 10,
        wait_seconds: 10,
        close_doors: false,
      })
      await h.settle()
      h.bot.pathfinder.failWith('NoPath')
      await h.settle()
      h.bot.pathfinder.arrive()
      const result = await pending

      expect(result.data).toMatchObject({ status: 'succeeded' })
      expect(h.bot.activateBlockCalls).toEqual([doorAt]) // opened, never closed again
      expect(h.bot.blockAt(toVec3(doorAt))?.getProperties?.()).toEqual({ open: true })
    })

    it('reports needs_switch for an iron door instead of trying it', async () => {
      const h = await connected()
      h.bot.registry = { ...h.bot.registry, blocksByName: { ...h.bot.registry.blocksByName, iron_door: { id: 901 } } }
      const doorAt = { x: 5, y: 64, z: 5 }
      h.bot.setBlock(doorAt, 'iron_door')

      const pending = h.call('goto', { x: 10, y: 64, z: 10, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.failWith('NoPath')
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.text).toContain('(reason: needs_switch)')
      expect(h.bot.activateBlockCalls).toEqual([]) // never tried to open it
    })

    it('gives up when the bot is stuck and stops the pathfinder', async () => {
      const h = await connected()

      const pending = h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 30 })
      await h.settle()
      h.scheduler.advance(9000)
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.text).toContain('(reason: stuck)')
      expect(h.bot.pathfinder.stopCalls).toBeGreaterThan(0)
    })

    it('goes to a player', async () => {
      const h = await connected()
      h.bot.players['Andrey_Knight'] = {
        username: 'Andrey_Knight',
        entity: {
          id: 9,
          type: 'player',
          username: 'Andrey_Knight',
          position: { x: 30, y: 64, z: 2 },
        },
      }

      const pending = h.call('goto', { player: 'Andrey_Knight', within: 3, wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()
      await pending

      expect(h.bot.pathfinder.gotoGoals).toEqual([{ kind: 'near', x: 30, y: 64, z: 2, range: 3 }])
    })

    it('goes to the nearest block of a type', async () => {
      const h = await connected()
      h.bot.setBlock({ x: 6, y: 64, z: 0 }, 'oak_log')

      const pending = h.call('goto', { block: 'oak_log', wait_seconds: 10 })
      await h.settle()
      h.bot.pathfinder.arrive()
      const result = await pending

      expect(result.data).toMatchObject({
        status: 'succeeded',
        result: { targetPosition: { x: 6, y: 64, z: 0 } },
      })
    })

    it('refuses invalid targets', async () => {
      const h = await connected()

      const result = await h.call('goto', { x: 1 })

      expect(result.isError).toBe(true)
    })

    it('refuses to start a second task unless told to replace the running one', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()

      const refused = await h.call('goto', { x: 1, y: 64, z: 0, wait_seconds: 0 })
      const replaced = await h.call('goto', { x: 1, y: 64, z: 0, wait_seconds: 0, replace: true })

      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('still running')
      expect(replaced.data).toMatchObject({ taskId: 'task-2', status: 'running' })
    })
  })

  describe('stopping', () => {
    it('the owner saying "stop" in chat cancels the running trip in code, without the agent', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()

      h.bot.emit('chat', 'Andrey_Knight', 'stop')
      await h.settle()

      expect(taskOf(await h.call('get_task_status')).task).toMatchObject({ status: 'cancelled' })
      expect(h.bot.pathfinder.stopCalls).toBeGreaterThan(0)
      expect(h.bot.clearControlStatesCalls).toBeGreaterThan(0)
      const heard = await h.call('wait_for_chat', { timeout_seconds: 1 })
      expect(heard.data).toMatchObject({ messages: [], events: [{ type: 'command' }] })
    })

    it('the stop tool cancels the running task', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()

      const result = await h.call('stop')

      expect(result.data).toMatchObject({ stopped: true, task: { status: 'cancelled' } })
    })

    it('cancel_task cancels by id', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()

      const result = await h.call('cancel_task', { task_id: 'task-1' })

      expect(result.data).toMatchObject({ task: { taskId: 'task-1', status: 'cancelled' } })
    })

    it('a disconnect cancels the running task', async () => {
      const h = await connected()
      void h.call('goto', { x: 100, y: 64, z: 0, wait_seconds: 0 })
      await h.settle()

      h.bot.emit('end', 'socketClosed')
      await h.settle()

      expect(h.app.tasks.get('task-1')?.status).toBe('cancelled')
    })
  })

  describe('follow_player', () => {
    function withPlayer(h: Harness): void {
      h.bot.players['Andrey_Knight'] = {
        username: 'Andrey_Knight',
        entity: {
          id: 9,
          type: 'player',
          username: 'Andrey_Knight',
          position: { x: 4, y: 64, z: 4 },
        },
      }
    }

    it('follows the owner until stopped', async () => {
      const h = await connected()
      withPlayer(h)

      const pending = h.call('follow_player', { distance: 4 })
      await h.settle()
      h.scheduler.advance(2000)
      const started = await pending

      expect(started.data).toMatchObject({ status: 'running', description: 'Follow Andrey_Knight' })
      expect(h.bot.pathfinder.followGoals).toEqual([
        { goal: { kind: 'follow', id: 9, range: 4 }, dynamic: true },
      ])

      const stopped = await h.call('stop')
      expect(stopped.data).toMatchObject({ stopped: true, task: { status: 'cancelled' } })
      expect(h.bot.pathfinder.stopCalls).toBeGreaterThan(0)
    })

    it('fails when the player is not in view', async () => {
      const h = await connected()
      h.bot.players['Andrey_Knight'] = { username: 'Andrey_Knight' }

      const result = await h.call('follow_player')

      expect(result.isError).toBe(true)
      expect(result.text).toContain('not in view')
    })
  })

  describe('perception', () => {
    it('finds blocks nearest first', async () => {
      const h = await connected()
      h.bot.setBlock({ x: 12, y: 64, z: 0 }, 'iron_ore')
      h.bot.setBlock({ x: 5, y: 64, z: 0 }, 'iron_ore')

      const result = await h.call('find_blocks', { names: ['iron_ore'] })

      expect(result.data).toMatchObject({
        count: 2,
        blocks: [{ position: { x: 12, y: 64, z: 0 } }, { position: { x: 5, y: 64, z: 0 } }],
      })
    })

    it('suggests names for an unknown block', async () => {
      const h = await connected()

      const result = await h.call('find_blocks', { names: ['ore'] })

      expect(result.isError).toBe(true)
      expect(result.text).toContain('iron_ore')
    })

    it('looks around', async () => {
      const h = await connected()
      h.bot.setBlock({ x: 10, y: 63, z: -5 }, 'dirt')
      h.bot.setBlock({ x: 11, y: 64, z: -5 }, 'oak_log')
      h.bot.entities['2'] = {
        id: 2,
        type: 'hostile',
        name: 'zombie',
        position: { x: 14, y: 64, z: -5 },
      }

      const result = await h.call('look_around', { radius: 3 })

      expect(result.data).toMatchObject({
        standingOn: 'dirt',
        notableBlocks: [{ name: 'oak_log', count: 1 }],
        terrain: [{ name: 'dirt', count: 1 }],
        entities: [{ name: 'zombie', category: 'hostile', count: 1 }],
      })
    })

    it('lists nearby entities and finds a player', async () => {
      const h = await connected()
      h.bot.entities['2'] = {
        id: 2,
        type: 'animal',
        name: 'cow',
        position: { x: 12, y: 64, z: -5 },
      }
      h.bot.players['Andrey_Knight'] = {
        username: 'Andrey_Knight',
        entity: {
          id: 9,
          type: 'player',
          username: 'Andrey_Knight',
          position: { x: 20, y: 64, z: -5 },
        },
      }

      const entities = await h.call('get_nearby_entities', { radius: 30, category: 'animal' })
      const player = await h.call('get_player_position')

      expect(entities.data).toMatchObject({ total: 1, entities: [{ name: 'cow', distance: 2 }] })
      expect(player.data).toMatchObject({
        player: 'Andrey_Knight',
        visible: true,
        position: { x: 20, y: 64, z: -5 },
        distance: 10,
      })
    })

    it('reads the inventory', async () => {
      const h = await connected()
      h.bot.inventoryItems = [
        { name: 'oak_log', count: 12 },
        { name: 'oak_log', count: 8 },
      ]
      h.bot.emptySlots = 34

      const result = await h.call('get_inventory')

      expect(result.data).toEqual({
        items: [{ name: 'oak_log', count: 20 }],
        stacks: 2,
        emptySlots: 34,
        heldItem: null,
      })
    })

    it('reports the perception tools as failing when disconnected', async () => {
      const h = await connected()
      await h.call('disconnect')

      for (const [name, args] of [
        ['look_around', {}],
        ['find_blocks', { names: ['stone'] }],
        ['get_nearby_entities', {}],
        ['get_inventory', {}],
      ] as const) {
        expect((await h.call(name, args)).isError).toBe(true)
      }
    })
  })
})
