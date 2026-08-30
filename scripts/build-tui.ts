import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["plugins/learn-tui.tsx"],
  outdir: "dist",
  naming: "tui.js",
  target: "bun",
  external: [
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
