import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import plugin, {
  MD_LINK_EXTRA_STORES_ENV,
  MD_LINK_STORE_ENV,
  __resetMdLogState,
  canonicalMdLinkStorePath,
  loadMdLinks,
  mdEntryId,
  readMdEntryIds,
  saveMdLinks,
} from "./learn"

// ── Harness ──────────────────────────────────────────────────────────────────
// Mirrors plugins/server-v2.test.ts: drive `plugin.server` with a fake client so the
// real md_log tool, backfill and link store all run end to end. Every path lives in
// a temp dir — the user's real vault files are never touched.

type Msg = { info: { id: string; role: "user" | "assistant" }; parts: any[] }

function mkUser(id: string, text: string): Msg {
  return { info: { id, role: "user" }, parts: [{ type: "text", id: `${id}_p0`, text }] }
}
function mkAssistant(id: string, text: string): Msg {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", id: `${id}_p0`, text }] }
}

const HISTORY: Msg[] = [
  mkUser("msg_u1", "teach me state machines"),
  mkAssistant("msg_a1", "A state machine is a set of states plus transitions."),
  mkUser("msg_u2", "what about determinism?"),
  mkAssistant("msg_a2", "Determinism means one input sequence yields one run."),
  mkUser("msg_u3", "got it, quiz me"),
  mkAssistant("msg_a3", "Let me check that."),
]

function fakeClient(history: Msg[]) {
  const logs: any[] = []
  return {
    logs,
    session: {
      async messages({ path: p }: any) {
        if (p?.id === "__none__") return []
        return history
      },
    },
    app: {
      async log(body: any) { logs.push(body) },
    },
  } as any
}

let root = ""
let home = ""
let store = ""
let previousEnv: string | undefined
let previousHome: string | undefined

function worktree(name: string) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function vaultFile(name: string) {
  const dir = path.join(root, "vault")
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  if (!fs.existsSync(f)) fs.writeFileSync(f, "", "utf-8")
  return f
}
function read(f: string) { return fs.readFileSync(f, "utf-8") }

/** Boot the plugin against `directory` with the shared canonical store. */
async function boot(directory: string, history: Msg[]) {
  const hooks = await (plugin as any).server({ client: fakeClient(history), directory })
  return hooks
}
async function mdLog(hooks: any, sessionID: string, filepath: string, directory: string) {
  return hooks.tool.md_log.execute({ filepath }, { sessionID, directory, abort: new AbortController() })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mdlog-"))
  home = path.join(root, "home")
  fs.mkdirSync(home, { recursive: true })
  store = path.join(home, "dot-opencode", "learn-md-log.json")
  previousEnv = process.env[MD_LINK_STORE_ENV]
  previousHome = process.env.HOME
  process.env[MD_LINK_STORE_ENV] = store
  process.env.HOME = home
  __resetMdLogState()
})

afterEach(() => {
  if (previousEnv === undefined) delete process.env[MD_LINK_STORE_ENV]
  else process.env[MD_LINK_STORE_ENV] = previousEnv
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  __resetMdLogState()
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
})

// ── (a) Backfill run twice yields a byte-identical file ──────────────────────

