# Several connected rooms in one request

**Status:** not planned. `excavate` digs one room per call (the `room` shape); the layout below is not built.

The planned `room` shape in Phase 15 digs one room per call. To connect rooms today, the player stands inside a dug room, looks at another of its walls, and asks for the next room behind it; the new entrance opens into the first room. What is missing is asking for a whole layout at once ("three rooms in a row", "a main room with two side rooms").

- **Idea:** a `rooms` layout in the excavation family: a list of rooms, each with its own size, placed relative to the previous one (its front, left, right, or back wall, with `entrance_at` and `door` for each link), optionally joined by a short corridor.
- **Approach:** one plan for the whole layout, so it resumes as one job, is checked for overlaps before anything is dug, and the preview lists every room and doorway. The same hazard rules apply to each room; a room that meets water or a cave ends only its own chain. One summary covers all rooms.
- **Effort:** about half a session on top of the single room, in `feature/dug-rooms` after the `room` shape.

[Back to the backlog](../BACKLOG.md)
