import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'es2022' },
  // Database, render outputs and downloads are runtime data, not hot-reload inputs.
  server: { watch: { ignored: ['**/.local/**'] } },
});