describe("md-log idempotency", () => {
  test("backfill run twice yields a byte-identical file", async () => {
    const dir = worktree("wt-a")
    const file = vaultFile("learn-log.md")
    const hooks = await boot(dir, HISTORY)

    const first = await mdLog(hooks, "ses_alpha", file, dir)
    expect(first).toContain("Linked:")
    const afterFirst = read(file)
    // Every message in history is mirrored exactly once.
    for (const m of HISTORY) expect(afterFirst).toContain(m.parts[0].text)
    expect(afterFirst.match(/teach me state machines/g)?.length).toBe(1)

    // Second link, same session, same file — must be a pure no-op.
    const second = await mdLog(hooks, "ses_alpha", file, dir)
    expect(read(file)).toBe(afterFirst)
    expect(second).not.toContain("entries backfilled")

    // A THIRD run after a simulated restart (fresh in-memory state, same store).
    await hooks.dispose?.()
    __resetMdLogState()
    const rebooted = await boot(dir, HISTORY)
    await mdLog(rebooted, "ses_alpha", file, dir)
    expect(read(file)).toBe(afterFirst)
    await rebooted.dispose?.()
  })

  test("every appended entry carries a machine-readable identity marker", async () => {
    const dir = worktree("wt-markers")
    const file = vaultFile("markers.md")
    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_marks", file, dir)
    const ids = readMdEntryIds(read(file))
    // One identity per history message: u:*, a:*
    expect(ids.has(mdEntryId("u", "msg_u1", 0))).toBe(true)
    expect(ids.has(mdEntryId("a", "msg_a1", 0))).toBe(true)
    expect(ids.has(mdEntryId("u", "msg_u3", 0))).toBe(true)
    expect(ids.size).toBe(HISTORY.length)
    await hooks.dispose?.()
  })

  test("live-hook appends are recognised by a later backfill (identity agreement)", async () => {
    const dir = worktree("wt-live")
    const file = vaultFile("live.md")
    const hooks = await boot(dir, [])
    await mdLog(hooks, "ses_live", file, dir)

    // Mirror one message through the live chat.message hook, then run backfill over
    // a history that contains that same message. The shared identity must stop the
    // backfill from writing it a second time.
    await hooks["chat.message"]({ sessionID: "ses_live" }, { message: { id: "msg_u1", sessionID: "ses_live" }, parts: [{ type: "text", text: "teach me state machines" }] })
    const afterLive = read(file)
    expect(afterLive.match(/teach me state machines/g)?.length).toBe(1)

    const rebooted = await boot(dir, HISTORY)
    await mdLog(rebooted, "ses_live", file, dir)
    const after = read(file)
    expect(after.match(/teach me state machines/g)?.length).toBe(1)
    // ...and the rest of history was still mirrored.
    expect(after).toContain("what about determinism?")
    await hooks.dispose?.()
    await rebooted.dispose?.()
  })

  test("never truncates or rewrites existing user notes", async () => {
    const dir = worktree("wt-notes")
    const file = path.join(root, "vault", "notes.md")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const preamble = "# My own notes\n\nHand-written intro I must never lose.\n"
    fs.writeFileSync(file, preamble, "utf-8")

    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_notes", file, dir)
    const after = read(file)
    expect(after.startsWith(preamble)).toBe(true)

    // A second pass must still leave the user's bytes untouched at the head.
    await mdLog(hooks, "ses_notes", file, dir)
    expect(read(file)).toBe(after)
    expect(read(file).startsWith(preamble)).toBe(true)
    await hooks.dispose?.()
  })
})

// ── (b) Re-linking from a different directory/worktree does not duplicate ────

