# Threat policy

`ThreatResponse` is driven by a data table (`mob type → action`), not by `if` chains, so policy changes do not touch the reflex code (Open/Closed).

| Rule | Action |
|---|---|
| Health at or below `LOW_HEALTH_THRESHOLD` (default 8 of 20) | **Flee from everything**, overrides all rules below |
| `skeleton` (all variants that shoot), `creeper` | **Flee**, always |
| `enderman` | **Ignore**: never attack, never provoke |
| Any other hostile mob (zombie, spider, husk, drowned, witch, ...) | **Fight**: equip best weapon and armor, engage in melee |
| Unlisted bosses and extreme threats (`warden`, `wither`, `ender_dragon`, `elder_guardian`) | **Flee** (safety default, editable in the table) |

Fleeing means sprinting away until the threat is out of range and out of sight, preferring the direction of the owner or a known landmark. Fighting stops and flips to fleeing as soon as health drops to the threshold.

[Back to the features index](../FEATURES.md)
