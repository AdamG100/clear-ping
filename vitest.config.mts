import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'probe-agent/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
  resolve: {
    // Mirrors tsconfig paths.
    alias: [{ find: /^@\//, replacement: path.resolve(root, 'src') + '/' }],
  },
})
