# Storage: gaps

**Status:** not planned.

- **Craft and place a new chest** when there is no storage space and the player allows it (`no_storage_space` currently falls back to asking).
- **Ender chests and shulker boxes carried in the inventory** are not handled (placed shulker boxes work like chests).
- **Free-space knowledge is remembered, not measured.** A container the player emptied since the last scan is still treated as full by the fallback selection (`ContainerSelector.select`) until it is scanned again. `organize_storage`, the torch supply, and the fuel supply refresh what they need first, but a plain `deposit_items` does not.

[Back to the backlog](../BACKLOG.md)
