import type { ItemFacts } from '../../core/item-facts.port.js'
import { isGroup, matchesSpec } from '../storage/item-matcher.js'

/** Everyday words for items, so "cobble" and "steak" work. */
const ALIASES: Readonly<Record<string, string>> = {
  cobble: 'cobblestone',
  steak: 'cooked_beef',
  pork: 'cooked_porkchop',
  planks: 'planks',
  lapis: 'lapis_lazuli',
  glass_pane: 'glass_pane',
}

/** Words that mean several different things at once; the player is asked which. */
const AMBIGUOUS_WORDS = new Set(['wood'])

const MAX_CANDIDATES = 8

export interface Candidate {
  readonly item: string
  /** How many the bot carries. */
  readonly carried: number
  /** How many are remembered in containers. */
  readonly stored: number
}

export type Resolution =
  /** Concrete item names (one for a name, several for a group). Empty when a group matches nothing on hand. */
  | {
      readonly kind: 'items'
      readonly items: readonly string[]
      readonly via: 'exact' | 'alias' | 'group' | 'match'
    }
  /** More than one thing could be meant; ask the player which. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'unknown'; readonly suggestions: readonly string[] }

export interface Availability {
  readonly carried: ReadonlyMap<string, number>
  readonly stored: ReadonlyMap<string, number>
}

/**
 * Turns what a player says ("iron", "some cobble", "logs", "food") into concrete item names, using the game's item
 * names, plurals, everyday words, and item groups. When several things fit, the ones the bot actually has (in the
 * inventory or in chests) win; if that still leaves more than one, the request is ambiguous and the agent asks.
 */
export class ItemResolver {
  constructor(private readonly facts: ItemFacts) {}

  resolve(phrase: string, have: Availability): Resolution {
    const normalized = phrase
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
    if (normalized === '') return { kind: 'unknown', suggestions: [] }

    const forms = this.forms(normalized)
    for (const form of forms) {
      if (this.facts.isItem(form)) return { kind: 'items', items: [form], via: 'exact' }
    }
    for (const form of forms) {
      const alias = ALIASES[form]
      if (alias === undefined) continue
      if (isGroup(alias)) return this.group(alias, have)
      return { kind: 'items', items: [alias], via: 'alias' }
    }
    for (const form of forms) if (AMBIGUOUS_WORDS.has(form)) return this.ambiguousGroup(form, have)
    for (const form of forms) if (isGroup(form)) return this.group(form, have)
    return this.match(forms, have)
  }

  /** The phrase and its singular forms ("logs", "log"; "berries", "berry"). */
  private forms(word: string): string[] {
    const forms = [word]
    if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`)
    if (word.endsWith('es')) forms.push(word.slice(0, -2))
    if (word.endsWith('s')) forms.push(word.slice(0, -1))
    return forms
  }

  private group(group: string, have: Availability): Resolution {
    const names = new Set<string>()
    for (const source of [have.carried, have.stored])
      for (const [name, count] of source)
        if (count > 0 && matchesSpec(group, name, this.facts)) names.add(name)
    return { kind: 'items', items: [...names].sort(), via: 'group' }
  }

  private ambiguousGroup(word: string, have: Availability): Resolution {
    const found = this.group(word, have)
    const candidates = (found.kind === 'items' ? found.items : []).map((item) =>
      this.candidate(item, have),
    )
    return {
      kind: 'ambiguous',
      candidates:
        candidates.length > 0
          ? candidates
          : ['oak_log', 'oak_planks'].map((item) => this.candidate(item, have)),
    }
  }

  /** Items whose name contains every word of the phrase as a whole word ("iron" finds iron_ingot and raw_iron). */
  private match(forms: readonly string[], have: Availability): Resolution {
    const words = (forms[0] ?? '').split('_')
    const matching = this.facts.allItems().filter((name) => {
      const parts = name.split('_')
      return words.every(
        (word) => parts.includes(word) || parts.includes(this.forms(word).at(-1) ?? word),
      )
    })
    if (matching.length === 0) return { kind: 'unknown', suggestions: this.suggest(forms[0] ?? '') }

    const candidates = matching.map((item) => this.candidate(item, have))
    const available = candidates.filter((c) => c.carried + c.stored > 0)
    if (available.length === 1 && available[0] !== undefined)
      return { kind: 'items', items: [available[0].item], via: 'match' }
    if (available.length > 1)
      return {
        kind: 'ambiguous',
        candidates: available
          .sort((a, b) => b.carried + b.stored - (a.carried + a.stored))
          .slice(0, MAX_CANDIDATES),
      }
    if (candidates.length === 1 && candidates[0] !== undefined)
      return { kind: 'items', items: [candidates[0].item], via: 'match' }
    return {
      kind: 'ambiguous',
      candidates: candidates.sort((a, b) => a.item.length - b.item.length).slice(0, MAX_CANDIDATES),
    }
  }

  private candidate(item: string, have: Availability): Candidate {
    return { item, carried: have.carried.get(item) ?? 0, stored: have.stored.get(item) ?? 0 }
  }

  private suggest(word: string): string[] {
    return this.facts
      .allItems()
      .filter((name) => name.includes(word) || word.includes(name))
      .slice(0, MAX_CANDIDATES)
  }
}
