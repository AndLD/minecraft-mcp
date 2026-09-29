import { z } from 'zod'
import type { LookTarget } from '../../core/container.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Position } from '../../core/position.types.js'
import type { EditSignSkill } from '../../skills/signs/edit-sign-skill.js'
import type { PlaceSignSkill } from '../../skills/signs/place-sign-skill.js'
import type { RemoveSignSkill } from '../../skills/signs/remove-sign-skill.js'
import type { SignReader } from '../../skills/signs/sign-reader.js'
import { FACINGS, SIGN_WOODS } from '../../skills/signs/sign-table.js'
import type { SignTargeter } from '../../skills/signs/sign-target.js'
import {
  SIGN_LINE_LENGTH,
  SIGN_LINES,
  signLines,
  type SignTextProblem,
} from '../../skills/signs/sign-text.js'
import { isContainerBlock, type ContainerIndex } from '../../state/container-index.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30
const DEFAULT_RADIUS = 16
const MAX_RADIUS = 48

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const positionSchema = z.object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })

const textFields = {
  text: z
    .string()
    .min(1)
    .max(240)
    .optional()
    .describe(
      `The sign text. It is wrapped on spaces into lines of ${String(SIGN_LINE_LENGTH)} characters (a line break of your own is kept); ${String(SIGN_LINES)} lines at most. Plain text only: no colour, no glow.`,
    ),
  lines: z
    .array(z.string().max(SIGN_LINE_LENGTH * 2))
    .max(SIGN_LINES + 2)
    .optional()
    .describe(
      `Or the lines exactly as they go on the sign (up to ${String(SIGN_LINES)}, each up to ${String(SIGN_LINE_LENGTH)} characters, blank ones allowed). Use one of text and lines.`,
    ),
  side: z
    .enum(['front', 'back'])
    .default('front')
    .describe('Which side of the sign the text goes on (default front).'),
}

const playerField = z
  .string()
  .min(1)
  .optional()
  .describe('Whose look to use when no position is given. Defaults to the owner.')

const problem = (found: SignTextProblem): string => `${found.message} (reason: ${found.reason})`

const where = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

const placeSchema = z
  .object({
    ...textFields,
    at: positionSchema
      .optional()
      .describe(
        'The block the sign hangs on or stands on (needs face). Omit to use the block the player is looking at.',
      ),
    face: z
      .enum(['top', 'north', 'south', 'east', 'west'])
      .optional()
      .describe(
        'Which face of that block: top puts a standing sign on it, a side hangs a wall sign there.',
      ),
    beside: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A registered container (its id or label): the sign goes on a free side of it, and its label is the text when you give none.',
      ),
    for_player: playerField,
    wood: z
      .enum(SIGN_WOODS)
      .optional()
      .describe('The wood. The sign type the bot carries when omitted, else oak.'),
    facing: z
      .enum(FACINGS as [string, ...string[]])
      .optional()
      .describe('For a standing sign, the direction its text faces. Default: towards the player.'),
    replace_block: z
      .boolean()
      .default(false)
      .describe(
        'Break the block that stands in the sign\'s cell (for example a torch on top of a fence) and put the sign there. Only after the player agreed to it (the blocked reply offers it): never on your own. Chests, doors, beds, and other signs are never broken.',
      ),
    ...taskOptionsShape,
  })
  .refine((input) => (input.at === undefined) === (input.face === undefined), {
    message: 'Give at and face together, or neither.',
  })
  .refine((input) => input.text === undefined || input.lines === undefined, {
    message: 'Give text or lines, not both.',
  })
  .refine((input) => input.beside === undefined || input.at === undefined, {
    message: 'Give beside or at, not both.',
  })

