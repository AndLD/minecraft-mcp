/** @type {import('jest').Config} */
const shared = {
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
}

export default {
  // Do not depend on a system watchman install; the file crawler is fast enough here.
  watchman: false,
  projects: [
    { ...shared, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.test.ts'] },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
    },
  ],
  // Interface-only files (*.port.ts, *.types.ts) emit no code, so they are not measured.
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/**/*.port.ts', '!src/**/*.types.ts'],
  coverageProvider: 'v8',
  coverageThreshold: {
    global: { lines: 90, branches: 90, functions: 90, statements: 90 },
  },
}
