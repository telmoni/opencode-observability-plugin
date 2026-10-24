import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  // One file with the SDK inside: OpenCode installs nothing beside the package, and a machine gets only the code the plugin runs.
  noExternal: [/.*/],
  // OpenTelemetry's resources load machine-id helpers by dynamic import, which would otherwise come out as chunks beside the entry.
  splitting: false,
  clean: true,
});
