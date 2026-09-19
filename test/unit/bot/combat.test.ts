import { describe, expect, it } from '@jest/globals'
import type { BotHolder, BotLike } from '../../../src/bot/bot-like.types.js'
import { MineflayerCombatDriver, type CombatDriver } from '../../../src/bot/combat-driver.js'
import { attackIntervalMs, chooseArmor, chooseWeapon, weaponScore } from '../../../src/bot/gear.js'
import { MeleeCombatant, STRIKE_DISTANCE } from '../../../src/bot/melee-combatant.js'
import { MineflayerEater } from '../../../src/bot/mineflayer-eater.js'
import { MineflayerFoodCatalog } from '../../../src/bot/mineflayer-food-catalog.js'
import { MineflayerLocomotion } from '../../../src/bot/mineflayer-locomotion.js'
import type { PathDriver, PathHandle } from '../../../src/bot/path-driver.js'
import type { GearReport } from '../../../src/core/combatant.port.js'
import type { Position } from '../../../src/core/position.types.js'
import { FakeBot } from '../../fakes/fake-bot.js'
import { FakeClock } from '../../fakes/fake-clock.js'
import { FakeScheduler } from '../../fakes/fake-scheduler.js'

const holderOf = (bot: BotLike | undefined): BotHolder => ({
  current: () => bot,
  onChange: () => () => undefined,
})
const item = (name: string) => ({ name, count: 1 })

describe('gear selection', () => {
  it('scores swords above axes, and better materials higher', () => {
    expect(weaponScore('diamond_sword')).toBeGreaterThan(weaponScore('iron_sword'))
    expect(weaponScore('wooden_sword')).toBeGreaterThan(weaponScore('netherite_axe'))
    expect(weaponScore('stone_axe')).toBeGreaterThan(0)
    expect(weaponScore('stick')).toBe(0)
    expect(weaponScore(undefined)).toBe(0)
  })

  it('takes the best weapon when it beats what is in hand', () => {
    const items = [item('stone_axe'), item('iron_sword'), item('wooden_sword'), item('apple')]

    expect(chooseWeapon(items, undefined)).toBe('iron_sword')
    expect(chooseWeapon(items, 'wooden_sword')).toBe('iron_sword')
    expect(chooseWeapon(items, 'stick')).toBe('iron_sword')
  })

  it('keeps what is in hand when it is already the best', () => {
    expect(chooseWeapon([item('iron_sword')], 'iron_sword')).toBeUndefined()
    expect(chooseWeapon([item('stone_axe')], 'diamond_sword')).toBeUndefined()
    expect(chooseWeapon([item('apple')], undefined)).toBeUndefined()
  })

  it('puts on the best piece for each empty armor slot', () => {
    const slots = Array.from({ length: 46 }, () => null)

    const choices = chooseArmor(
      [item('leather_helmet'), item('iron_helmet'), item('iron_chestplate'), item('diamond_boots')],
      slots,
    )

    expect(choices).toEqual([
      { item: 'iron_helmet', slot: 'head' },
      { item: 'iron_chestplate', slot: 'torso' },
      { item: 'diamond_boots', slot: 'feet' },
    ])
  })

  it('only swaps armor that is worn when the new piece is better', () => {
    const slots = Array.from({ length: 46 }, () => null) as ({
      name: string
      count: number
    } | null)[]
    slots[5] = item('diamond_helmet')
    slots[6] = item('leather_chestplate')

    const choices = chooseArmor([item('iron_helmet'), item('iron_chestplate')], slots)

    expect(choices).toEqual([{ item: 'iron_chestplate', slot: 'torso' }])
  })

  it.each([
    ['iron_sword', 625],
    ['diamond_axe', 1250],
    ['iron_pickaxe', 833],
    ['trident', 909],
    ['stick', 500],
    [undefined, 250],
  ])('waits %s ms between swings for a %s', (weapon, expected) => {
    expect(attackIntervalMs(weapon)).toBe(expected)
  })
})