describe("md-log cross-worktree re-link", () => {
  test("re-linking from a DIFFERENT worktree does not duplicate", async () => {
    const dirA = worktree("wt-1")
    const dirB = worktree("wt-2")
    const file = vaultFile("shared.md")

    const hooksA = await boot(dirA, HISTORY)
    await mdLog(hooksA, "ses_travel", file, dirA)
    const afterA = read(file)
    expect(afterA.match(/teach me state machines/g)?.length).toBe(1)

    // A second opencode process in a DIFFERENT worktree: it has never seen this
    // store (no legacy per-directory marker exists there) yet must not re-dump.
    await hooksA.dispose?.()
    __resetMdLogState()
    const hooksB = await boot(dirB, HISTORY)
    await mdLog(hooksB, "ses_travel", file, dirB)
    const afterB = read(file)

    expect(afterB).toBe(afterA)
    for (const m of HISTORY) expect(afterB.match(new RegExp(m.parts[0].text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1)
    await hooksB.dispose?.()
  })
})

// ── (c) Truncated file is repaired with exactly the missing entries ──────────

describe("md-log content-loss repair", () => {
  test("a truncated file is restored with exactly the missing entries", async () => {
    const dir = worktree("wt-trunc")
    const file = vaultFile("trunc.md")

    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_trunc", file, dir)
    const complete = read(file)
    await hooks.dispose?.()

    // Simulate the user's real failure: the file lost its tail (gutted by hand,
    // a bad sync, or a partial write) while the watermark still says "backfilled".
    const tailMarker = "got it, quiz me"
    const cut = complete.indexOf(tailMarker)
    expect(cut).toBeGreaterThan(0)
    const truncated = complete.slice(0, cut).trimEnd() + "\n"
    fs.writeFileSync(file, truncated, "utf-8")

    // Re-link. The watermark alone would have suppressed everything; the identity
    // diff must restore precisely the two missing entries and append nothing else.
    __resetMdLogState()
    const rebooted = await boot(dir, HISTORY)
    const result = await mdLog(rebooted, "ses_trunc", file, dir)
    const repaired = read(file)

    expect(result).toContain("2 entries backfilled")
    expect(repaired).toContain("got it, quiz me")
    expect(repaired).toContain("Let me check that.")
    // Everything that survived must appear exactly once — nothing re-appended.
    expect(repaired.match(/teach me state machines/g)?.length).toBe(1)
    expect(repaired.match(/what about determinism\?/g)?.length).toBe(1)
    expect(repaired.match(/Determinism means one input sequence yields one run\./g)?.length).toBe(1)
    // And the repair is itself idempotent.
    await mdLog(rebooted, "ses_trunc", file, dir)
    expect(read(file)).toBe(repaired)
    await rebooted.dispose?.()
  })

  test("a marker whose body was cut away is repaired, not trusted", async () => {
    const dir = worktree("wt-halfentry")
    const file = vaultFile("halfentry.md")

    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_half", file, dir)
    const complete = read(file)
    await hooks.dispose?.()

    // Truncate in the MIDDLE of the last entry: its identity marker survives but the
    // body it introduced is gone. A marker-only check would call this file complete
    // and the lost content would never come back.
    const lastMarker = complete.lastIndexOf("<!-- learn-md:")
    const lastBody = complete.indexOf("Let me check that.", lastMarker)
    expect(lastMarker).toBeGreaterThan(0)
    expect(lastBody).toBeGreaterThan(lastMarker)
    fs.writeFileSync(file, complete.slice(0, lastMarker + "<!-- learn-md:a:msg_a3#0 -->\n".length), "utf-8")
    // The dangling marker is still there — only its text was lost.
    expect(read(file)).toContain("<!-- learn-md:a:msg_a3#0 -->")

    __resetMdLogState()
    const rebooted = await boot(dir, HISTORY)
    const result = await mdLog(rebooted, "ses_half", file, dir)
    expect(result).toContain("entries backfilled")
    const repaired = read(file)
    expect(repaired).toContain("Let me check that.")
    // Nothing that survived was duplicated.
    expect(repaired.match(/teach me state machines/g)?.length).toBe(1)
    // And the repair is idempotent.
    await mdLog(rebooted, "ses_half", file, dir)
    expect(read(file)).toBe(repaired)
    await rebooted.dispose?.()
  })

  test("a watermark that survived a wipe cannot suppress restored content", async () => {
    const dir = worktree("wt-wipe")
    const file = vaultFile("wiped.md")

    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_wipe", file, dir)
    await hooks.dispose?.()

    // Store still holds backfilledUntil === last message id...
    const stored = JSON.parse(fs.readFileSync(store, "utf-8"))
    expect(stored.links.ses_wipe.backfilledUntil).toBe("msg_a3")

    // ...but the file was emptied entirely.
    fs.writeFileSync(file, "", "utf-8")

    __resetMdLogState()
    const rebooted = await boot(dir, HISTORY)
    const result = await mdLog(rebooted, "ses_wipe", file, dir)
    const restored = read(file)
    expect(result).toContain(`${HISTORY.length} entries backfilled`)
    for (const m of HISTORY) expect(restored).toContain(m.parts[0].text)
    await rebooted.dispose?.()
  })

  test("a legacy file with no markers is still not duplicated", async () => {
    const dir = worktree("wt-legacy-content")
    const file = vaultFile("legacy.md")

    const hooks = await boot(dir, HISTORY)
    await mdLog(hooks, "ses_leg", file, dir)
    const written = read(file)
    await hooks.dispose?.()

    // Strip the markers, leaving the bare content a pre-marker version would produce.
    const stripped = written.replace(/^<!--\s*learn-md:[^\s]+ -->\n/gm, "").replace(/\n{3,}/g, "\n\n")
    fs.writeFileSync(file, stripped, "utf-8")

    __resetMdLogState()
    const rebooted = await boot(dir, HISTORY)
    await mdLog(rebooted, "ses_leg", file, dir)
    const after = read(file)
    // Text-based dedup must not re-dump an unmarked legacy file.
    expect(after.match(/teach me state machines/g)?.length).toBe(1)
    expect(after.match(/what about determinism\?/g)?.length).toBe(1)
    await rebooted.dispose?.()
  })
})

// ── (d) The 1-1-1 guard holds across worktrees ───────────────────────────────

describe("md-log 1-1-1 across stores", () => {
  test("two sessions cannot link the same file from different worktrees", async () => {
    const dirA = worktree("wt-guard-a")
    const dirB = worktree("wt-guard-b")
    const file = vaultFile("guarded.md")

    const hooksA = await boot(dirA, HISTORY)
    const ok = await mdLog(hooksA, "ses_owner", file, dirA)
    expect(ok).toContain("Linked:")
    await hooksA.dispose?.()

    // Different process, different worktree, different session: the binding must survive.
    __resetMdLogState()
    const hooksB = await boot(dirB, HISTORY)
    const denied = await mdLog(hooksB, "ses_intruder", file, dirB)
    expect(denied).toContain("1-1-1 violation")
    expect(denied).toContain("ses_owner".slice(0, 8))
    await hooksB.dispose?.()

    // The rejected session mirrored nothing.
    expect(read(file).match(/teach me state machines/g)?.length).toBe(1)
  })

  test("the owning session can still re-link the same file from another worktree", async () => {
    const dirA = worktree("wt-own-a")
    const dirB = worktree("wt-own-b")
    const file = vaultFile("owned.md")

    const hooksA = await boot(dirA, HISTORY)
    await mdLog(hooksA, "ses_owner", file, dirA)
    const afterA = read(file)
    await hooksA.dispose?.()

    __resetMdLogState()
    const hooksB = await boot(dirB, HISTORY)
    const ok = await mdLog(hooksB, "ses_owner", file, dirB)
    expect(ok).toContain("Linked:")
    expect(read(file)).toBe(afterA)
    await hooksB.dispose?.()
  })

  test("md_unlog releases the binding for another worktree", async () => {
    const dirA = worktree("wt-unlog-a")
    const dirB = worktree("wt-unlog-b")
    const file = vaultFile("released.md")

    const hooksA = await boot(dirA, HISTORY)
    await mdLog(hooksA, "ses_first", file, dirA)
    const out = await hooksA.tool.md_unlog.execute({}, { sessionID: "ses_first", directory: dirA, abort: new AbortController() })
    expect(out).toContain("Unlinked:")
    await hooksA.dispose?.()

    __resetMdLogState()
    const hooksB = await boot(dirB, HISTORY)
    const ok = await mdLog(hooksB, "ses_second", file, dirB)
    expect(ok).toContain("Linked:")
    await hooksB.dispose?.()
  })
})

// ── (e) Legacy per-directory stores merge into the canonical one ─────────────

describe("md-log store unification", () => {
  function writeLegacy(directory: string, links: Record<string, any>) {
    const p = path.join(directory, ".opencode", "learn-md-log.json")
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ version: 1, links }, null, 2), "utf-8")
    return p
  }

  test("the real two-store layout merges into one canonical store", () => {
    // Reproduces the exact situation on the developer's machine: a home-directory
    // canonical store with 1 link, plus a vault worktree legacy store with 2 links.
    // Both must survive the migration; nothing may be dropped.
    const home = path.join(root, "home")
    const vaultDir = path.join(root, "Code", "vault", "personal")
    fs.mkdirSync(path.join(home, ".opencode"), { recursive: true })
    fs.mkdirSync(path.join(vaultDir, ".opencode"), { recursive: true })
    const mail = path.join(vaultDir, "mail-reply.md")
    const automata = path.join(vaultDir, "automata-log.md")
    const iot = path.join(vaultDir, "Iot-learn-log.md")
    for (const f of [mail, automata, iot]) fs.writeFileSync(f, "# notes\n", "utf-8")

    // Canonical already holds the link made from the home directory.
    fs.mkdirSync(path.dirname(store), { recursive: true })
    fs.writeFileSync(store, JSON.stringify({
      version: 2,
      links: { ses_home: { file: mail, directory: home, linkedAt: 1789109003080, backfilledUntil: "msg_08f3" } },
      legacyStoreDirs: [home],
    }, null, 2), "utf-8")
    // The vault worktree still has its own legacy store with two links.
    writeLegacy(vaultDir, {
      ses_automata: { file: automata, directory: vaultDir, linkedAt: 1 },
      ses_iot: { file: iot, directory: vaultDir, linkedAt: 2 },
    })
    process.env[MD_LINK_EXTRA_STORES_ENV] = path.join(vaultDir, ".opencode", "learn-md-log.json")
    try {
      __resetMdLogState()
      const { count, migrated } = loadMdLinks(vaultDir)
      expect(count).toBe(3)
      expect(migrated).toBe(2)

      saveMdLinks(vaultDir)
      const merged = JSON.parse(fs.readFileSync(canonicalMdLinkStorePath(), "utf-8"))
      expect(Object.keys(merged.links).sort()).toEqual(["ses_automata", "ses_home", "ses_iot"])
      // The home link's watermark survived the merge.
      expect(merged.links.ses_home.backfilledUntil).toBe("msg_08f3")
      // The legacy store is still on disk, untouched.
      expect(fs.existsSync(path.join(vaultDir, ".opencode", "learn-md-log.json"))).toBe(true)
    } finally {
      delete process.env[MD_LINK_EXTRA_STORES_ENV]
    }
  })

  test("canonical store defaults to a user-level path outside any worktree", () => {
    delete process.env[MD_LINK_STORE_ENV]
    const p = canonicalMdLinkStorePath()
    expect(p.startsWith(os.homedir())).toBe(true)
    expect(p).toBe(path.join(os.homedir(), ".opencode", "learn-md-log.json"))
    // It must not live inside a worktree, or the binding would not be shared.
    expect(p).not.toContain(`${path.sep}wt-`)
  })

  test("legacy per-directory store is merged into the canonical store without data loss", async () => {
    const dirA = worktree("wt-legacy-a")
    const dirB = worktree("wt-legacy-b")
    const fileA = vaultFile("legacy-a.md")
    const fileB = vaultFile("legacy-b.md")

    // Two pre-existing per-worktree stores, as on the user's machine today.
    writeLegacy(dirA, { ses_old_a: { file: fileA, directory: dirA, linkedAt: 1, backfilledUntil: "msg_a1" } })
    writeLegacy(dirB, { ses_old_b: { file: fileB, directory: dirB, linkedAt: 2 } })

    // First launch from dirA migrates its own store and records dirA as a known
    // legacy-store directory in the canonical store.
    const hooksA = await boot(dirA, HISTORY)
    expect(await hooksA.tool.md_log_status.execute({}, { sessionID: "p", directory: dirA, abort: new AbortController() }))
      .toContain("links across all worktrees: 1")
    expect(JSON.parse(fs.readFileSync(canonicalMdLinkStorePath(), "utf-8")).legacyStoreDirs).toContain(dirA)
    await hooksA.dispose?.()

    // A later launch from dirB merges BOTH: its own link plus the one migrated from
    // dirA — no data is dropped on either side of the migration.
    __resetMdLogState()
    const hooksB = await boot(dirB, HISTORY)
    const status = await hooksB.tool.md_log_status.execute({}, { sessionID: "ses_probe", directory: dirB, abort: new AbortController() })
    expect(status).toContain("links across all worktrees: 2")

    // ...and the merged set is persisted to the canonical store.
    const canonical = JSON.parse(fs.readFileSync(canonicalMdLinkStorePath(), "utf-8"))
    expect(Object.keys(canonical.links).sort()).toEqual(["ses_old_a", "ses_old_b"])
    expect(canonical.links.ses_old_a.file).toBe(fileA)
    expect(canonical.links.ses_old_a.backfilledUntil).toBe("msg_a1")
    expect(canonical.links.ses_old_b.file).toBe(fileB)
    expect(canonical.links.ses_old_b.directory).toBe(dirB)

    // The legacy files themselves are left in place (never deleted or moved).
    expect(fs.existsSync(path.join(dirB, ".opencode", "learn-md-log.json"))).toBe(true)
    await hooksB.dispose?.()
  })

  test("an explicitly registered extra store is merged on load", async () => {
    const dirA = worktree("wt-extra-a")
    const dirB = worktree("wt-extra-b")
    const fileA = vaultFile("extra-a.md")
    const fileB = vaultFile("extra-b.md")
    writeLegacy(dirA, { ses_xa: { file: fileA, directory: dirA, linkedAt: 1 } })
    writeLegacy(dirB, { ses_xb: { file: fileB, directory: dirB, linkedAt: 2 } })

    // A store the process has never launched from is still reachable when the path is
    // registered explicitly, so the 1-1-1 guard sees every known link on first boot.
    process.env[MD_LINK_EXTRA_STORES_ENV] = path.join(dirB, ".opencode", "learn-md-log.json")
    try {
      const hooks = await boot(dirA, HISTORY)
      const status = await hooks.tool.md_log_status.execute({}, { sessionID: "p", directory: dirA, abort: new AbortController() })
      expect(status).toContain("links across all worktrees: 2")
      await hooks.dispose?.()
    } finally {
      delete process.env[MD_LINK_EXTRA_STORES_ENV]
    }
  })

  test("a link only present in a legacy store is honoured by the 1-1-1 guard", async () => {
    const dirA = worktree("wt-guard-legacy-a")
    const dirB = worktree("wt-guard-legacy-b")
    const file = vaultFile("legacy-guarded.md")
    writeLegacy(dirB, { ses_legacy_owner: { file, directory: dirB, linkedAt: 5 } })
    process.env[MD_LINK_EXTRA_STORES_ENV] = path.join(dirB, ".opencode", "learn-md-log.json")

    // Boot in dirA, where no local store mentions the file at all.
    const hooks = await boot(dirA, HISTORY)
    const denied = await mdLog(hooks, "ses_other", file, dirA)
    expect(denied).toContain("1-1-1 violation")
    expect(denied).toContain("ses_legacy_owner".slice(0, 8))
    await hooks.dispose?.()
    delete process.env[MD_LINK_EXTRA_STORES_ENV]
  })

  test("canonical store wins conflicts and never discards a watermark", async () => {
    const dir = worktree("wt-conflict")
    const file = vaultFile("conflict.md")
    const canonical = canonicalMdLinkStorePath()
    fs.mkdirSync(path.dirname(canonical), { recursive: true })
    fs.writeFileSync(canonical, JSON.stringify({ version: 2, links: { ses_x: { file, directory: dir, linkedAt: 10 } } }, null, 2), "utf-8")
    // Legacy disagrees on the directory and carries the only watermark.
    writeLegacy(dir, { ses_x: { file, directory: dir, linkedAt: 99, backfilledUntil: "msg_a3" } })

    const { count } = loadMdLinks(dir)
    expect(count).toBe(1)
    const hooks = await boot(dir, HISTORY)
    const status = await hooks.tool.md_log_status.execute({}, { sessionID: "ses_x", directory: dir, abort: new AbortController() })
    expect(status).toContain("links across all worktrees: 1")

    saveMdLinks(dir)
    const after = JSON.parse(fs.readFileSync(canonical, "utf-8"))
    expect(after.links.ses_x.linkedAt).toBe(99)
    expect(after.links.ses_x.backfilledUntil).toBe("msg_a3")
    await hooks.dispose?.()
  })

  test("legacy {file}-only marker is backed up, not auto-migrated", async () => {
    const dir = worktree("wt-oldshape")
    const file = vaultFile("oldshape.md")
    const p = path.join(dir, ".opencode", "learn-md-log.json")
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ file }), "utf-8")

    const hooks = await boot(dir, HISTORY)
    expect(fs.existsSync(`${p}.bak`)).toBe(true)
    const status = await hooks.tool.md_log_status.execute({}, { sessionID: "ses_probe", directory: dir, abort: new AbortController() })
    expect(status).toContain("links across all worktrees: 0")
    await hooks.dispose?.()
  })

  test("links whose target file vanished are dropped, not resurrected", async () => {
    const dir = worktree("wt-gone")
    writeLegacy(dir, { ses_gone: { file: path.join(root, "vault", "does-not-exist.md"), directory: dir, linkedAt: 1 } })
    const hooks = await boot(dir, HISTORY)
    const status = await hooks.tool.md_log_status.execute({}, { sessionID: "ses_probe", directory: dir, abort: new AbortController() })
    expect(status).toContain("links across all worktrees: 0")
    await hooks.dispose?.()
  })
})

