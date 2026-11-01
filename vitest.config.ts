import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    // Live acceptance preserves generated node:test projects for independent replay —
    // both here and in the workspace sandbox, where the agent writes runnable code.
    exclude: [...configDefaults.exclude, 'artifacts/**', 'workspace/**'],
  },
}))
