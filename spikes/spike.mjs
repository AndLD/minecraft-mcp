// Throwaway feasibility spike (Phase 0). Not part of the architecture.
// Usage: node spike.mjs <port> <ownerName> [seconds]
import dgram from 'node:dgram'
import mc from 'minecraft-protocol'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg
const HOST = 'localhost'
const PORT = Number(process.argv[2])
const OWNER = process.argv[3]
const SECONDS = Number(process.argv[4] ?? 120)
const log = (tag, ...a) => console.log(`[${tag}]`, ...a)
const json = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

// 1. LAN broadcast probe (does the world announce itself with name + port?)
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
sock.on('message', (m, r) => log('lan-broadcast', r.address, m.toString()))
sock.on('error', (e) => log('lan-broadcast-error', e.message))
sock.bind(4445, () => {
  try { sock.addMembership('224.0.2.60') } catch (e) { log('lan-membership-error', e.message) }
})

// 2. Server status ping (MOTD / version)
try {
  const st = await mc.ping({ host: HOST, port: PORT })
  log('status', json({ version: st.version, players: st.players, description: st.description }))
} catch (e) { log('status-error', e.message) }

// 3. Bot join
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'ClaudeBot', version: '1.21.1', auth: 'offline' })
bot.loadPlugin(pathfinder)

bot._client.on('login', (p) => log('login-packet', json(p)))
bot._client.on('respawn', (p) => log('respawn-packet', json(p)))
bot._client.on('spawn_position', (p) => log('spawn_position', json(p)))

bot.once('spawn', () => {
  log('spawn', 'pos', json(bot.entity.position), 'version', bot.version, 'game', json(bot.game))
  log('players', Object.keys(bot.players).join(', '))
  bot.chat(`ClaudeBot online. Say "come" or "bye". Listening to ${OWNER}.`)
})

bot.on('chat', async (username, message) => {
  log('chat', username, message)
  if (username === bot.username) return
  if (username !== OWNER) return
  if (message === 'bye') { bot.chat('bye'); setTimeout(() => bot.quit(), 300); return }
  if (message === 'come') {
    const target = bot.players[username]?.entity
    if (!target) { bot.chat(`I cannot see ${username}`); return }
    bot.pathfinder.setMovements(new Movements(bot))
    bot.chat('coming')
    try {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
      bot.chat('arrived')
      log('goto', 'arrived')
    } catch (e) { bot.chat('failed'); log('goto-error', e.message) }
    return
  }
  bot.chat(`echo: ${message}`)
})

bot.on('kicked', (r) => log('kicked', json(r)))
bot.on('error', (e) => log('error', e.message))
bot.on('end', (r) => { log('end', r); process.exit(0) })

setTimeout(() => { log('timeout', 'ending spike'); bot.quit(); setTimeout(() => process.exit(0), 500) }, SECONDS * 1000)
