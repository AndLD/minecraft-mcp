import { afterEach, describe, expect, it } from '@jest/globals'
import { createHarness, type Harness } from './support/app-harness.js'
import { announcement } from '../fakes/fake-socket.js'

let harness: Harness | undefined

async function start(
  config: Parameters<typeof createHarness>[0] = {},
  options: Parameters<typeof createHarness>[1] = {},
): Promise<Harness> {
  harness = await createHarness(config, options)
  return harness
}

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('MCP server over an in-memory transport', () => {
  it('lists the tools with descriptions and JSON schemas', async () => {
    const { client } = await start()

    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'cancel_task',
        'connect',
        'disconnect',
        'discard_interrupted_task',
        'find_blocks',
        'follow_player',
        'forget',
        'get_inventory',
        'get_nearby_entities',
        'get_player_position',
        'get_recent_history',
        'get_session_briefing',
        'get_status',
        'get_task_status',
        'give_items',
        'drop_items',
        'edit_sign',
        'resolve_item',
        'deposit_items',
        'find_items',
        'label_container',
        'list_containers',
        'list_death_records',
        'list_storage_rules',
        'register_container',
        'remove_container',
        'remove_sign',
        'remove_storage_rule',
        'resume_task',
        'scan_containers',
        'set_storage_policy',
        'set_storage_rule',
        'withdraw_items',
        'attack_entity',
        'hunt_animals',
        'list_huntable_animals',
        'set_drop_recovery_policy',
        'set_food_policy',
        'collect_block',
        'craft',
        'list_protected_areas',
        'list_recipes',
        'pickup_items',
        'protect_area',
        'read_signs',
        'smelt',
        'unprotect_area',
        'goto',
        'list_worlds',
        'look_around',
        'recall',
        'recover_drops',
        'remember',
        'remove_standing_instruction',
        'resume_interrupted_task',
        'say',
        'skip_drop_recovery',
        'set_standing_instruction',
        'set_world_profile',
        'stop',
        'excavate',
        'preview_excavation',
        'list_excavations',
        'flatten_area',
        'preview_flatten',
        'build',
        'preview_build',
        'list_blueprints',
        'place_block',
        'teleport_to_player',
        'teleport_to_position',
        'wait_for_chat',
        'whisper',
        'press_switch',
        'open_door',
        'find_switches',
        'set_switch_policy',
        'build_farm',
        'plant_crops',
        'harvest_crops',
        'lure_animals',
        'breed_animals',
        'shear_sheep',
        'milk_cows',
        'fertilize_crops',
        'use_composter',
        'collect_eggs',
        'plant_trees',
        'collect_saplings',
        'harvest_trees',
        'set_egg_policy',
        'tend_farm',
        'inspect_farm',
        'plan_railway',
        'build_railway',
        'place_minecart',
        'fill_bucket',
        'break_block',
        'place_sign',
        'sleep',
        'set_respawn_point',
        'place_bed',
        'list_beds',
        'set_sleep_policy',
        'discover_farm',
        'list_farms',
        'explore_for_structure',
        'list_known_structures',
        'set_landmark',
        'list_landmarks',
        'explore_caves',
        'lead_player',
        'fish',
        'organize_storage',
        'remove_landmark',
        'register_farm',
      ].sort(),
    )
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
    const wait = tools.find((t) => t.name === 'wait_for_chat')
    expect(wait?.inputSchema.properties).toMatchObject({
      timeout_seconds: { maximum: 55, minimum: 1 },
    })
  })

  it('reports a disconnected bot before connecting', async () => {
    const h = await start()

    const status = await h.call('get_status')

    expect(status.data).toMatchObject({ state: 'disconnected', target: null, vitals: null })
  })

  it('refuses to wait for chat before connecting', async () => {
    const h = await start()

    const result = await h.call('wait_for_chat', { timeout_seconds: 1 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Call connect first')
  })

  it('rejects invalid arguments with a readable error', async () => {
    const h = await start()

    const result = await h.call('connect', { port: 99999 })

    expect(result.isError).toBe(true)
  })

  describe('connected', () => {
    async function connected(config: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
      const h = await start(config)
      const result = await h.call('connect', { port: 34231 })
      expect(result.isError).toBe(false)
      return h
    }

    it('connects to the given port and reports the session', async () => {
      const h = await start()

      const result = await h.call('connect', { port: 34231 })

      expect(result.data).toMatchObject({
        connected: true,
        username: 'ClaudeBot',
        version: '1.21.1',
        host: 'localhost',
        port: 34231,
        briefing: { world: { profile: 'world-a1b2c3' } },
      })
      expect(h.connectTargets).toEqual([{ host: 'localhost', port: 34231 }])
    })

    it('reports the target, vitals, and pending items in get_status', async () => {
      const h = await connected()

      const status = await h.call('get_status')

      expect(status.data).toMatchObject({
        state: 'connected',
        target: { host: 'localhost', port: 34231, username: 'TestBot' },
        vitals: {
          health: 20,
          food: 20,
          position: { x: 10, y: 64, z: -5 },
          dimension: 'overworld',
          timeOfDay: 6000,
        },
        pendingInbox: 1,
      })
    })

    it('tells the agent it joined through the event stream', async () => {
      const h = await connected()

      const result = await h.call('wait_for_chat', { timeout_seconds: 1 })

      expect(result.data).toMatchObject({ timedOut: false, events: [{ type: 'connected' }] })
    })

    it('delivers the owner’s chat to wait_for_chat', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      h.bot.emit('chat', 'Andrey_Knight', 'come here')
      const result = await h.call('wait_for_chat', { timeout_seconds: 1 })

      expect(result.data).toMatchObject({
        timedOut: false,
        messages: [
          {
            sender: 'Andrey_Knight',
            text: 'come here',
            whisper: false,
            at: '2026-09-19T12:00:00.000Z',
          },
        ],
      })
    })

    it('ignores chat from other players and from the bot itself', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      h.bot.emit('chat', 'Stranger', 'give me stuff')
      h.bot.emit('chat', 'ClaudeBot', 'my own words')

      expect((await h.call('get_status')).data).toMatchObject({ pendingInbox: 0 })
    })

    it('waits until the owner speaks', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      const pending = h.call('wait_for_chat', { timeout_seconds: 30 })
      await h.settle()
      h.bot.emit('whisper', 'Andrey_Knight', 'psst')

      expect((await pending).data).toMatchObject({ messages: [{ text: 'psst', whisper: true }] })
    })

    it('times out with nothing new', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      const pending = h.call('wait_for_chat', { timeout_seconds: 5 })
      await h.settle()
      h.scheduler.advance(5000)

      expect((await pending).data).toEqual({ timedOut: true, messages: [], events: [], dropped: 0 })
    })

    it('handles "stop" in code and only notes it as an event', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      h.bot.emit('chat', 'Andrey_Knight', 'stop')
      const result = await h.call('wait_for_chat', { timeout_seconds: 1 })

      expect(result.data).toMatchObject({ messages: [], events: [{ type: 'command' }] })
    })

    it('says and whispers in game', async () => {
      const h = await connected()

      const said = await h.call('say', { text: 'Hello, world!' })
      const whispered = await h.call('whisper', { player: 'Andrey_Knight', text: 'psst' })

      expect(said.data).toEqual({ sent: 1, truncated: false })
      expect(whispered.data).toEqual({ sent: 1, player: 'Andrey_Knight' })
      expect(h.bot.chatLog).toEqual(['Hello, world!'])
      expect(h.bot.whisperLog).toEqual([{ player: 'Andrey_Knight', text: 'psst' }])
    })

    it('reports runtime connection errors as events without disconnecting', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      h.bot.emit('error', new Error('packet problem'))
      const result = await h.call('wait_for_chat', { timeout_seconds: 1 })

      expect(result.data).toMatchObject({
        events: [{ type: 'error', message: 'Connection error: packet problem' }],
      })
      expect((await h.call('get_status')).data).toMatchObject({ state: 'connected' })
    })

    it('refuses to connect twice', async () => {
      const h = await connected()

      const again = await h.call('connect', { port: 34231 })

      expect(again.isError).toBe(true)
      expect(again.text).toContain('Already connected')
    })

    it('reports being kicked and disconnected, then refuses to wait', async () => {
      const h = await connected()
      await h.call('wait_for_chat', { timeout_seconds: 1 })

      h.bot.emit('kicked', 'Flying is not enabled')
      h.bot.emit('end', 'disconnect.quitting')
      const events = await h.call('wait_for_chat', { timeout_seconds: 1 })
      const after = await h.call('wait_for_chat', { timeout_seconds: 1 })

      expect(events.data).toMatchObject({ events: [{ type: 'kicked' }, { type: 'disconnected' }] })
      expect(after.isError).toBe(true)
      expect((await h.call('get_status')).data).toMatchObject({ state: 'disconnected' })
    })

    it('disconnects on request and can reconnect', async () => {
      const h = await connected()

      const result = await h.call('disconnect')
      const status = await h.call('get_status')
      const again = await h.call('connect', { port: 34231 })

      expect(result.data).toEqual({ disconnected: true, wasConnected: true })
      expect(status.data).toMatchObject({ state: 'disconnected' })
      expect(again.isError).toBe(false)
    })

    it('reports a failed connection with the reason and allows a retry', async () => {
      const h = await start({}, { autoSpawn: false })

      const pending = h.call('connect', { port: 1 })
      await h.settle()
      h.bot.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'))
      const failed = await pending

      expect(failed.isError).toBe(true)
      expect(failed.text).toContain('ECONNREFUSED')
      expect((await h.call('get_status')).data).toMatchObject({ state: 'disconnected' })
    })
  })

  describe('LAN discovery', () => {
    it('finds the port and world name from the announcement', async () => {
      const h = await start({ port: undefined })

      const pending = h.call('connect')
      await h.settle()
      h.socket.receive(announcement('Andrey_Knight - AI bot test world', 34231))
      const result = await pending

      expect(result.data).toMatchObject({
        connected: true,
        port: 34231,
        worldName: 'AI bot test world',
      })
      expect(h.connectTargets).toEqual([{ host: 'localhost', port: 34231 }])
      expect(h.socket.closed).toBe(true)
    })

    it('explains what to do when the world is not announced', async () => {
      const h = await start({ port: undefined })

      const pending = h.call('connect')
      await h.settle()
      h.scheduler.advance(4000)
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.text).toContain('Open to LAN')
    })
  })

  it('disconnects the bot when the app shuts down', async () => {
    const h = await start()
    await h.call('connect', { port: 34231 })

    await h.app.shutdown()

    expect(h.bot.quitCalls).toBe(1)
  })
})
