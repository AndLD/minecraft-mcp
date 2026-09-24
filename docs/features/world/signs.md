# Signs

**Depends on:** [Storage](../storage/storage.md) (a sign beside a labelled container, sign items from chests), [Construction and building](construction-and-building.md) (`Placer`, `CraftingSupplies`), [Persistent state](../core/persistent-state.md), [Gathering, crafting, smelting](../gathering/gathering-crafting-smelting.md) (`craft`, `DropCollector`, `Digger`).  
**Used by:** no other feature directly.

Branch `feature/signs`. A sign is how a label becomes visible in the world: "put a sign 'Iron' on this chest", "change it to 'Ores'", "take that sign down", "what do the signs here say?". Until now the bot labelled things only in its own memory (`label_container`). Text is plain: no colour and no glow, and hanging signs are not handled.

## Tools

| Tool | What it does |
|---|---|
| `place_sign` | Puts up a sign with `text` (wrapped on spaces) or `lines`. Target: the block the player looks at (default), or `at` + `face`, or `beside` a registered container by id or label (the label is the text when none is given). Options: `wood`, `side` (`front`/`back`), `facing` for a standing sign. A task. |
| `edit_sign` | Replaces one side's text. Target: the sign the player looks at, `at`, or `matching` text. Empty lines clear it. A task. |
| `remove_sign` | Breaks one sign and picks it up. Same target forms. A task. |
| `read_signs` | Text of the signs within a radius (default 16, max 48), nearest first: both sides, wood, standing or wall, facing, waxed, distance, `placedByBot`. Read-only; `matching` filters. |

## Rules

- **Text** (`sign-text.ts`): 4 lines of 15 characters. `text` is wrapped on spaces and keeps its own line breaks; `lines` are taken as they are. Over-long text fails `text_too_long` and says how to split it (a word longer than a line cannot be wrapped). Control characters and `§` colour codes are refused (`bad_text`). Empty text is `no_text`, except for `edit_sign`, which may clear a sign.
- **Placement** (`PlaceSignSkill`): a wall sign goes on a horizontal face, a standing sign on the top face; the bottom face is `bad_face`. The reference block must be loaded, solid, and not a liquid; the cell in front must be air (`blocked` when taken, `fluid` for water or lava); a protected area (cell or reference) is `protected_area`, **always, even with `at`**, unlike `place_bed`. The bot needs a free, solid, dry standing spot in front (`no_stand`); ground that is farmland or a liquid is never used, so a sign never costs a trampled field.
- **Where the bot stands decides a standing sign's direction.** The game turns a standing sign to face whoever places it, so the bot walks **exactly** onto the cell two blocks along the wanted direction (`facing`, default towards the player, else towards the bot) and places from there. A wall sign takes its direction from the wall, so any free spot in front within reach will do. The e2e test checks `rotation=0` against the real server.
- **Sneaking.** A right click on a chest, barrel, crafting table, or door uses it instead of placing a block, so the bot **holds sneak while placing a sign** (`Placer.placeAgainst(..., { sneak: true })`; `MineflayerPlacer` sets it, waits 3 ticks, and always lets go). Found by the e2e test: without it "the server did not answer the placement", and the chest just opened.
- **Chests.** A standing sign cannot stand on top of a chest, and a player who looks at one from above still means its side. So the tool turns a look at the top or bottom of a container into "no face", and the skill then picks the **free side nearest to the player** (nearest to the bot when no player is known); the skill itself refuses `top` on a container with `not_solid`. This is the same choice `beside` uses.
- **Sign items** (`SignSupplies`): a sign of the wanted wood (any wood when none is asked) from the inventory; else from the known, unprotected containers (`ContainerIndex` contents, fetched with the `MaterialFetcher`); else crafted (`CraftingSupplies`, 3 signs per craft from 6 planks and a stick, a crafting table is placed if needed), the wood asked for or oak. Otherwise `no_sign_item`. A cancel during the craft is `aborted`, not `no_sign_item`.
- **Writing the text is a separate step in 1.21.** The server opens the sign editor when the sign is placed, so the text goes out with the sign-update packet right after placing and is **read back** (`SignAccess.stateAt`) before the skill reports success. A sign that is up without its text is reported as `text_not_written` or `text_not_confirmed` with its position in `detail`; the sign stays, and `edit_sign` fixes it. For an existing sign, `SignAccess.write(..., reopen: true)` right-clicks it first and waits for the editor (`signOpen` event); no editor means `not_editable` (waxed, or too far). A waxed sign is refused up front (`waxed`, and the message says it can still be removed).
- **Whose signs, and never in bulk** (`SignTargeter`). What to edit or remove is named by exactly one of: a position, the single sign whose text (either side, ignoring case) matches within `radius`, or the sign the player looks at. A phrase that fits several signs is `ambiguous` and lists them; there is no "all". Signs in protected areas are left alone (`protected_area`) for both edit and remove. A waxed sign can be removed: waxing only stops editing.
- **`SignRegistry`** (`src/state/sign-registry.ts`, per world, `ProfileScoped`): the signs the bot put up (position, the text it wrote, side, wood, when). It is a record used for `placedByBot` in `read_signs`, not a permission: the rule above is enforced by how a target is named, so a player's sign is removed on request in exactly the same way as the bot's own.

