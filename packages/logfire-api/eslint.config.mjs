import baseConfig from '../../eslint-config.mjs'

export default [
  { ignores: ['coverage/**'] },
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]
