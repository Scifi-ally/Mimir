import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.cjs', '**/*.mjs', '**/*.js', '**/scratch/**']
  }
);
