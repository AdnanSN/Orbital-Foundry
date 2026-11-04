import { defineConfig } from "vitest/config";

// Unit tests cover the browser-free parts (director, world model, sprite and font data), so they
// run in Node without the React and Tailwind plugins.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