## Ports and adapters

- `SignAccess` (`src/core/sign.port.ts`, `MineflayerSignAccess`): `stateAt` (name, four lines per side from `block.getSignText()`, waxed from the block entity's `is_waxed`, facing from `facing` or the standing sign's `rotation`), and `write`. `BotLike` gained `updateSign` and the `signOpen` event; `BlockLike` gained `getSignText` and `blockEntity`.
- `Placer.placeAgainst` gained an optional `{ sneak }`; `BotLike.setControlState` accepts `sneak`.
- `FakeBot` simulates signs (`setSign`, `signs`, `signUpdates`, editor opened by placing or right-clicking, waxed) and now refuses to place against a chest, door, and the like unless it sneaks, like the server.

## Tests

- unit: text wrapping and limits, the sign table and facing, `SignRegistry`, `MineflayerSignAccess` (state, both write paths, waxed, errors), `MineflayerPlacer` sneaking, `PlaceSignSkill` (wall and standing, facing and standing spot, the side facing the player, every refusal, failures of walk, placer, text, and read-back), `EditSignSkill`, `RemoveSignSkill`, `SignReader`, `SignTargeter`, `SignSupplies`, and the four tools.
- integration (`test/integration/signs-flow.test.ts`): all four tools through the MCP server on a stateful fake world with a fake look target: wall and standing signs, a craft from planks, no sign to be had, `beside` a chest, a look at the top of a chest, protected area, taken cell and long text, edit, remove (only that sign), a waxed sign, an ambiguous match, and a cancel during the craft.
- e2e (`test/e2e/signs/signs.e2e.test.ts`, real Paper): a wall sign on the chest the owner looks at (the exit criterion), a standing sign turned towards the owner (`rotation=0`), a sign beside a labelled chest, refusals (too long, taken, protected), `edit_sign` on a player's sign, `remove_sign` with the item back in the inventory, a waxed sign (edit refused, removal allowed), and `read_signs`. The sign text is read from `data get block ... front_text.messages` by path, because the server cuts a whole-block reply short.

## Not built

Hanging signs, colour and glow, waxing or dyeing, and `edit_sign` on a sign found only by `beside` (name it by position, text, or look).

## Exit criteria

"Put a sign 'Iron' on this chest" (looking at the chest) hangs a wall sign with that text; "change it to 'Ores'" edits it; "take that sign down" removes exactly that sign and picks it up; "what do the signs here say?" lists their text.

[Back to the features index](../FEATURES.md)
