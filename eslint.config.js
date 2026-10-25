// Minimal lint: ESLint's recommended rules (real bugs: undefined names, unreachable code, duplicate keys ...). Style is not enforced.
// `npm run lint` fails on errors only; warnings (unused variables) are reported but do not block.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'api/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // browser scripts: public/*.js are plain <script> files; those with module.exports are also loaded by the tests (CommonJS)
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'writable',
        // defined by the sibling <script> files loaded before app.js (see public/index.html)
        SectorTree: 'readonly', EligibilityMatch: 'readonly', CardHelpers: 'readonly', SourceErrors: 'readonly',
        PersonalSaves: 'readonly', DateFormat: 'readonly', LatexText: 'readonly',
      },
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // style-only findings of the recommended set, not bugs
      'no-useless-escape': 'off',
      'no-regex-spaces': 'off',
      // intentional text sanitizing: stripping control characters / stray-script ranges from model and web text
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
];
