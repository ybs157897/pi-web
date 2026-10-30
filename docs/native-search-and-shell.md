# Native search and shell execution

This change moves workspace content search onto native ripgrep and gives both shell tools the
same execution contract: a 15-second foreground budget, a full-output log, and search-friendly
exit semantics.

## Native grep

The `grep` tool tries native ripgrep first and keeps the existing JavaScript walker as a
fallback. Tool parameters and the model-facing output format are unchanged.

Resolution order for the executable:

1. `PI_WEB_RG_PATH` (explicit operator override).
2. The bundled `@vscode/ripgrep` binary. The package is optional, so an offline install still
   completes; it provides `rg.exe` on Windows and the platform binary on macOS/Linux.
3. `rg` on `PATH`.
4. The JavaScript walker, when no binary can run.

The native search uses `--json --stats` and a bounded stdout buffer. It keeps hidden files out
of results, respects `.gitignore`, and explicitly excludes VCS metadata, `node_modules`, and
`.data`. Credential names and key extensions are excluded both with `--glob` rules and a
post-filter. The per-file ceiling remains 512 KiB; the total-read cap of the old walker is gone.
A search stops after `maxResults` matches and is marked truncated.

Patterns are passed to ripgrep directly. If ripgrep rejects a pattern (for example a JavaScript
lookahead), the tool compiles it for the JavaScript fallback; a ripgrep-only pattern such as
`(?P<name>...)` therefore works on the native path.

Fallback is automatic when the binary is missing (`ENOENT`), exits with code 2, times out after
30 seconds, or fails to spawn. A failed native run adds an `info` diagnostic; an unavailable
binary falls back silently.

## Shared shell runner

Both the Windows `pwsh` tool and the POSIX `bash` tool use one runner
(`src/server/shell-runner.ts`):

- Streaming stdout/stderr into the retained tail (50 KiB / 2000 lines).
- A full log under the OS temp directory, named in a diagnostic when output was clipped.
- Automatic backgrounding after 15 seconds; the tool returns with the log path and the process
  keeps running until the explicit timeout. Use `read` on the path to check progress.
- Exit 1 from `grep`, `egrep`, `fgrep`, `rg`, `findstr`, or `git grep` becomes a successful
  "No matches found" result. Other non-zero exits keep their error diagnostic.
- Decoding as UTF-8 while valid, then switching to the platform's legacy encoding.
- `disposeBackgroundShells()` kills background process trees when the server closes.

## Windows (`pwsh`)

- `Get-ChildItem`/`gci`/`ls`/`dir` with `-Recurse`/`-r` piped into `Select-String`/`sls` is
  rejected before spawning; the error points at the `grep` tool.
- The child gets `[Console]::OutputEncoding` / `$OutputEncoding` set to UTF-8,
  `chcp.com 65001`, and `PYTHONIOENCODING` / `PYTHONUTF8`. When bytes are not UTF-8, the decoder
  uses the active console code page detected with `chcp`, with a locale-based fallback.
- `PI_WEB_WINDOWS_OUTPUT_ENCODING` overrides the detected encoding.

## POSIX (`bash`)

- Recursive `grep`/`rg` is rejected before spawning, including `find -exec grep` and
  `find | xargs grep`; quoted mentions are not rejected. Non-recursive `grep` remains allowed.
- A command moved to the background keeps the macOS `workspaceWrite` sandbox: the detached
  process runs under the same `sandbox-exec` profile. Its output file is written by the parent,
  not by the sandboxed child, so the write sandbox stays intact.
- An inherited `LANG`/`LC_CTYPE`/`LC_ALL` of `C`/`POSIX` is replaced with `en_US.UTF-8` (macOS)
  or `C.UTF-8` (Linux), so `ls` and friends stop replacing non-ASCII with `??`. A non-UTF-8
  locale codeset (for example `zh_CN.GB18030`) is kept as the decoder fallback.

Remote or non-`node:local` environments keep using pi-durable's platform tools.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PI_WEB_RG_PATH` | Explicit ripgrep executable |
| `PI_WEB_PWSH_PATH` | Explicit PowerShell executable |
| `PI_WEB_WINDOWS_OUTPUT_ENCODING` | Force a Windows legacy code page (for example `gb18030`) |

## Known limits

- Background completion is polled with `read`; there is no automatic notification yet.
- Background commands are terminated when the server closes.
- The POSIX recursive-search guard is heuristic: a quoted script passed to `sh -c` can evade it.
  The system prompt and the bash description still apply.
- The native grep's Rust regex syntax is slightly narrower than JavaScript's; unsupported
  patterns fall back to the walker.

## Tests

- `tests/windows-shell.test.ts`: Windows guard, no-match classification, decoder, wrapper script.
- `tests/posix-shell.test.ts`: POSIX guard, locale fallback, foreground output, no-match,
  automatic backgrounding with an output file, non-UTF-8 decoding.
- `tests/research-tools.test.ts`: native matches, no-match, exclusions, ripgrep-only syntax,
  JavaScript-only fallback, JavaScript walker fallback.
- `tests/shell-tools.test.ts`: bash exit 1 as no matches, real failures stay errors, workdir.
