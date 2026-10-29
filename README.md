# opencode-perforce

OpenCode V2 plugin that exposes Perforce commands as typed tools.

Without it, the agent writes `p4` shell commands itself: it guesses flags, fights shell quoting (csh vs bash),
pages through huge `annotate` or `describe` output, and retries when something fails. With it, the agent calls
`p4_annotate({ file, startLine, endLine })` and gets a compact, predictable answer.

- **No shell.** `p4` runs directly with an argument list, so shell syntax, quoting and `.cshrc` don't matter.
- **Structured output.** Uses `p4 -Mj -ztag` (JSON) and formats a short, consistent text result.
- **Bounded output.** Line ranges for annotate, revision limits for filelog, file and character limits for describe.
  Truncated output says how to get the rest.
- **Clear errors.** p4 errors and warnings come back as short messages (for example `no such file(s)`).
- **Right workspace.** p4 runs in the file's directory (or `cwd`), so `P4CONFIG` picks the matching workspace.
- **Safe changes.** `p4_edit`, `p4_add` and `p4_revert` ask for permission first. There is no submit tool.
- **No external programs.** `P4DIFF`, `P4MERGE`, `P4PAGER` and `P4EDITOR` are ignored, so a configured `gvimdiff`
  never starts.

## Tools

| Tool | Wraps | Permission |
|---|---|---|
| `p4_info` | `p4 info`: user, workspace, root, server | none |
| `p4_where` | `p4 where`: depot ↔ workspace ↔ local paths | none |
| `p4_fstat` | `p4 fstat -T …`: head/have revision, opened state | none |
| `p4_opened` | `p4 opened [-a] [-c]` | none |
| `p4_diff` | `p4 diff -du` / `-sa`: local changes in opened files | none |
| `p4_annotate` | `p4 annotate -c -u [-i\|-I]` with a line range, plus one-line descriptions of the changelists | none |
| `p4_filelog` | `p4 filelog -l -m N [-i]` with integration records | none |
| `p4_describe` | `p4 describe -s` / `-du [-S]` | none |
| `p4_changes` | `p4 changes -m N [-s] [-u] [-c] [path]` | none |
| `p4_edit` | `p4 edit [-c]` | asks |
| `p4_add` | `p4 add [-c] [-t]` | asks |
| `p4_revert` | `p4 revert [-a] [-k] [-c]` | asks |

Example `p4_annotate` result:

```
//depot/proj/src/libinfo.c#15 — lines 3002-3004 of 8831 (line | change user date | text)

3002 | 6085059 qbnr 2025/11/12 | /*
3003 | 6085059 qbnr 2025/11/12 | ** Here we check an embedded library (opt_lib) ...
3004 | 6085059 qbnr 2025/11/12 | ** against its real library (orig_lib), for an MTI library.

Changelists in these lines:
6085059 qbnr 2025/11/13: 2026.x codeline created from //depot/main/...@6085028
```

## Install

Requires OpenCode 2.2+ and `p4` on `PATH` (or set `OPENCODE_P4_BIN`).

```sh
git clone https://github.com/aditya1271/opencode-perforce.git
```

Add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["/path/to/opencode-perforce"]
}
```

### Permissions

The write tools call `ctx.permission.assert` with the tool name as the action and the files as resources. Agents
that allow everything by default (like `build`) need explicit rules to make them ask:

```json
{
  "permissions": [
    { "action": "p4_edit", "resource": "*", "effect": "ask" },
    { "action": "p4_add", "resource": "*", "effect": "ask" },
    { "action": "p4_revert", "resource": "*", "effect": "ask" }
  ]
}
```

Use `"effect": "allow"` with a path pattern (for example `"*/my-workspace/*"`) to skip the prompt there, or
`"deny"` to turn a tool off.

### Steer the agent

Add a line to your `AGENTS.md` so the agent prefers the tools over the shell:

```md
For Perforce, use the p4_* tools (p4_annotate, p4_filelog, p4_describe, p4_changes, p4_opened, p4_diff, ...)
instead of running p4 in the shell.
```

## Notes

- Paths can be local (relative to the session directory) or depot paths (`//depot/...`), with `#rev` or `@change`.
- `p4_annotate` annotates a depot revision (head by default; use `file#have` for your workspace's revision).
  Local unsubmitted edits are not included.
- When lines are credited to a branch-creation change, call `p4_annotate` with `follow: "integrations"` to find the
  original change.
- p4 commands time out after 120 seconds.

## License

MIT
