import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

const P4 = process.env.OPENCODE_P4_BIN || "p4"
const TIMEOUT_MS = 120_000
const MAX_CHARS = 40_000
const MAX_DESCRIBED_CHANGES = 25
const DIFF_ACTIONS = new Set(["edit", "integrate", "move/add"])
const NEW_ACTIONS = new Set(["add", "branch", "import"])

type Rec = Record<string, string | number>

interface P4Result {
  records: Rec[]
  text: string
  info: string[]
  warnings: string[]
  errors: string[]
}

interface ToolCtx {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal: AbortSignal
}

// Never let p4 start an external diff, merge, pager or editor: output must stay plain text.
// p4 takes its working directory from $PWD, so it must match cwd for P4CONFIG lookup.
const p4Env = (cwd: string) => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of ["P4DIFF", "P4DIFFUNICODE", "P4MERGE", "P4PAGER", "P4EDITOR"]) delete env[name]
  env.P4EDITOR = "true"
  env.PWD = cwd
  return env
}

const run = (args: string[], cwd: string, signal: AbortSignal, json: boolean) =>
  new Promise<P4Result>((resolve, reject) => {
    const full = ["-zprog=opencode-perforce", ...(json ? ["-Mj", "-ztag"] : []), ...args]
    execFile(
      P4,
      full,
      { cwd, env: p4Env(cwd), signal, timeout: TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (error && typeof code !== "number") {
          const killed = (error as { killed?: boolean }).killed
          const reason = killed ? `timed out after ${TIMEOUT_MS / 1000}s` : error.message.split("\n")[0]
          return reject(new Error(`p4 ${args[0]} failed: ${reason}`))
        }
        const result: P4Result = { records: [], text: "", info: [], warnings: [], errors: [] }
        if (json) {
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue
            let rec: Rec
            try {
              rec = JSON.parse(line) as Rec
            } catch {
              result.info.push(line)
              continue
            }
            const severity = typeof rec.severity === "number" ? rec.severity : undefined
            if (severity !== undefined && "data" in rec) {
              ;(severity >= 3 ? result.errors : severity === 2 ? result.warnings : result.info).push(
                String(rec.data).trim(),
              )
            } else if ("level" in rec && "data" in rec && Object.keys(rec).length === 2) {
              result.info.push(String(rec.data).trim())
            } else {
              result.records.push(rec)
            }
          }
        } else {
          result.text = stdout
        }
        const err = stderr.trim()
        if (err) (code ? result.errors : result.warnings).push(err)
        if (code && result.errors.length === 0) result.errors.push(`p4 exited with code ${code}`)
        resolve(result)
      },
    )
  })

const truncate = (text: string, max = MAX_CHARS, hint = "narrow the request") => {
  if (text.length <= max) return text
  const cut = text.lastIndexOf("\n", max)
  return `${text.slice(0, cut > 0 ? cut : max)}\n… output truncated at ${max} characters (${text.length} total); ${hint}.`
}

const firstLine = (text: unknown, max = 200) => {
  const line = String(text ?? "").trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const indent = (text: unknown, prefix = "    ") =>
  String(text ?? "")
    .trimEnd()
    .split("\n")
    .map((line) => prefix + line)
    .join("\n")

const date = (epoch: unknown) => {
  const seconds = Number(epoch)
  if (!Number.isFinite(seconds) || seconds <= 0) return String(epoch ?? "")
  return new Date(seconds * 1000).toISOString().slice(0, 10).replaceAll("-", "/")
}

/** Joins the output with any messages p4 printed, or fails when p4 produced only errors. */
const finish = (result: P4Result, body: string, empty = "(no results)") => {
  const hasBody = body.trim().length > 0
  if (!hasBody && result.errors.length) throw new Error(result.errors.join("\n"))
  const parts = hasBody ? [body.trimEnd()] : result.warnings.length ? [] : [empty]
  if (result.info.length) parts.push(`messages:\n${indent(result.info.join("\n"), "  ")}`)
  if (result.warnings.length) parts.push(`warnings:\n${indent(result.warnings.join("\n"), "  ")}`)
  if (result.errors.length) parts.push(`errors:\n${indent(result.errors.join("\n"), "  ")}`)
  return { content: parts.join("\n\n") }
}

const checkArgs = (values: readonly unknown[]) => {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) throw new Error("File arguments must be non-empty strings.")
    if (value.startsWith("-")) throw new Error(`Invalid file argument "${value}": must not start with "-".`)
  }
  return values as string[]
}

