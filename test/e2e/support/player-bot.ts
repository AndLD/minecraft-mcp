import mineflayer from 'mineflayer'
import type { Position } from '../../../src/core/position.types.js'
import type { ServerInfo } from './server-config.js'

/** A second, real Mineflayer bot that plays the human: it chats and can be teleported around. */
export interface PlayerBot {
  readonly username: string
  chat(message: string): void
  position(): Position
  quit(): Promise<void>
}

export function joinAsPlayer(info: ServerInfo, username: string): Promise<PlayerBot> {
  const bot = mineflayer.createBot({
    host: info.host,
    port: info.minecraftPort,
    username,
    version: '1.21.1',
    auth: 'offline',
  })

  return new Promise((resolve, reject) => {
    bot.once('error', reject)
    bot.once('kicked', (reason) => {
      reject(new Error(`Player bot ${username} was kicked: ${JSON.stringify(reason)}`))
    })
    bot.once('spawn', () => {
      bot.removeListener('error', reject)
      resolve({
        username,
        chat: (message) => {
          bot.chat(message)
        },
        position: () => {
          const { x, y, z } = bot.entity.position
          return { x, y, z }
        },
        quit: () =>
          new Promise<void>((done) => {
            bot.once('end', () => {
              done()
            })
            bot.quit()
          }),
      })
    })
  })
}
