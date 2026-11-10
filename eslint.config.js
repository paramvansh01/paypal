import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "data", "evidence", "web/dist", "drizzle"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["demo/sites/**/*.js", "web/**/*.{js,ts,tsx}", "tools/**/*.mjs", "src/**/*.page.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["tools/**/*.mjs", "scripts/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
);
