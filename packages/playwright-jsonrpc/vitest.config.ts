import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        '*.config.ts',
        '*.config.js',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    threads: false, // Playwright doesn't work well with threads
    sequence: {
      shuffle: false, // Run tests in order for browser tests
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});