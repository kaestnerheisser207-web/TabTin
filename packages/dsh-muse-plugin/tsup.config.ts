import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'], format: ['esm'], platform: 'node', target: 'node22',
  bundle: true, splitting: false, dts: true, clean: true, sourcemap: true,
  noExternal: ['ws'],
  banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
})
