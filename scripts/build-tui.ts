import solidPlugin from "@opentui/solid/bun-plugin"
import fs from "node:fs"
import path from "node:path"

const result = await Bun.build({
  entrypoints: ["plugins/learn-tui.tsx"],
  outdir: "dist",
  naming: "tui.js",
  target: "bun",
  // Each host must load only its own solid build. Splitting keeps the lazy
  // import("./learn-v1") / import("./learn-v2") in separate chunks; without
  // it Bun inlines everything into one module and both solid specifiers
  // execute in whichever host loads the plugin.
  splitting: true,
  external: [
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "solid-js/dist/solid.js",
  ],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Splitting emits content-hashed chunks. Remove only obsolete Bun chunks after
// a successful build; retain server.js and unrelated files in the shared dist.
const emitted = new Set(result.outputs.map(output => path.resolve(output.path)))
for (const file of fs.readdirSync("dist")) {
  if (/^chunk-[\w-]+\.js$/.test(file) && !emitted.has(path.resolve("dist", file))) fs.unlinkSync(path.join("dist", file))
}
