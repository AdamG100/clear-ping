import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // Mirrors tsconfig paths. The more specific @/types alias must come first;
    // Vite matches in order, so a leading @/ -> src rule would swallow it.
    alias: [
      { find: /^@\/types\//, replacement: path.resolve(root, 'types') + '/' },
      { find: /^@\//, replacement: path.resolve(root, 'src') + '/' },
    ],
  },
})
