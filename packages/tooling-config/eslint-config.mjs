import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import perfectionist from 'eslint-plugin-perfectionist'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import globals from 'globals'
import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'
import tseslint from 'typescript-eslint'
import turboPlugin from "eslint-plugin-turbo";

export default tseslint.config(
  pluginJs.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  perfectionist.configs['recommended-natural'],
  neostandard({ noJsx: true, noStyle: true }),
  eslintPluginPrettierRecommended,
  eslintConfigPrettier,
  { files: ['src/*.{js,mjs,cjs,ts}', 'eslint.config.mjs', 'vite.config.ts'] },
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "off",
      "perfectionist/sort-modules": "off",
    },
  },
  { ignores: resolveIgnoresFromGitignore() }
)
