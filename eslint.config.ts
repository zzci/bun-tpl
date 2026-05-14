import antfu from "@antfu/eslint-config";

export default antfu({
  typescript: true,
  react: true,
  stylistic: {
    indent: 2,
    quotes: "double",
    semi: true,
  },
  rules: {
    "no-console": "warn",
    "ts/no-explicit-any": "error",
    "ts/consistent-type-imports": ["error", { prefer: "type-imports" }],
  },
  ignores: [
    "**/*.json",
    "**/*.toml",
    "**/*.md",
    "**/*.yml",
    "**/*.yaml",
    "apps/api/drizzle/**",
    "apps/web/src/shared/components/ui/**",
    "apps/web/src/app/routeTree.gen.ts",
  ],
}, {
  // Test files routinely need to construct partial fixtures that the
  // strict project rules would otherwise refuse — relax the
  // most-friction-prone ones to `warn`, leaving production code under
  // the strict policy. Keeps test ergonomics without giving up the
  // rules where they matter.
  files: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "tests/e2e/**/*.ts",
  ],
  rules: {
    "ts/no-explicit-any": "warn",
    "no-console": "off",
  },
});