// ── Tool surface (D) unchanged ───────────────────────────────────────────────

describe("md-log tool surface", () => {
  test("tool names and the 1-1-1 contract are unchanged", async () => {
    const dir = worktree("wt-surface")
    const hooks = await boot(dir, HISTORY)
    for (const name of ["md_log", "md_log_status", "md_unlog"]) expect(typeof hooks.tool[name]?.execute).toBe("function")
    expect(hooks.tool.md_log.description).toContain("bound 1-1-1 to this sessionID")
    expect(hooks.tool.md_unlog.description).toContain("Stop mirroring THIS session")

    const file = vaultFile("surface.md")
    const linked = await mdLog(hooks, "ses_s", file, dir)
    expect(linked).toContain(`Linked: ${file} to session ses_s`)
    expect(linked).toContain("future messages for THIS session will be mirrored. Other sessions stay silent.")

    const noSession = await hooks.tool.md_log.execute({ filepath: file }, { directory: dir, abort: new AbortController() })
    expect(noSession).toBe("md_log error: no sessionID in context — cannot establish 1-1-1 link")

    const missing = await mdLog(hooks, "ses_s", path.join(root, "nope.md"), dir)
    expect(missing).toContain("File does not exist:")

    expect(await hooks.tool.md_unlog.execute({}, { sessionID: "nobody", directory: dir, abort: new AbortController() })).toBe("No file linked for this session")
    await hooks.dispose?.()
  })
})