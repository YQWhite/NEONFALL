// Import the TS configuration directly so a build does not need a config-loader
// subprocess or Windows network-drive probing in restricted environments.
import { build } from 'vite';
import config from '../vite.config.ts';

await build({
  ...config,
  configFile: false,
  resolve: { ...config.resolve, preserveSymlinks: true },
});
