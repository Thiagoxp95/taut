import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import turboPlugin from 'eslint-plugin-turbo'
import tseslint from 'typescript-eslint'

/** Shared base config for every package in the monorepo. */
export const config = tseslint.config(
  // `data/` is the runtime agent homes (git-ignored): downloaded skills and vendor scripts,
  // not our source. Linting it drowned every real finding in thousands of `no-undef`.
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/.turbo', '**/data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { turbo: turboPlugin },
    rules: {
      'turbo/no-undeclared-env-vars': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  eslintConfigPrettier
)

export default config
