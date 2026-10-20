import { configDefaults, defineConfig } from "vitest/config";

// The browser cases drive a real Edge, which takes enough CPU to push tests that start the Router
// past their time limits. They run as their own group, after every other test has finished.
const BROWSER = [
  "tests/modules/issues/layout-browser.test.ts",
  "tests/modules/issues/path-links-browser.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "node", include: ["tests/**/*.test.ts"], exclude: [...configDefaults.exclude, ...BROWSER], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "browser", include: BROWSER, sequence: { groupOrder: 1 } } },
    ],
  },
});
