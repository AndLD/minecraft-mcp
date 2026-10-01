import { afterEach, describe, expect, it } from '@jest/globals'
import { FakeBot } from '../fakes/fake-bot.js'
import { createHarness, type Harness } from './support/app-harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close().catch(() => undefined)
  harness = undefined
})

const HERE = { x: 10, y: 64, z: -5 }
const FAR = { x: 200, y: 64, z: 300 }

/** A flat floor at the bot's place and around the player far away, and a server that obeys /tp when it may. */
async function start(options: {
  commands: string[] | undefined
  reply?: string
}): Promise<Harness> {
  const bot = new FakeBot().useGameData()
  for (const centre of [HERE, FAR])
    for (let x = centre.x - 6; x <= centre.x + 6; x += 1)
      for (let z = centre.z - 6; z <= centre.z + 6; z += 1) {
        bot.setBlock({ x, y: 63, z }, 'dirt')
        for (let y = 64; y <= 67; y += 1) bot.setBlock({ x, y, z }, 'air')
      }
  bot.players['Andrey_Knight'] = {
    username: 'Andrey_Knight',
    entity: { id: 900, type: 'player', name: 'Andrey_Knight', position: FAR },
  }
  Object.assign(bot, { commandNames: options.commands })
  bot.chat = (message: string) => {
    bot.chatLog.push(message)
    if (!message.startsWith('/tp @s ')) return
    const target = message.slice('/tp @s '.length)
    if (options.reply !== undefined) {
      bot.emit('messagestr', options.reply)
      return
    }
    const to =
      target === 'Andrey_Knight'
        ? FAR
        : (() => {
            const [x, y, z] = target.split(' ').map(Number)
            return { x: x ?? 0, y: y ?? 0, z: z ?? 0 }
          })()
    bot.entity = { position: to }
    bot.emit('messagestr', `Teleported ClaudeBot to ${target}`)
  }
  const h = await createHarness({}, { bot })
  harness = h
  const connected = await h.call('connect', { port: 34231 })
  if (connected.isError) throw new Error(connected.text)
  await h.call('wait_for_chat', { timeout_seconds: 1 })
  return h
}

async function pumped<T>(h: Harness, promise: Promise<T>): Promise<T> {
  const state = { done: false }
  const tracked = promise.finally(() => {
    state.done = true
  })
  while (!state.done) {
    h.scheduler.advance(250)
    await h.settle()
  }
  return tracked
}

describe('teleporting through the MCP server', () => {
  it('"teleport to me": the bot appears next to the player and stands on solid ground', async () => {
    const h = await start({ commands: ['tp'] })

    const result = await pumped(h, h.call('teleport_to_player', { wait_seconds: 20 }))

    expect(result.data).toMatchObject({ status: 'succeeded' })
    expect(h.bot.chatLog).toEqual(['/tp @s Andrey_Knight'])
    const at = h.bot.entity?.position ?? HERE
    expect(Math.hypot(at.x - FAR.x, at.z - FAR.z)).toBeLessThan(3)
    expect(at.y).toBe(64)
  })

  it('teleports to coordinates', async () => {
    const h = await start({ commands: ['tp'] })

    const result = await pumped(
      h,
      h.call('teleport_to_position', { x: 205, y: 64, z: 302, wait_seconds: 20 }),
    )

    expect(result.data).toMatchObject({
      status: 'succeeded',
      result: { arrivedAt: { x: 205, y: 64, z: 302 } },
    })
  })

  it('says exactly what to enable when the server does not offer the command, and does not try', async () => {
    const h = await start({ commands: ['gamemode'] })

    const result = await pumped(h, h.call('teleport_to_player', { wait_seconds: 20 }))

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Allow cheats')
    expect(result.text).toContain('/op TestBot')
    expect(h.bot.chatLog).toEqual([])
  })

  it('reports what the server said when it refuses in words', async () => {
    const h = await start({
      commands: ['tp'],
      reply: 'That position is outside the world border',
    })

    const result = await pumped(
      h,
      h.call('teleport_to_position', { x: 9_999_999, y: 64, z: 0, wait_seconds: 20 }),
    )

    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside the world border')
    expect(result.text).toContain('teleport_failed')
  })

  it('get_status says whether teleporting is possible', async () => {
    const allowed = await start({ commands: ['tp'] })
    expect((await allowed.call('get_status')).data).toMatchObject({
      commands: { canTeleport: true },
    })
    await allowed.close()

    const denied = await start({ commands: ['gamemode'] })
    expect((await denied.call('get_status')).data).toMatchObject({
      commands: { canTeleport: false },
    })
    await denied.close()

    const unknown = await start({ commands: undefined })
    expect((await unknown.call('get_status')).data).toMatchObject({
      commands: { canTeleport: null },
    })
  })
})
