import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  // One file with the SDK and OpenTelemetry inside it, as much of them as the
  // plugin runs: OpenCode installs nothing beside the package, and a person's
  // machine gets the code the plugin runs and no other.
  noExternal: [/.*/],
  // OpenTelemetry's resources load their machine-id helpers by dynamic
  // import, which would otherwise come out as chunks beside the entry.
  splitting: false,
  clean: true,
});
