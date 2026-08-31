#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const packageName = "@bojackduy/opencode-learn"
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version
const packageSpec = `${packageName}@${packageVersion}`
const configCandidates = ["opencode.json", "opencode.jsonc", "config.json", "config.jsonc"]
const tuiCandidates = ["tui.json", "tui.jsonc"]
const installerArgs = process.argv.slice(2)
const uninstallRequested = installerArgs.length === 1 && ["--uninstall", "uninstall", "--remove"].includes(installerArgs[0] || "")

if (installerArgs.includes("--help") || installerArgs.includes("-h")) {
  console.log(`opencode-learn installer — port of amosblomqvist/learn (video: How I Use AI to Learn Things) to OpenCode

Original: pi by Mario Zechner (earendil-works/pi) + learn by Amos Blomqvist (amosblomqvist/learn) — https://www.youtube.com/watch?v=kzcI5F4tGiU

Usage:
  opencode-learn
  npx -y @bojackduy/opencode-learn@latest
  npx -y @bojackduy/opencode-learn@latest --uninstall

Install/update registers plugins (server + tui), installs agents (researcher, mermaid-maker, svg-maker), skills (teach, visualize), and commands (md_log/md_unlog).
Uninstall removes plugin registrations, agents, skills, and commands.

Set OPENCODE_CONFIG_DIR to target a non-default OpenCode config directory.`)
  process.exit(0)
}

if (installerArgs.includes("--version") || installerArgs.includes("-v")) {
  console.log(packageVersion)
  process.exit(0)
}

if (installerArgs.length && !uninstallRequested) {
  console.error(`Unknown installer option: ${installerArgs[0]}`)
  process.exit(2)
}

function stripJsonComments(input) {
  let out = "", quote = "", esc = false, lc = false, bc = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i], n = input[i + 1]
    if (lc) { if (c === "\n" || c === "\r") { lc = false; out += c } continue }
    if (bc) { if (c === "*" && n === "/") { bc = false; i++ } else if (c === "\n" || c === "\r") out += c; continue }
    if (quote) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === quote) quote = ""; continue }
    if (c === '"') { quote = c; out += c; continue }
    if (c === "/" && n === "/") { lc = true; i++; continue }
    if (c === "/" && n === "*") { bc = true; i++; continue }
    out += c
  }
  return out
}
function stripTrailingCommas(input) {
  let out = "", quote = "", esc = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quote) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === quote) quote = ""; continue }
    if (c === '"') { quote = c; out += c; continue }
    if (c === ",") { let j = i + 1; while (/\s/.test(input[j] || "")) j++; if (input[j] === "]" || input[j] === "}") continue }
    out += c
  }
  return out
}
function parseJsonc(input) {
  const p = JSON.parse(stripTrailingCommas(stripJsonComments(input)))
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("OpenCode config root must be an object")
  return p
}
function isPackageSpec(v, base) {
  const s = String(v || "").trim()
  return s === base || s === `${base}@${packageVersion}` || s.startsWith(`${base}@`) || s === packageName || s.startsWith(`${packageName}@`)
}
function isLearnPluginSpec(v) {
  return isPackageSpec(v, packageName) || isPackageSpec(v, `${packageName}/tui`) || isPackageSpec(v, `${packageName}/server`)
}
function skipTrivia(s, i) { while (i < s.length) { const c=s[i]||"", n=s[i+1]||""; if (/\s/.test(c)) {i++;continue} if (c==="/"&&n==="/") {i+=2; while(i<s.length&&s[i]!=="\n"&&s[i]!=="\r") i++; continue} if (c==="/"&&n==="*") { const e=s.indexOf("*/",i+2); if(e<0) throw new Error("unterminated block comment"); i=e+2; continue } break } return i }
function readJsonString(s, i) { if(s[i]!=='"') throw new Error("expected JSON string"); let esc=false; for(let j=i+1;j<s.length;j++){const c=s[j]||""; if(esc){esc=false; continue} if(c==="\\"){esc=true;continue} if(c==='"'){return {value:JSON.parse(s.slice(i,j+1)), end:j+1}}} throw new Error("unterminated JSON string") }
function skipJsonValue(s,i){ const vs=skipTrivia(s,i), f=s[vs]; if(f==='"') return readJsonString(s,vs).end; if(f==="{"||f==="["){const st=[]; let q=false,esc=false,lc=false,bc=false; for(let j=vs;j<s.length;j++){const c=s[j]||"",n=s[j+1]||""; if(lc){if(c==="\n"||c==="\r") lc=false; continue} if(bc){if(c==="*"&&n==="/"){bc=false;j++} continue} if(q){if(esc) esc=false; else if(c==="\\") esc=true; else if(c==='"') q=false; continue} if(c==='"'){q=true;continue} if(c==="/"&&n==="/"){lc=true;j++;continue} if(c==="/"&&n==="*"){bc=true;j++;continue} if(c==="{"||c==="[") st.push(c); else if(c==="}"||c==="]"){const e=c==="}"?"{":"["; if(st.at(-1)!==e) throw new Error("mismatched delimiters"); st.pop(); if(!st.length) return j+1} } throw new Error("unterminated JSON value") } let j=vs; while(j<s.length&&![",","}","]"].includes(s[j])) j++; return j }
function findRootProperty(s, name){ let i=skipTrivia(s,0); if(s[i]!=="{") throw new Error("OpenCode config must be root object"); i++; while(true){ i=skipTrivia(s,i); if(s[i]==="}") return null; const k=readJsonString(s,i); i=skipTrivia(s,k.end); if(s[i]!==":") throw new Error(`expected ':' after ${k.value}`); const vs=skipTrivia(s,i+1), ve=skipJsonValue(s,vs); if(k.value===name){ const ls=Math.max(s.lastIndexOf("\n",vs-1),s.lastIndexOf("\r",vs-1))+1; const kls=Math.max(s.lastIndexOf("\n",k.end-1),s.lastIndexOf("\r",k.end-1))+1; const indent=s.slice(kls,k.end-k.value.length-2).match(/^[\t ]*/)?.[0]||"  "; return {valueStart:vs,valueEnd:ve,indent,lineStart:ls} } const av=skipTrivia(s,ve); if(s[av]===",") i=av+1; else if(s[av]==="}") return null; else throw new Error(`expected ',' or '}' after ${k.value}`) } }
function formatPluginArray(vals, indent, eol){ if(!vals.length) return "[]"; const ci=`${indent}  `; return `[${eol}${vals.map(v=>`${ci}${JSON.stringify(v)}`).join(`,${eol}`)}${eol}${indent}]` }
function rewriteExistingPluginArray(source, next){ const prop=findRootProperty(source,"plugin"); if(!prop) return source; const eol=source.includes("\r\n")?"\r\n":"\n"; const rep=formatPluginArray(next,prop.indent,eol); return `${source.slice(0,prop.valueStart)}${rep}${source.slice(prop.valueEnd)}` }

