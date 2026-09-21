// Entry point for BOTH opencode hosts — deliberately free of solid-js imports.
//
// v1 and v2 resolve "solid-js" to different builds, and this module is loaded
// by both. A static solid import here would pull both runtimes into whichever
// host loaded the plugin, which is what kept breaking one host every time the
// other was fixed. Each implementation is imported lazily instead, so a host
// only ever evaluates its own solid specifier.
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"

const tui: TuiPlugin = async (api) => (await import("./learn-v1")).tui(api)

const setup: TuiV2.Definition["setup"] = async (ctx) => (await import("./learn-v2")).setup(ctx)

export default {
  id: "learn-tui",
  tui,
  setup,
} satisfies TuiPluginModule & { id: string; setup: typeof setup }