describe('MineflayerCombatDriver', () => {
  function driverWith(bot: FakeBot | undefined) {
    const paths: PathDriver & { approached: { id: number; distance: number }[] } = {
      approached: [],
      goNear: () => neverEnding(),
      follow: () => neverEnding(),
      approachEntity(id, distance) {
        this.approached.push({ id, distance })
        return neverEnding()
      },
    }
    return { paths, driver: new MineflayerCombatDriver(holderOf(bot), paths) }
  }
  const neverEnding = (): PathHandle => ({
    outcome: new Promise(() => undefined),
    cancel: () => undefined,
  })

  function botWithZombie(): FakeBot {
    const bot = new FakeBot()
    bot.entity = { position: { x: 0, y: 64, z: 0 } }
    bot.entities['7'] = { id: 7, type: 'hostile', name: 'zombie', position: { x: 3, y: 64, z: 0 } }
    return bot
  }

  it('sees a target until it is gone or invalid', () => {
    const bot = botWithZombie()
    const { driver } = driverWith(bot)

    expect(driver.target(7)?.position).toEqual({ x: 3, y: 64, z: 0 })
    expect(driver.target(8)).toBeUndefined()
    bot.entities['7'] = { id: 7, type: 'hostile', position: { x: 3, y: 64, z: 0 }, isValid: false }
    expect(driver.target(7)).toBeUndefined()
    bot.entities['7'] = { id: 7, type: 'hostile', position: { x: 3, y: 64, z: 0 }, isDead: true }
    expect(driver.target(7)).toBeUndefined() // dying counts as gone: no swinging at a corpse
  })

  it('reports where the bot is, and nothing without a bot', () => {
    expect(driverWith(botWithZombie()).driver.selfPosition()).toEqual({ x: 0, y: 64, z: 0 })
    const none = driverWith(undefined).driver
    expect(none.selfPosition()).toBeUndefined()
    expect(none.target(1)).toBeUndefined()
    expect(none.heldItem()).toBeUndefined()
    none.swing(1)
  })

  it('approaches through the path driver and swings at the entity', () => {
    const bot = botWithZombie()
    const { driver, paths } = driverWith(bot)

    driver.approach(7, 1.8)
    driver.swing(7)
    driver.swing(99)

    expect(paths.approached).toEqual([{ id: 7, distance: 1.8 }])
    expect(bot.attacked).toEqual([7])
  })

  it('reports the item in hand', () => {
    const bot = botWithZombie()
    bot.heldItem = { name: 'iron_sword', count: 1 }

    expect(driverWith(bot).driver.heldItem()).toBe('iron_sword')
  })

  describe('equipBestGear', () => {
    it('equips the best armor and weapon', async () => {
      const bot = botWithZombie()
      bot.inventoryItems = [
        item('iron_helmet'),
        item('leather_helmet'),
        item('iron_sword'),
        item('wooden_sword'),
        item('apple'),
      ]

      const report = await driverWith(bot).driver.equipBestGear()

      expect(report).toEqual({ weapon: 'iron_sword', armor: ['iron_helmet'] })
      expect(bot.equipped).toEqual([
        { itemType: 120, slot: 'head' },
        { itemType: 111, slot: 'hand' },
      ])
    })

    it('keeps the weapon in hand when it is already the best, and reports it', async () => {
      const bot = botWithZombie()
      bot.heldItem = { name: 'diamond_sword', count: 1 }
      bot.inventoryItems = [item('iron_sword')]

      const report = await driverWith(bot).driver.equipBestGear()

      expect(report).toEqual({ weapon: 'diamond_sword', armor: [] })
      expect(bot.equipped).toEqual([])
    })

    it('puts a shield in the empty off hand', async () => {
      const bot = botWithZombie()
      bot.inventoryItems = [item('shield')]

      const report = await driverWith(bot).driver.equipBestGear()

      expect(report).toEqual({ weapon: undefined, armor: ['shield'] })
      expect(bot.equipped).toEqual([{ itemType: 130, slot: 'off-hand' }])
    })

    it('leaves the off hand alone when something is already there', async () => {
      const bot = botWithZombie()
      bot.inventoryItems = [item('shield')]
      bot.slots[45] = item('totem_of_undying')

      const report = await driverWith(bot).driver.equipBestGear()

      expect(report.armor).toEqual([])
      expect(bot.equipped).toEqual([])
    })

    it('carries on when a piece cannot be equipped', async () => {
      const bot = botWithZombie()
      bot.inventoryItems = [item('iron_helmet'), item('iron_sword')]
      bot.failEquip = new Error('cannot equip')

      const report = await driverWith(bot).driver.equipBestGear()

      expect(report).toEqual({ weapon: undefined, armor: [] })
    })

    it('skips items the game does not know', async () => {
      const bot = botWithZombie()
      bot.inventoryItems = [item('netherite_helmet'), item('netherite_sword')] // not in the fake registry

      expect(await driverWith(bot).driver.equipBestGear()).toEqual({ weapon: undefined, armor: [] })
      expect(bot.equipped).toEqual([])
    })

    it('has no gear without a bot', async () => {
      expect(await driverWith(undefined).driver.equipBestGear()).toEqual({
        weapon: undefined,
        armor: [],
      })
    })
  })
})

