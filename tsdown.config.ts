import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  platform: 'node',
  target: 'node22.18',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  shims: true,
  failOnWarn: true,
})
