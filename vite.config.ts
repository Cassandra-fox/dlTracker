import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import manifest from './src/manifest';
import path from 'node:path';

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => manifest,
      // The plugin downloads a remote schema without a request timeout.
      // ManifestV3 typechecking + check-build.mjs keep builds offline and repeatable.
      skipManifestValidation: true,
    }),
  ],
  publicDir: 'src/assets',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