describe('MeleeCombatant', () => {
  class FakeCombatDriver implements CombatDriver {
    targetAt: Position | undefined = { x: 10, y: 64, z: 0 }
    me: Position | undefined = { x: 0, y: 64, z: 0 }
    weapon: string | undefined = 'iron_sword'
    swings: number[] = []
    approaches: { id: number; distance: number }[] = []
    chaseCancelled = 0
    gear: GearReport = { weapon: 'iron_sword', armor: [] }

    target(): { position: Position } | undefined {
      return this.targetAt === undefined ? undefined : { position: this.targetAt }
    }

    selfPosition(): Position | undefined {
      return this.me
    }

    approach(id: number, distance: number): PathHandle {
      this.approaches.push({ id, distance })
      return {
        outcome: new Promise(() => undefined),
        cancel: () => {
          this.chaseCancelled += 1
        },
      }
    }

    swing(id: number): void {
      this.swings.push(id)
    }

    heldItem(): string | undefined {
      return this.weapon
    }

    equipBestGear(): Promise<GearReport> {
      return Promise.resolve(this.gear)
    }
  }

  function setup() {
    const clock = new FakeClock(0)
    const scheduler = new FakeScheduler(clock)
    const driver = new FakeCombatDriver()
    return { clock, scheduler, driver, combatant: new MeleeCombatant({ driver, scheduler, clock }) }
  }

  const run = (combatant: MeleeCombatant, maxMs = 5000, signal = new AbortController().signal) =>
    combatant.attack(7, { signal, maxMs })

  it('hands the gear job to the driver', async () => {
    const { combatant, driver } = setup()
    driver.gear = { weapon: 'diamond_sword', armor: ['iron_helmet'] }

    expect(await combatant.equipBestGear()).toEqual({
      weapon: 'diamond_sword',
      armor: ['iron_helmet'],
    })
  })

  it('chases a target that is out of reach, then hits it in time with the weapon', async () => {
    const { combatant, driver, scheduler } = setup()
    const fight = run(combatant, 3000)

    scheduler.advance(300)
    expect(driver.approaches).toEqual([{ id: 7, distance: 1.8 }])
    expect(driver.swings).toEqual([])

    driver.me = { x: 9, y: 64, z: 0 } // arrived within reach
    scheduler.advance(100)
    expect(driver.chaseCancelled).toBe(1)
    expect(driver.swings).toEqual([7])
    scheduler.advance(500) // the sword needs 625 ms between swings
    expect(driver.swings).toHaveLength(1)
    scheduler.advance(200)
    expect(driver.swings).toHaveLength(2)

    driver.targetAt = undefined
    scheduler.advance(100)
    expect(await fight).toEqual({ ok: true, value: 'target_gone' })
  })

  it('starts hitting at once when the target is already in reach, without chasing', () => {
    const { combatant, driver } = setup()
    driver.targetAt = { x: STRIKE_DISTANCE - 0.1, y: 64, z: 0 }

    void run(combatant)

    expect(driver.swings).toEqual([7])
    expect(driver.approaches).toEqual([])
  })

  it('swings faster with fists than with an axe', () => {
    const fists = setup()
    fists.driver.weapon = undefined
    fists.driver.targetAt = { x: 1, y: 64, z: 0 }
    void run(fists.combatant, 5000)
    fists.scheduler.advance(1000)

    const axe = setup()
    axe.driver.weapon = 'iron_axe'
    axe.driver.targetAt = { x: 1, y: 64, z: 0 }
    void run(axe.combatant, 5000)
    axe.scheduler.advance(1000)

    expect(fists.driver.swings.length).toBeGreaterThan(axe.driver.swings.length)
  })

  it('reports the fight as ongoing when the time slice ends', async () => {
    const { combatant, driver, scheduler } = setup()
    driver.targetAt = { x: 1, y: 64, z: 0 }
    const fight = run(combatant, 1000)

    scheduler.advance(1000)

    expect(await fight).toEqual({ ok: true, value: 'still_fighting' })
    expect(scheduler.pendingCount).toBe(0)
  })

  it('stops chasing when the slice ends', async () => {
    const { combatant, driver, scheduler } = setup()
    const fight = run(combatant, 500)

    scheduler.advance(500)
    await fight

    expect(driver.chaseCancelled).toBe(1)
  })

  it('ends at once when the target is already gone', async () => {
    const { combatant, driver } = setup()
    driver.targetAt = undefined

    expect(await run(combatant)).toEqual({ ok: true, value: 'target_gone' })
  })

  it('fails when the bot leaves the world', async () => {
    const { combatant, driver } = setup()
    driver.me = undefined

    expect(await run(combatant)).toEqual({
      ok: false,
      error: { reason: 'not_connected', message: 'Lost the connection while fighting.' },
    })
  })

  it('stops immediately when aborted, and cancels the chase', async () => {
    const { combatant, driver, scheduler } = setup()
    const controller = new AbortController()
    const fight = run(combatant, 5000, controller.signal)
    scheduler.advance(200)

    controller.abort()

    expect(await fight).toEqual({ ok: false, error: { reason: 'aborted', message: 'Cancelled.' } })
    expect(driver.chaseCancelled).toBe(1)
    expect(scheduler.pendingCount).toBe(0)
  })

  it('does not start when already aborted', async () => {
    const { combatant, driver } = setup()
    const controller = new AbortController()
    controller.abort()

    expect((await run(combatant, 5000, controller.signal)).ok).toBe(false)
    expect(driver.swings).toEqual([])
  })
})