export class PlaceSignTool implements ToolDefinition<typeof placeSchema> {
  readonly name = 'place_sign'
  readonly description =
    'Puts up a sign with text: on the block the player is looking at (the default: a wall sign on the face they look ' +
    'at, a standing sign on a top face; for a chest or barrel always a wall sign on a free side), or at a block and ' +
    'face you name, or beside a registered container (beside: its label is the text when you give none). The bot fetches a sign from its inventory or the known chests, or crafts ' +
    'three (planks and a stick), walks to a spot in front, places it, writes the text, and reads it back to confirm. ' +
    `Text is plain: up to ${String(SIGN_LINES)} lines of ${String(SIGN_LINE_LENGTH)} characters, no colour or glow ` +
    '(text_too_long says how to split it). A sign is one block and needs a free cell on a solid block: when the cell is taken (a torch on the fence top) `blocked` names free places instead and, ' +
    'if it may be swapped, offers replace_block: true (ask the player first). It never goes in ' +
    'water or lava or in a protected area, and never needs the bot to trample farmland. ' +
    'Failures: text_too_long, no_text, bad_text, no_sign_item, bad_face, not_loaded, fluid, not_solid, blocked, ' +
    'protected_area, no_stand, unreachable (names every spot it tried and why), not_placed, replace_failed, and text_not_written or text_not_confirmed (the sign is then up ' +
    'without its text: its position is in the failure, and edit_sign fixes it).'
  readonly inputSchema = placeSchema

