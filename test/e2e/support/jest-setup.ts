import { jest } from '@jest/globals'

// A real server, real pathfinding, and real waits: allow much more than Jest's 5 s default.
// (Jest ignores `testTimeout` inside a project config, so it is set here.)
jest.setTimeout(120_000)
