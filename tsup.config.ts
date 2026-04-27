import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  platform: "node",
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: ["@modelcontextprotocol/sdk", "@enconvert/node-sdk", "zod"],
  outExtension() {
    return { js: ".js" };
  },
});
