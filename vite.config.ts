import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  plugins: [react()],

  // Web Worker bundling — ES module format for Vite worker support
  worker: {
    format: 'es',
  },

  // Dev server headers: required for SharedArrayBuffer (OpenCV WASM threading)
  // Also needed for performance.measureUserAgentSpecificMemory() used for
  // memory-pressure-based worker restarts.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },

  // Same headers for preview builds
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },

  // Vitest config
  test: {
    environment: 'node',
    testTimeout: 60_000, // OCR integration tests need time for WASM init
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
