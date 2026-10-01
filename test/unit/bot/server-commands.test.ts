import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { classifyReply } from '../../../src/bot/command-reply.js'
import { commandNamesFrom } from '../../../src/bot/command-tree.js'
import { MineflayerServerCommands } from '../../../src/bot/mineflayer-server-commands.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

describe('commandNamesFrom', () => {
  it('lists the children of the root node', () => {
    const packet = {
      rootIndex: 0,
      nodes: [
        { children: [1, 2] },
        { children: [], extraNodeData: { name: 'tp' } },
        { children: [], extraNodeData: { name: 'gamemode' } },
        { children: [], extraNodeData: { name: 'not_a_command' } },
      ],
    }

    expect(commandNamesFrom(packet)).toEqual(['tp', 'gamemode'])
  })

  it('skips children without a name', () => {
    expect(
      commandNamesFrom({ rootIndex: 0, nodes: [{ children: [1, 5] }, { children: [] }] }),
    ).toEqual([])
  })

  it.each([
    undefined,
    null,
    'x',
    {},
    { nodes: [] },
    { nodes: [{}], rootIndex: 0 },
    { nodes: 3, rootIndex: 0 },
  ])('gives up on a packet of the wrong shape (%j)', (packet) => {
    expect(commandNamesFrom(packet)).toBeUndefined()
  })
})

describe('classifyReply', () => {
  it.each([
    ['Teleported ClaudeBot to Andrey_Knight', 'ok'],
    ['Teleported ClaudeBot to 10.0, 64.0, 10.0', 'ok'],
    ["I'm sorry, but you do not have permission to perform this command.", 'no_permission'],
    ['No entity was found', 'error'],
    ['Invalid position for teleport', 'error'],
    ['That position is outside the world border', 'error'],
    ['Could not teleport: the target is not loaded', 'error'],
  ])('"%s" is %s', (reply, kind) => {
    expect(classifyReply(reply, true).kind).toBe(kind)
  })

  it('reads "unknown command" as no permission when the command is not on the server\'s list', () => {
    expect(classifyReply('Unknown or incomplete command, see below for error', false).kind).toBe(
      'no_permission',
    )
    expect(classifyReply('Unknown or incomplete command, see below for error', true).kind).toBe(
      'unknown_command',
    )
    expect(classifyReply('Unknown command. Type "/help" for help.', undefined).kind).toBe(
      'unknown_command',
    )
  })

  it('keeps the text, trimmed', () => {
    expect(classifyReply('  Teleported  ', true)).toEqual({ kind: 'ok', reply: 'Teleported' })
  })
})

class Holder implements BotHolder {
  bot: BotLike | undefined
  current(): BotLike | undefined {
    return this.bot
  }
  onChange(): () => void {
    return () => undefined
  }
}

function setup() {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const holder = new Holder()
  const bot = new FakeBot()
  holder.bot = bot
  return {
    clock,
    scheduler,
    holder,
    bot,
    commands: new MineflayerServerCommands(holder, scheduler),
  }
}
const live = () => new AbortController().signal

describe('MineflayerServerCommands', () => {
  it('knows what the server offers only once the list has arrived', () => {
    const { bot, commands } = setup()
    expect(commands.available('tp')).toBeUndefined()

    Object.assign(bot, { commandNames: ['gamemode'] })
    expect(commands.available('tp')).toBe(false)

    Object.assign(bot, { commandNames: ['gamemode', 'tp'] })
    expect(commands.available('tp')).toBe(true)
  })

  it('has no answer without a bot', async () => {
    const { holder, commands } = setup()
    holder.bot = undefined

    expect(commands.available('tp')).toBeUndefined()
    expect(await commands.run('tp @s 1 2 3', { signal: live() })).toMatchObject({
      ok: false,
      error: { reason: 'not_connected' },
    })
  })

  it("types the command with a slash and returns the server's reply", async () => {
    const { bot, commands } = setup()
    Object.assign(bot, { commandNames: ['tp'] })

    const pending = commands.run('tp @s Andrey_Knight', { signal: live() })
    bot.emit('messagestr', 'Teleported ClaudeBot to Andrey_Knight')

    expect(bot.chatLog).toEqual(['/tp @s Andrey_Knight'])
    expect(await pending).toEqual({
      ok: true,
      value: { kind: 'ok', reply: 'Teleported ClaudeBot to Andrey_Knight' },
    })
    expect(bot.listenerCount('messagestr')).toBe(0)
  })

  it("ignores other players' chat while waiting, and sorts the reply", async () => {
    const { bot, commands } = setup()
    Object.assign(bot, { commandNames: [] })

    const pending = commands.run('tp @s 1 2 3', { signal: live() })
    bot.emit('messagestr', '<Andrey_Knight> hello')
    bot.emit('messagestr', 'Unknown or incomplete command, see below for error')

    expect(await pending).toEqual({
      ok: true,
      value: {
        kind: 'no_permission',
        reply: 'Unknown or incomplete command, see below for error',
      },
    })
  })

  it('says "sent" when the server stays quiet', async () => {
    const { bot, commands, scheduler } = setup()

    const pending = commands.run('tp @s 1 2 3', { signal: live(), timeoutMs: 2_000 })
    scheduler.advance(1_999)
    bot.emit('messagestr', '<Andrey_Knight> still there?')
    scheduler.advance(1)

    expect(await pending).toEqual({ ok: true, value: { kind: 'sent' } })
    expect(bot.listenerCount('messagestr')).toBe(0)
  })

  it('stops waiting when cancelled, and does not send when already cancelled', async () => {
    const { bot, commands } = setup()
    const controller = new AbortController()

    const pending = commands.run('tp @s 1 2 3', { signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, error: { reason: 'aborted' } })
    expect(bot.listenerCount('messagestr')).toBe(0)

    bot.chatLog.length = 0
    expect(await commands.run('tp @s 1 2 3', { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { reason: 'aborted' },
    })
    expect(bot.chatLog).toEqual([])
  })
})