  constructor(
    private readonly skill: PlaceSignSkill,
    private readonly launcher: TaskLauncher,
    private readonly look: LookTarget,
    private readonly containers: ContainerIndex,
    private readonly entities: EntityScanner,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof placeSchema>, context: ToolContext) {
    const player = input.for_player ?? this.defaultPlayer
    let reference: Position
    let face: 'top' | 'north' | 'south' | 'east' | 'west' | 'bottom' | undefined
    let defaultText: string | undefined

    if (input.beside !== undefined) {
      const container = this.containers.resolve(input.beside)
      if (container === undefined)
        return toolFail(
          `No known container is called "${input.beside}". list_containers shows them; register_container adds one.`,
        )
      reference = container.position
      face = undefined
      defaultText = container.label ?? undefined
    } else if (input.at !== undefined && input.face !== undefined) {
      reference = input.at
      face = input.face
    } else {
      if (player === undefined)
        return toolFail(
          'Say where the sign goes: at and face, beside a container, or a player (for_player, or set MC_OWNER) who is looking at the block.',
        )
      const hit = this.look.blockLookedAt(player)
      if (hit === undefined)
        return toolFail(
          `${player} is not looking at any block within reach, or is out of the bot's view. Give at and face, or ask them to look at the block.`,
        )
      reference = hit.position
      // A sign cannot stand on a chest, and a player who looks at one from above still means its side.
      face =
        isContainerBlock(hit.name) && (hit.face === 'top' || hit.face === 'bottom')
          ? undefined
          : hit.face
    }

    const text = input.text ?? (input.lines === undefined ? defaultText : undefined)
    const lines = signLines({ text, lines: input.lines })
    if (!lines.ok) return toolFail(problem(lines.error))
    const towards = player === undefined ? undefined : this.entities.player(player)?.position

    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Put up a sign at ${where(reference)}`,
        run: (ctx) =>
          this.skill.run(
            {
              reference,
              face,
              lines: lines.value,
              side: input.side,
              wood: input.wood,
              facing: input.facing as 'north' | 'south' | 'east' | 'west' | undefined,
              towards,
              replaceBlock: input.replace_block,
            },
            ctx,
          ),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const targetFields = {
  at: positionSchema.optional().describe('The sign.'),
  matching: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe(
      'Words on the sign (either side, ignoring case). It must match exactly one sign within radius.',
    ),
  radius: z
    .number()
    .int()
    .min(1)
    .max(MAX_RADIUS)
    .default(DEFAULT_RADIUS)
    .describe(`How far around the bot to look for a match (default ${String(DEFAULT_RADIUS)}).`),
  for_player: playerField,
}

const editSchema = z
  .object({ ...textFields, ...targetFields, ...taskOptionsShape })
  .refine((input) => input.text === undefined || input.lines === undefined, {
    message: 'Give text or lines, not both.',
  })
  .refine((input) => input.text !== undefined || input.lines !== undefined, {
    message: 'Give the new text or lines.',
  })

export class EditSignTool implements ToolDefinition<typeof editSchema> {
  readonly name = 'edit_sign'
  readonly description =
    'Changes the text on one side of a sign: the sign the player is looking at (the default), or at a position, or the ' +
    'one sign whose text matches. The bot walks up to it and rewrites it, then reads it back. Empty lines clear it. ' +
    `Same text rules as place_sign (${String(SIGN_LINES)} lines of ${String(SIGN_LINE_LENGTH)} characters, plain). ` +
    'A waxed sign is refused (reason waxed): tell the player; it can still be taken down with remove_sign on request. ' +
    'Signs in protected areas are left alone. Failures: not_a_sign, not_found, ambiguous (several match: ask which), ' +
    'not_looking, waxed, protected_area, unreachable, not_editable, text_not_confirmed, text_too_long.'
  readonly inputSchema = editSchema

  constructor(
    private readonly skill: EditSignSkill,
    private readonly launcher: TaskLauncher,
    private readonly targeter: SignTargeter,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof editSchema>, context: ToolContext) {
    const lines = signLines({ text: input.text, lines: input.lines }, true)
    if (!lines.ok) return toolFail(problem(lines.error))
    const target = this.targeter.resolve({
      at: input.at,
      matching: input.matching,
      radius: input.radius,
      player: input.for_player ?? this.defaultPlayer,
    })
    if (!target.ok) return toolFail(`${target.error.message} (reason: ${target.error.reason})`)
    const position = target.value

    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Change the sign at ${where(position)}`,
        run: (ctx) => this.skill.run({ position, lines: lines.value, side: input.side }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const removeSchema = z.object({ ...targetFields, ...taskOptionsShape })

export class RemoveSignTool implements ToolDefinition<typeof removeSchema> {
  readonly name = 'remove_sign'
  readonly description =
    'Takes down exactly one sign and picks it up again: the sign the player is looking at (the default), or the one at a ' +
    'position, or the one whose text matches. There is no way to remove several: a phrase that fits more than one sign ' +
    'fails with ambiguous and lists them, so ask which. Use it only when the player asks: a sign somebody else put up is ' +
    'taken down only when they point at it or name it. A waxed sign can be taken down; signs in protected areas are left ' +
    'alone. Failures: not_a_sign, not_found, ambiguous, not_looking, protected_area, unreachable, not_removed.'
  readonly inputSchema = removeSchema

  constructor(
    private readonly skill: RemoveSignSkill,
    private readonly launcher: TaskLauncher,
    private readonly targeter: SignTargeter,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof removeSchema>, context: ToolContext) {
    const target = this.targeter.resolve({
      at: input.at,
      matching: input.matching,
      radius: input.radius,
      player: input.for_player ?? this.defaultPlayer,
    })
    if (!target.ok) return toolFail(`${target.error.message} (reason: ${target.error.reason})`)
    const position = target.value

    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Take down the sign at ${where(position)}`,
        run: (ctx) => this.skill.run({ position }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const readSchema = z.object({
  radius: z
    .number()
    .int()
    .min(1)
    .max(MAX_RADIUS)
    .default(DEFAULT_RADIUS)
    .describe(
      `How far around the bot to read (default ${String(DEFAULT_RADIUS)}, max ${String(MAX_RADIUS)}).`,
    ),
  matching: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe('Keep only signs with these words on them (either side, ignoring case).'),
})

export class ReadSignsTool implements ToolDefinition<typeof readSchema> {
  readonly name = 'read_signs'
  readonly description =
    'Reads the signs around the bot (loaded blocks only): position, front and back text (blank lines left out), wood, ' +
    'standing or wall, which way it faces, whether it is waxed, the distance, and placedByBot (true when this bot ' +
    'put it up). Nearest first. Read-only: use it to see what the players wrote, and to check a sign before editing it.'
  readonly inputSchema = readSchema

  constructor(private readonly reader: SignReader) {}

  execute(input: z.output<typeof readSchema>) {
    const signs = this.reader.read(input.radius, input.matching)
    return toolOk({ count: signs.length, signs })
  }
}