async function configurePlugins(isUninstall) {
  const allCandidates = [...new Set([...configCandidates, ...tuiCandidates])]
  const plans = []
  for (const name of allCandidates) {
    const target = join(config, name)
    try {
      const source = await readFile(target, "utf8")
      const parsed = parseJsonc(source)
      if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) throw new Error("plugin must be array")
      const plugins = parsed.plugin || []
      let next
      if (isUninstall) {
        next = plugins.filter(v => !isLearnPluginSpec(v))
      } else {
        // Keep non-learn plugins, add/update learn
        next = plugins.filter(v => !isLearnPluginSpec(v))
        // Determine if this is tui.json vs opencode.json
        const isTui = name.startsWith("tui.")
        if (isTui) next.push(`${packageName}/tui`)
        else next.push(packageName)
        // Deduplicate
        next = [...new Set(next)]
      }
      const updated = next.length === plugins.length && next.every((v,i)=>v===plugins[i]) ? source : rewriteExistingPluginArray(source, next)
      // If file had no plugin property and we are installing, create it
      if (!findRootProperty(source, "plugin") && !isUninstall) {
        const eol = source.includes("\r\n") ? "\r\n" : "\n"
        const indent = "  "
        const isTui = name.startsWith("tui.")
        const spec = isTui ? `${packageName}/tui` : packageName
        const pluginStr = `,\n${indent}"plugin": ${formatPluginArray([spec], indent, eol)}`
        // Insert before final }
        const lastBrace = source.lastIndexOf("}")
        const updated2 = source.slice(0, lastBrace) + pluginStr + "\n" + source.slice(lastBrace)
        plans.push({ target, source, updated: updated2 })
      } else {
        plans.push({ target, source, updated })
      }
    } catch (e) {
      if (e?.code !== "ENOENT") throw new Error(`Could not inspect ${target}: ${e.message}`)
      if (!isUninstall) {
        // Create new config file if it doesn't exist
        const isTui = name.startsWith("tui.")
        const spec = isTui ? `${packageName}/tui` : packageName
        // Only create opencode.jsonc and tui.jsonc by default
        if ((name === "opencode.jsonc" || name === "tui.jsonc") && !isUninstall) {
          const content = `{\n  "plugin": ["${spec}"]\n}\n`
          plans.push({ target, source: "", updated: content, isNew: true })
        }
      }
    }
  }
  // Filter to only files that actually changed or are new
  const toWrite = plans.filter(p => p.updated !== p.source)
  for (const p of toWrite) {
    await writeFile(p.target, p.updated, "utf8")
  }
  return toWrite.length
}

