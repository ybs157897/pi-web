import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    // Live acceptance preserves generated node:test projects for independent replay.
    exclude: [...configDefaults.exclude, 'artifacts/**'],
  },
}))