describe('eating, food catalog, and locomotion adapters', () => {
  it('eats an item: takes it in hand, then consumes it', async () => {
    const bot = new FakeBot()

    const result = await new MineflayerEater(holderOf(bot)).eat('cooked_beef')

    expect(result).toEqual({ ok: true, value: undefined })
    expect(bot.equipped).toEqual([{ itemType: 100, slot: 'hand' }])
    expect(bot.consumeCalls).toBe(1)
  })

  it('fails clearly for an unknown item, without a bot, and when the game refuses', async () => {
    expect(await new MineflayerEater(holderOf(new FakeBot())).eat('not_an_item')).toEqual({
      ok: false,
      error: 'not_an_item is not an item.',
    })
    expect(await new MineflayerEater(holderOf(undefined)).eat('bread')).toEqual({
      ok: false,
      error: 'Not connected to a Minecraft world.',
    })

    const bot = new FakeBot()
    bot.failConsume = new Error('food full')
    expect(await new MineflayerEater(holderOf(bot)).eat('bread')).toEqual({
      ok: false,
      error: 'Could not eat bread: food full',
    })
  })

  it('reads food values from the game data', () => {
    const catalog = new MineflayerFoodCatalog(holderOf(new FakeBot()))

    expect(catalog.info('cooked_beef')).toEqual({
      name: 'cooked_beef',
      foodPoints: 8,
      saturation: 12.8,
    })
    expect(catalog.info('stone')).toBeUndefined()
    expect(new MineflayerFoodCatalog(holderOf(undefined)).info('bread')).toBeUndefined()
  })

  it('holds and releases the jump key', () => {
    const bot = new FakeBot()
    const locomotion = new MineflayerLocomotion(holderOf(bot))

    locomotion.setJump(true)
    locomotion.setJump(false)
    new MineflayerLocomotion(holderOf(undefined)).setJump(true)

    expect(bot.controlStates).toEqual([
      { control: 'jump', active: true },
      { control: 'jump', active: false },
    ])
  })
})