async function copyDir(src, dest, filter) {
  await mkdir(dest, { recursive: true })
  let count = 0
  try {
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      if (entry.isDirectory()) {
        count += await copyDir(s, d, filter)
      } else if (!filter || filter(entry.name)) {
        await copyFile(s, d)
        count++
      }
    }
  } catch (e) {
    if (e?.code !== "ENOENT") throw e
  }
  return count
}

async function removeDirIfEmpty(dir) {
  try {
    const files = await readdir(dir)
    if (!files.length) await rm(dir, { recursive: true, force: true })
  } catch {}
}

async function installOrUpdate() {
  // Ensure config dirs
  await mkdir(join(config, "agents"), { recursive: true })
  await mkdir(join(config, "skills"), { recursive: true })
  await mkdir(join(config, "commands"), { recursive: true })

  const changed = await configurePlugins(false)

  // Copy agents
  const agentsSrc = join(root, "agents")
  const agentsDest = join(config, "agents")
  let agentsCount = 0
  for (const f of ["researcher.md", "mermaid-maker.md", "svg-maker.md", "classify.md"]) {
    try {
      await copyFile(join(agentsSrc, f), join(agentsDest, f))
      agentsCount++
    } catch {}
  }

  // Copy skills
  const skills = ["teach", "visualize", "marker-pdf-parser", "notebooklm-lecture-notes"]
  let skillsCount = 0
  for (const s of skills) {
    const src = join(root, "skills", s)
    const dest = join(config, "skills", s)
    const c = await copyDir(src, dest, n => n === "SKILL.md")
    skillsCount += c
  }

  // Copy commands (if any)
  const commandsSrc = join(root, "commands")
  const commandsDest = join(config, "commands")
  let commandsCount = 0
  try {
    for (const f of await readdir(commandsSrc)) {
      if (f.endsWith(".md")) {
        await copyFile(join(commandsSrc, f), join(commandsDest, f))
        commandsCount++
      }
    }
  } catch {}

  console.log(`Installed ${packageName}@${packageVersion} to ${config}`)
  if (changed) console.log(`Updated plugin registration in ${changed} config file(s)`)
  console.log(`  Agents: ${agentsCount} (researcher, mermaid-maker, svg-maker, classify)`)
  console.log(`  Skills: ${skillsCount} (teach, visualize, marker-pdf-parser, notebooklm-lecture-notes)`)
  if (commandsCount) console.log(`  Commands: ${commandsCount}`)
  console.log(`  Plugin: ${packageName} (server) + ${packageName}/tui (TUI)`)
  console.log("\nRestart OpenCode to load plugins.")
  console.log("  /md_log <file>  — mirror to Obsidian")
  console.log("  quiz / quiz_batch — graded checks")
  console.log("  task subagent_type=researcher/mermaid-maker/svg-maker")
}

async function uninstall() {
  const changed = await configurePlugins(true)

  // Remove agents (only those we own)
  for (const f of ["researcher.md", "mermaid-maker.md", "svg-maker.md", "classify.md"]) {
    try { await rm(join(config, "agents", f), { force: true }) } catch {}
  }
  // Remove skills (including subdirectories like scripts/assets)
  for (const s of ["teach", "visualize", "marker-pdf-parser", "notebooklm-lecture-notes"]) {
    try { await rm(join(config, "skills", s), { recursive: true, force: true }) } catch {}
  }
  // Remove commands
  for (const f of ["md_log.md", "md_unlog.md"]) {
    try { await rm(join(config, "commands", f), { force: true }) } catch {}
  }

  console.log(changed ? `Removed ${packageName} from ${changed} config file(s).` : `${packageName} was not registered.`)
  console.log("Removed agents and skills when present. Restart OpenCode to finish unloading.")
}

if (uninstallRequested) await uninstall()
else await installOrUpdate()
