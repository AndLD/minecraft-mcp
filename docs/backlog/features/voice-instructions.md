# Voice instructions

**Status:** not planned.

Give instructions to the bot by speaking instead of typing in game chat. The bot's side needs no change: the agent already receives instructions as text, so the work is turning speech into text. Two options were discussed, to choose between later (they can also be combined).

**Option A: voice to the agent (no code)**
- The player uses dictation or a voice mode in the Claude client, and the agent calls the bot's tools as usual.
- Pros: nothing to build.
- Cons: only works while the player is at the keyboard with the client focused; not usable while playing full screen.

**Option B: push-to-talk companion**
- A small local program records while a key is held, transcribes the audio with a speech model (local or API), and pushes the text into the same `AgentInbox` that in-game chat feeds, as a chat message from the owner (or a `voice` event).
- Pros: works while playing; fits the existing design; a spoken "stop" can be matched in code by a `ChatCommand`, so it never waits for an agent round trip.
- Cons: a new component to build and run; recognition errors.
- Design notes: hide the recognizer behind a `SpeechToText` port (Dependency Inversion), a `VoiceInput` adapter for the microphone and key, and one new class that feeds `ChatRouter`. Read risky or destructive instructions back in chat and wait for a yes before acting. Never treat voice as a different trust level than chat: the same owner rules apply.

**Rejected:** capturing in-game voice chat (for example the Simple Voice Chat mod). It needs a mod on the server and on the player's side, and vanilla via TLauncher has no voice channel.

[Back to the backlog](../BACKLOG.md)
