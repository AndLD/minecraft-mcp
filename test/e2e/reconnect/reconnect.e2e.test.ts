import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals'
import type { BotHolder } from '../../../src/bot/bot-like.types.js'
import { dataOf } from '../support/app-under-test.js'
import { E2EWorld } from '../support/e2e-world.js'
import { readServerInfo, type ServerInfo } from '../support/server-config.js'
import { startSession, type E2ESession } from '../support/session.js'
import { waitUntil } from '../support/wait.js'

describe('losing the connection on a real Minecraft server', () => {
  let info: ServerInfo
  let world: E2EWorld
  let session: E2ESession

  beforeAll(async () => {
    info = readServerInfo()
    world = await E2EWorld.connect(info)
    await world.setGameRule('doDaylightCycle', false)
    await world.setGameRule('doMobSpawning', false)
    await world.setTime('day')
  })

  beforeEach(async () => {
    session = await startSession(world, info, { appConfig: { reconnectAttempts: 3 } })
  })

  afterEach(async () => {
    await session.close()
  })

  afterAll(async () => {
    await world.close()
  })

  const state = async (): Promise<string> =>
    dataOf<{ state: string }>(await session.bot.call('get_status')).state

  const eventTypes = async (): Promise<string[]> => {
    const heard = await session.bot.call('wait_for_chat', { timeout_seconds: 1 })
    return dataOf<{ events: { type: string }[] }>(heard).events.map((event) => event.type)
  }

  it('drops the running task, rejoins by itself, and is usable again', async () => {
    const started = await session.bot.call('goto', { x: 40, y: 64, z: 40, wait_seconds: 0 })
    expect(started.isError).toBe(false)

    // The connection breaks without the agent asking for it (the socket goes away).
    const holder = session.bot.app.connection as unknown as BotHolder
    holder.current()?.quit('the test pulled the plug')

    await waitUntil(async () => ((await state()) === 'disconnected' ? true : undefined), {
      description: 'the app to notice the lost connection',
    })
    const task = dataOf<{ task: { status: string } | null }>(
      await session.bot.call('get_task_status'),
    ).task
    expect(task?.status ?? 'none').not.toBe('running')

    await waitUntil(async () => ((await state()) === 'connected' ? true : undefined), {
      timeoutMs: 40_000,
      description: 'the bot to rejoin',
    })
    // `reconnected` follows `connected` a moment later (the world's saved state is opened first), so collect events
    // until it arrives instead of reading them once.
    const seen: string[] = []
    await waitUntil(
      async () => {
        seen.push(...(await eventTypes()))
        return seen.includes('reconnected') ? true : undefined
      },
      { timeoutMs: 20_000, description: 'the reconnected event' },
    )
    expect(seen).toEqual(expect.arrayContaining(['reconnecting', 'reconnected']))

    // It works again: the owner is in view and a tool call goes through.
    await world.teleport(session.bot.username, { x: -5.5, y: 64, z: -5.5 })
    await waitUntil(
      async () => {
        const owner = await session.bot.call('get_player_position')
        return !owner.isError && (owner.data as { visible: boolean }).visible ? true : undefined
      },
      { description: 'the bot to see its owner again' },
    )
  }, 120_000)

  it('does not rejoin after it was kicked', async () => {
    await world.command(`kick ${session.bot.username} testing`)

    await waitUntil(async () => ((await state()) === 'disconnected' ? true : undefined), {
      description: 'the bot to be kicked',
    })
    const seen = await eventTypes()
    expect(seen).toContain('kicked')
    expect(seen).not.toContain('reconnecting')
    await new Promise((resolve) => setTimeout(resolve, 9_000)) // longer than the first retry delay
    expect(await state()).toBe('disconnected')
    // Nothing is trying to rejoin, so listening for chat fails instead of waiting.
    expect((await session.bot.call('wait_for_chat', { timeout_seconds: 1 })).isError).toBe(true)
  }, 60_000)
})