const toList = (value: unknown): string[] =>
  value === undefined ? [] : checkArgs(Array.isArray(value) ? value : [value])

const isDepotPath = (file: string) => file.startsWith("//")
const stripRevision = (file: string) => file.replace(/[#@].*$/, "")

const existingDir = async (target: string) => {
  let current = target
  for (;;) {
    try {
      const info = await stat(current)
      return info.isDirectory() ? current : path.dirname(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

const cwdProperty = {
  cwd: {
    type: "string",
    description:
      "Directory inside the Perforce workspace, used to find the workspace (P4CONFIG). Defaults to the directory of the first local file, then the session directory.",
  },
} as const

const fileList = (description: string) => ({
  type: "array",
  items: { type: "string" },
  minItems: 1,
  description,
})

export default Plugin.define({
  id: "perforce",
  async setup(ctx) {
    const sessionDirs = new Map<string, string>()

    const sessionDirectory = async (sessionID: string) => {
      const cached = sessionDirs.get(sessionID)
      if (cached) return cached
      let directory: string = ctx.location.directory
      try {
        const session = (await ctx.session.get({ sessionID })) as { location?: { directory?: string } }
        directory = session.location?.directory ?? directory
      } catch {
        // Fall back to the plugin location.
      }
      sessionDirs.set(sessionID, directory)
      return directory
    }

    /** Picks the directory p4 runs in, so P4CONFIG finds the right workspace. */
    const resolveCwd = async (context: ToolCtx, cwd: unknown, files: string[] = []) => {
      const base = await sessionDirectory(context.sessionID)
      if (typeof cwd === "string" && cwd.trim()) {
        const dir = await existingDir(path.resolve(base, cwd))
        if (!dir) throw new Error(`Directory not found: ${cwd}`)
        return dir
      }
      const local = files.find((file) => !isDepotPath(file))
      if (local) return (await existingDir(path.resolve(base, stripRevision(local)))) ?? base
      return base
    }

    /** Runs p4 with `files` appended; local paths are made absolute since p4 may run in another directory. */
    const p4 = async (context: ToolCtx, args: string[], options: { cwd: unknown; files?: string[]; json?: boolean }) => {
      const base = await sessionDirectory(context.sessionID)
      const files = (options.files ?? []).map((file) => {
        if (isDepotPath(file)) return file
        const revision = file.slice(stripRevision(file).length)
        return path.resolve(base, stripRevision(file)) + revision
      })
      const cwd = await resolveCwd(context, options.cwd, files)
      return run([...args, ...files], cwd, context.signal, options.json ?? true)
    }

    const askWrite = async (context: ToolCtx, tool: string, files: string[]) => {
      await ctx.permission.assert({
        sessionID: context.sessionID as never,
        agent: context.agent as never,
        source: { type: "tool", messageID: context.messageID as never, id: context.id as never },
        action: tool,
        resources: files,
        save: files,
      })
    }

    const describeChanges = async (context: ToolCtx, cwd: unknown, changes: string[]) => {
      if (!changes.length) return new Map<string, Rec>()
      const result = await p4(context, ["describe", "-s", "-m", "1", ...changes], { cwd })
      return new Map(result.records.map((rec) => [String(rec.change), rec]))
    }

    const fileRecordLines = (records: Rec[]) =>
      records
        .map((rec) => {
          const target = rec.clientFile ?? rec.path ?? ""
          const rev = rec.workRev ?? rec.rev ?? rec.haveRev
          const head = `${rec.depotFile ?? target}${rev ? `#${rev}` : ""}`
          return [head, rec.action, rec.change ? `change ${rec.change}` : undefined, rec.type ? `(${rec.type})` : undefined]
            .filter(Boolean)
            .join(" ")
        })
        .join("\n")

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "p4_info",
        description:
          "Show the Perforce user, workspace (client), workspace root, stream and server for a directory. Use it to check which workspace applies before other p4 tools.",
        input: { type: "object", properties: { ...cwdProperty }, additionalProperties: false },
        options: { codemode: false },
        execute: async (input, context) => {
          const { cwd } = input as { cwd?: string }
          const result = await p4(context, ["info"], { cwd })
          const rec = result.records[0] ?? {}
          const keys = [
            "userName",
            "clientName",
            "clientRoot",
            "clientStream",
            "clientCwd",
            "clientHost",
            "serverAddress",
            "serverVersion",
            "proxyAddress",
          ]
          let body = keys
            .filter((key) => rec[key] !== undefined)
            .map((key) => `${key}: ${rec[key]}`)
            .join("\n")
          if (rec.clientName === "*unknown*")
            body += "\n\nNo workspace found for this directory. Pass `cwd` inside a workspace (one that has a P4CONFIG file)."
          return finish(result, body)
        },
      })

      editor.add({
        name: "p4_where",
        description: "Map files between depot paths, workspace (client) paths and local paths.",
        input: {
          type: "object",
          properties: { files: fileList("Local paths or depot paths (//depot/...)."), ...cwdProperty },
          required: ["files"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, cwd } = input as { files: string[]; cwd?: string }
          const list = toList(files)
          const result = await p4(context, ["where"], { cwd, files: list })
          const body = result.records
            .map((rec) => `${rec.unmap ? "-" : ""}${rec.depotFile}\n  client: ${rec.clientFile}\n  local:  ${rec.path}`)
            .join("\n")
          return finish(result, body)
        },
      })

      editor.add({
        name: "p4_fstat",
        description:
          "Show Perforce metadata for files: head revision, have revision, head change, file type, and whether they are opened (and by whom).",
        input: {
          type: "object",
          properties: {
            files: fileList("Local paths or depot paths; wildcards like ... are allowed."),
            fields: {
              type: "array",
              items: { type: "string" },
              description:
                "fstat fields to return. Default: depotFile, clientFile, headRev, haveRev, headAction, headChange, headType, action, change, type, otherOpen.",
            },
            max: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Maximum files." },
            ...cwdProperty,
          },
          required: ["files"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, fields, max = 100, cwd } = input as { files: string[]; fields?: string[]; max?: number; cwd?: string }
          const list = toList(files)
          const wanted = fields?.length
            ? fields
            : ["depotFile", "clientFile", "headRev", "haveRev", "headAction", "headChange", "headType", "action", "change", "type", "otherOpen"]
          const result = await p4(context, ["fstat", "-m", String(max), "-T", wanted.join(",")], { cwd, files: list })
          const body = result.records
            .map((rec) =>
              Object.entries(rec)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n"),
            )
            .join("\n\n")
          return finish(result, body)
        },
      })

      editor.add({
        name: "p4_opened",
        description: "List files opened in the current workspace (or by everyone with allClients), with action and changelist.",
        input: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: "Optional paths to limit the list, e.g. //depot/x/... or src/..." },
            change: { type: "string", description: 'Only files in this changelist; use "default" for the default changelist.' },
            allClients: { type: "boolean", default: false, description: "List files opened in all workspaces, not just this one." },
            max: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
            ...cwdProperty,
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, change, allClients, max = 500, cwd } = input as {
            files?: string[]
            change?: string
            allClients?: boolean
            max?: number
            cwd?: string
          }
          const list = toList(files)
          const args = ["opened", "-m", String(max)]
          if (allClients) args.push("-a")
          if (change) args.push("-c", String(change))
          const result = await p4(context, args, { cwd, files: list })
          const body = result.records
            .map((rec) => {
              const who = allClients ? ` by ${rec.user}@${rec.client}` : ""
              return `${rec.depotFile}#${rec.rev} ${rec.action} change ${rec.change} (${rec.type})${who}`
            })
            .join("\n")
          return finish(result, body, "No opened files.")
        },
      })

      editor.add({
        name: "p4_diff",
        description:
          "Unified diff of opened files against the workspace's have revision (local changes not yet submitted). With summary=true, list only the opened files that differ.",
        input: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: "Optional paths to limit the diff. Default: all opened files." },
            context: { type: "integer", minimum: 0, maximum: 50, default: 3, description: "Lines of context." },
            ignoreWhitespace: { type: "boolean", default: false },
            summary: { type: "boolean", default: false, description: "Only list files that differ." },
            ...cwdProperty,
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, context: lines = 3, ignoreWhitespace, summary, cwd } = input as {
            files?: string[]
            context?: number
            ignoreWhitespace?: boolean
            summary?: boolean
            cwd?: string
          }
          const list = toList(files)
          const args = summary ? ["diff", "-sa"] : ["diff", `-du${lines}`, ...(ignoreWhitespace ? ["-dw"] : [])]
          const result = await p4(context, args, { cwd, files: list, json: false })
          return finish(result, truncate(result.text, MAX_CHARS, "pass fewer files"), summary ? "No opened files differ." : "No differences.")
        },
      })

      editor.add({
        name: "p4_annotate",
        description:
          "Line-by-line history of a file (Perforce blame): for each line, the changelist, user and date that last changed it, plus a short description of each changelist in the range. Annotates a depot revision (default: head; use file#have for the workspace's revision); local unsubmitted edits are not included. Use startLine/endLine for big files.",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "Local path or depot path, optionally with a revision (file#12, file@123)." },
            startLine: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
            endLine: { type: "integer", minimum: 1, description: "Last line to return (inclusive)." },
            follow: {
              type: "string",
              enum: ["none", "branch", "integrations"],
              default: "none",
              description:
                "none: changes on this branch only. branch: follow the file back through the branch it came from (-i). integrations: credit the original change even if it came in by merge (-I). If lines are credited to a branch-creation or merge change, retry with integrations.",
            },
            ignoreWhitespace: { type: "boolean", default: false },
            descriptions: { type: "boolean", default: true, description: "Add a one-line description for each changelist in the range." },
            maxLines: { type: "integer", minimum: 1, maximum: 5000, default: 400, description: "Maximum lines returned." },
            ...cwdProperty,
          },
          required: ["file"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const {
            file,
            startLine = 1,
            endLine,
            follow = "none",
            ignoreWhitespace,
            descriptions = true,
            maxLines = 400,
            cwd,
          } = input as {
            file: string
            startLine?: number
            endLine?: number
            follow?: "none" | "branch" | "integrations"
            ignoreWhitespace?: boolean
            descriptions?: boolean
            maxLines?: number
            cwd?: string
          }
          const [target] = toList(file)
          const args = ["annotate", "-c", "-u"]
          if (follow === "branch") args.push("-i")
          if (follow === "integrations") args.push("-I")
          if (ignoreWhitespace) args.push("-dw")
          const result = await p4(context, args, { cwd, files: [target] })
          const header = result.records.find((rec) => rec.depotFile !== undefined && rec.data === undefined)
          const lines = result.records.filter((rec) => rec.data !== undefined)
          if (!lines.length) return finish(result, "", "No lines (empty or binary file).")

          const total = lines.length
          const first = Math.min(startLine, total)
          const last = Math.min(endLine ?? total, total, first + maxLines - 1)
          const width = String(last).length
          const shown = lines.slice(first - 1, last)
          const rows = shown.map((rec, index) => {
            const day = String(rec.time ?? "").split(" ")[0]
            const text = String(rec.data).replace(/\r?\n$/, "")
            return `${String(first + index).padStart(width)} | ${rec.lower} ${rec.user} ${day} | ${text}`
          })

          const parts = [
            `${header ? `${header.depotFile}#${header.rev}` : target} — lines ${first}-${last} of ${total} (line | change user date | text)`,
            rows.join("\n"),
          ]
          if (last < (endLine ?? total)) parts.push(`… stopped at maxLines=${maxLines}; continue with startLine=${last + 1}.`)

          if (descriptions) {
            const changes = [...new Set(shown.map((rec) => String(rec.lower)))]
            const byChange = await describeChanges(context, cwd, changes.slice(0, MAX_DESCRIBED_CHANGES))
            const summary = changes
              .slice(0, MAX_DESCRIBED_CHANGES)
              .map((change) => {
                const rec = byChange.get(change)
                return rec ? `${change} ${rec.user} ${date(rec.time)}: ${firstLine(rec.desc)}` : `${change}: (no description)`
              })
            if (changes.length > MAX_DESCRIBED_CHANGES)
              summary.push(`… ${changes.length - MAX_DESCRIBED_CHANGES} more; use p4_describe for them.`)
            parts.push(`Changelists in these lines:\n${summary.join("\n")}`)
          }
          return finish(result, truncate(parts.join("\n\n"), MAX_CHARS, "use a smaller startLine/endLine range"))
        },
      })

      editor.add({
        name: "p4_filelog",
        description:
          "Revision history of a file: each revision's changelist, action, date, user and description, plus where it was integrated from or to.",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "Local path or depot path." },
            max: { type: "integer", minimum: 1, maximum: 200, default: 10, description: "Maximum revisions." },
            followBranches: { type: "boolean", default: false, description: "Also show history from before the file was branched (-i)." },
            integrations: { type: "boolean", default: true, description: "Show integration records for each revision." },
            ...cwdProperty,
          },
          required: ["file"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { file, max = 10, followBranches, integrations = true, cwd } = input as {
            file: string
            max?: number
            followBranches?: boolean
            integrations?: boolean
            cwd?: string
          }
          const [target] = toList(file)
          const args = ["filelog", "-l", "-m", String(max)]
          if (followBranches) args.push("-i")
          const result = await p4(context, args, { cwd, files: [target] })
          const blocks = result.records.map((rec) => {
            const revs: string[] = [String(rec.depotFile)]
            for (let i = 0; rec[`rev${i}`] !== undefined; i++) {
              revs.push(
                `#${rec[`rev${i}`]} change ${rec[`change${i}`]} ${rec[`action${i}`]} ${date(rec[`time${i}`])} ${rec[`user${i}`]}@${rec[`client${i}`]} (${rec[`type${i}`]})`,
              )
              revs.push(indent(rec[`desc${i}`]))
              if (!integrations) continue
              for (let j = 0; rec[`how${i},${j}`] !== undefined; j++) {
                const start = rec[`srev${i},${j}`]
                const end = rec[`erev${i},${j}`]
                const range = start && start !== "#none" ? `${start},${end}` : end
                revs.push(`    ${rec[`how${i},${j}`]} ${rec[`file${i},${j}`]}${range}`)
              }
            }
            return revs.join("\n")
          })
          return finish(result, truncate(blocks.join("\n\n"), MAX_CHARS, "lower max"))
        },
      })

      editor.add({
        name: "p4_describe",
        description:
          "Show a changelist: user, workspace, date, status, full description and the files it changed. Set diff=true to include the unified diff.",
        input: {
          type: "object",
          properties: {
            change: { type: "string", description: "Changelist number." },
            diff: { type: "boolean", default: false, description: "Include the unified diff of each file." },
            context: { type: "integer", minimum: 0, maximum: 50, default: 3, description: "Diff context lines." },
            shelved: { type: "boolean", default: false, description: "Describe the shelved files of a pending changelist (-S)." },
            maxFiles: { type: "integer", minimum: 1, maximum: 10000, default: 200, description: "Maximum files listed (or diffed)." },
            maxChars: { type: "integer", minimum: 1000, maximum: 400000, default: MAX_CHARS },
            ...cwdProperty,
          },
          required: ["change"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { change, diff, context: lines = 3, shelved, maxFiles = 200, maxChars = MAX_CHARS, cwd } = input as {
            change: string
            diff?: boolean
            context?: number
            shelved?: boolean
            maxFiles?: number
            maxChars?: number
            cwd?: string
          }
          const id = String(change).trim()
          if (!/^\d+$/.test(id)) throw new Error(`Invalid changelist "${change}": expected a number.`)
          const flags = ["-m", String(maxFiles), ...(shelved ? ["-S"] : [])]
          if (diff) {
            const result = await p4(context, ["describe", `-du${lines}`, ...flags, id], { cwd, json: false })
            return finish(result, truncate(result.text, maxChars, "describe without diff, then p4_diff or p4_annotate specific files"))
          }
          const result = await p4(context, ["describe", "-s", ...flags, id], { cwd })
          const rec = result.records[0]
          if (!rec) return finish(result, "")
          const files: string[] = []
          for (let i = 0; rec[`depotFile${i}`] !== undefined; i++)
            files.push(`  ${rec[`depotFile${i}`]}#${rec[`rev${i}`]} ${rec[`action${i}`]} (${rec[`type${i}`]})`)
          const body = [
            `change ${rec.change} by ${rec.user}@${rec.client} on ${date(rec.time)} — ${rec.status}${shelved ? " (shelved files)" : ""}`,
            indent(rec.desc),
            files.length >= maxFiles ? `files (first ${files.length}; raise maxFiles for more):` : `files (${files.length}):`,
            ...files,
          ].join("\n")
          return finish(result, truncate(body, maxChars, "raise maxChars"))
        },
      })

      editor.add({
        name: "p4_change_diff",
        description:
          'Every change in a changelist, as unified diffs. Use it to see what you have changed so far (for example after losing context). "default" or a pending changelist of this workspace: diffs of the opened files against the have revision, full content of added files, and a list of deleted files. A pending changelist of another workspace (or shelved=true): the shelved diffs. A submitted changelist: its diffs.',
        input: {
          type: "object",
          properties: {
            change: { type: "string", description: 'Changelist number, or "default" for the default changelist.' },
            shelved: { type: "boolean", default: false, description: "Show the shelved files of a pending changelist instead of the local workspace files." },
            context: { type: "integer", minimum: 0, maximum: 50, default: 3, description: "Diff context lines." },
            ignoreWhitespace: { type: "boolean", default: false },
            maxNewFileLines: { type: "integer", minimum: 0, maximum: 5000, default: 300, description: "Lines shown per added file." },
            maxChars: { type: "integer", minimum: 1000, maximum: 400000, default: 60000 },
            ...cwdProperty,
          },
          required: ["change"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const {
            change,
            shelved,
            context: lines = 3,
            ignoreWhitespace,
            maxNewFileLines = 300,
            maxChars = 60000,
            cwd,
          } = input as {
            change: string
            shelved?: boolean
            context?: number
            ignoreWhitespace?: boolean
            maxNewFileLines?: number
            maxChars?: number
            cwd?: string
          }
          const id = String(change).trim().toLowerCase()
          if (id !== "default" && !/^\d+$/.test(id)) throw new Error(`Invalid changelist "${change}": expected a number or "default".`)
          const diffFlags = [`-du${lines}`, ...(ignoreWhitespace ? ["-dw"] : [])]
          const tooLong = "pass a smaller context, or use p4_diff / p4_describe on specific files"

          const describeDiff = async (flags: string[], note?: string) => {
            const result = await p4(context, ["describe", ...diffFlags, ...flags, id], { cwd, json: false })
            return finish(result, truncate(note ? `${note}\n\n${result.text}` : result.text, maxChars, tooLong))
          }

          let title = "change default (pending)"
          if (id !== "default") {
            const described = await p4(context, ["describe", "-s", "-m", "1", id], { cwd })
            const rec = described.records[0]
            if (!rec) return finish(described, "")
            title = `change ${rec.change} by ${rec.user}@${rec.client} — ${rec.status}\n${indent(rec.desc)}`
            if (rec.status !== "pending") return describeDiff([])
            if (shelved) return describeDiff(["-S"], "(shelved files)")
            const info = await p4(context, ["info"], { cwd })
            const client = info.records[0]?.clientName
            if (rec.client !== client) {
              if (rec.shelved !== undefined) return describeDiff(["-S"], `(shelved files; the changelist belongs to workspace ${rec.client})`)
              throw new Error(
                `Changelist ${id} belongs to workspace ${rec.client}, not ${client}, and has no shelved files. Pass cwd inside that workspace.`,
              )
            }
            if (rec.shelved !== undefined) title += "\n(also has shelved files; use shelved=true to see them)"
          } else if (shelved) {
            throw new Error("The default changelist cannot have shelved files.")
          }

          const opened = await p4(context, ["fstat", "-Ro", "-e", id, "-T", "depotFile,clientFile,action,type"], {
            cwd,
            files: ["//..."],
          })
          const files = opened.records.filter((rec) => rec.depotFile !== undefined)
          if (!files.length) {
            const err = opened.errors.join("\n")
            if (err) throw new Error(err)
            return { content: `${title}\n\nNo files opened in this changelist.` }
          }

          const summary = files.map((rec) => `  ${rec.action} ${rec.depotFile} (${rec.type})`).join("\n")
          const parts = [`${title}\n\nfiles (${files.length}):\n${summary}`]
          const messages: P4Result = { records: [], text: "", info: [], warnings: [...opened.warnings], errors: [] }

          const diffed = files.filter((rec) => DIFF_ACTIONS.has(String(rec.action))).map((rec) => String(rec.depotFile))
          if (diffed.length) {
            const diff = await p4(context, ["diff", ...diffFlags], { cwd, files: diffed, json: false })
            messages.warnings.push(...diff.warnings)
            messages.errors.push(...diff.errors)
            parts.push(diff.text.trim() ? diff.text.trimEnd() : "(opened files have no content changes)")
          }

          for (const rec of files.filter((rec) => NEW_ACTIONS.has(String(rec.action)))) {
            const header = `==== ${rec.depotFile} (${rec.action}, new file) ====`
            if (/binary|apple|resource/.test(String(rec.type))) {
              parts.push(`${header}\n(binary file not shown)`)
              continue
            }
            let text: string
            try {
              text = await readFile(String(rec.clientFile), "utf8")
            } catch {
              parts.push(`${header}\n(local file not readable: ${rec.clientFile})`)
              continue
            }
            const all = text.replace(/\n$/, "").split("\n")
            const shown = all.slice(0, maxNewFileLines).map((line) => `+${line}`)
            if (all.length > maxNewFileLines) shown.push(`… ${all.length - maxNewFileLines} more lines; read ${rec.clientFile} for the rest.`)
            parts.push(`${header}\n${shown.join("\n")}`)
          }

          const removed = files.filter((rec) => String(rec.action).includes("delete"))
          if (removed.length) parts.push(`deleted:\n${removed.map((rec) => `  ${rec.depotFile}`).join("\n")}`)

          return finish(messages, truncate(parts.join("\n\n"), maxChars, tooLong))
        },
      })

      editor.add({
        name: "p4_changes",
        description: "List changelists, newest first, optionally limited to a path, user, workspace or status.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Depot or local path, e.g. //depot/proj/... or src/...@2026/01/01,@now" },
            max: { type: "integer", minimum: 1, maximum: 500, default: 20 },
            status: { type: "string", enum: ["submitted", "pending", "shelved"] },
            user: { type: "string" },
            client: { type: "string", description: "Workspace name." },
            fullDescriptions: { type: "boolean", default: false, description: "Full descriptions instead of the first 250 characters." },
            ...cwdProperty,
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { path: target, max = 20, status, user, client, fullDescriptions, cwd } = input as {
            path?: string
            max?: number
            status?: string
            user?: string
            client?: string
            fullDescriptions?: boolean
            cwd?: string
          }
          const list = toList(target)
          checkArgs([user, client].filter((value) => value !== undefined))
          const args = ["changes", "-m", String(max), fullDescriptions ? "-l" : "-L"]
          if (status) args.push("-s", status)
          if (user) args.push("-u", user)
          if (client) args.push("-c", client)
          const result = await p4(context, args, { cwd, files: list })
          const body = result.records
            .map((rec) => `${rec.change} ${date(rec.time)} ${rec.user}@${rec.client} ${rec.status}\n${indent(rec.desc)}`)
            .join("\n")
          return finish(result, truncate(body, MAX_CHARS, "lower max"), "No changelists.")
        },
      })

      editor.add({
        name: "p4_edit",
        description: "Open files for edit in Perforce (makes them writable). Asks for permission.",
        input: {
          type: "object",
          properties: {
            files: fileList("Local paths or depot paths."),
            change: { type: "string", description: "Changelist to open them in. Default: the default changelist." },
            ...cwdProperty,
          },
          required: ["files"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, change, cwd } = input as { files: string[]; change?: string; cwd?: string }
          const list = toList(files)
          await askWrite(context, "p4_edit", list)
          const args = ["edit", ...(change ? ["-c", String(change)] : [])]
          const result = await p4(context, args, { cwd, files: list })
          return finish(result, fileRecordLines(result.records), "No files opened.")
        },
      })

      editor.add({
        name: "p4_add",
        description: "Open new files for add in Perforce. Asks for permission.",
        input: {
          type: "object",
          properties: {
            files: fileList("Local paths of the new files."),
            change: { type: "string", description: "Changelist to open them in. Default: the default changelist." },
            type: { type: "string", description: "Perforce file type, e.g. text, binary, text+x. Default: detected by the server." },
            ...cwdProperty,
          },
          required: ["files"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, change, type, cwd } = input as { files: string[]; change?: string; type?: string; cwd?: string }
          const list = toList(files)
          if (type) checkArgs([type])
          await askWrite(context, "p4_add", list)
          const args = ["add", ...(change ? ["-c", String(change)] : []), ...(type ? ["-t", type] : [])]
          const result = await p4(context, args, { cwd, files: list })
          return finish(result, fileRecordLines(result.records), "No files opened.")
        },
      })

      editor.add({
        name: "p4_revert",
        description:
          "Revert opened files: discards local changes and restores the have revision, unless keepLocal is set. Asks for permission.",
        input: {
          type: "object",
          properties: {
            files: fileList("Local paths or depot paths of opened files."),
            unchangedOnly: { type: "boolean", default: false, description: "Only revert files that have no changes (-a)." },
            keepLocal: { type: "boolean", default: false, description: "Close the files in Perforce but keep the local content (-k)." },
            change: { type: "string", description: "Only revert files in this changelist." },
            ...cwdProperty,
          },
          required: ["files"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { files, unchangedOnly, keepLocal, change, cwd } = input as {
            files: string[]
            unchangedOnly?: boolean
            keepLocal?: boolean
            change?: string
            cwd?: string
          }
          const list = toList(files)
          await askWrite(context, "p4_revert", list)
          const args = ["revert"]
          if (unchangedOnly) args.push("-a")
          if (keepLocal) args.push("-k")
          if (change) args.push("-c", String(change))
          const result = await p4(context, args, { cwd, files: list })
          return finish(result, fileRecordLines(result.records), "No files reverted.")
        },
      })
    })
  },
})
