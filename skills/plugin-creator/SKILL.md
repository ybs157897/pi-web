---
name: plugin-creator
description: Create, extend, validate, or update a pi-web plugin and its local development marketplace when the user asks to build a plugin, add a plugin capability, or package skills, MCP tools, or UI surfaces for pi-web. Do not load for ordinary Skill creation (use skill-creator) or for installing an existing plugin.
---

# Plugin Creator

Build a pi-web plugin as a normal directory in the user's workspace, plus a local marketplace catalog. pi-web installs the plugin through its existing plugin market; this Skill never installs, enables, or registers anything by itself.

## When to use this Skill

Load this Skill when the user asks to create, extend, validate, or update a pi-web plugin. Use `skill-creator` instead when the request is only a reusable instruction file (`SKILL.md`) with no plugin manifest, MCP server, or UI surface.

## What a pi-web plugin is

A plugin is a directory with a manifest and optional capabilities:

```text
plugins/<slug>/
  .pi-plugin/plugin.json     # required manifest
  skills/<name>/SKILL.md     # optional, declared by "skills"
  server.mjs                 # optional MCP server (stdio JSON-RPC)
```

A local marketplace is one catalog file, normally `plugins/marketplace.json`, listing one entry per plugin. The source path is relative to the catalog file.

Read [references/plugin-format.md](references/plugin-format.md) before writing files. It contains the exact manifest, catalog, MCP, and UI templates.

## Workflow

1. **Inspect first.** Look for an existing `plugins/` directory, `marketplace.json`, and any plugin with a similar purpose. Reuse or update it instead of creating a duplicate. Check the conversation for the desired capability: skill-only, MCP tools, UI surface, or a combination.
2. **Choose the target.** Slug is lowercase kebab-case (`^[a-z0-9][a-z0-9._-]*$`). Default source directory: `<workspace>/plugins/<slug>/`. Default catalog: `<workspace>/plugins/marketplace.json`. Keep the plugin directory name equal to the manifest `name`.
3. **Create the manifest.** Write `.pi-plugin/plugin.json` with `name`, `version` (start at `1.0.0`), and `description`. Add only capabilities the plugin really implements. For a skill-only plugin, declare `"skills": ["skills"]` and create the skill directories; a manifest without that array loads no skills.
4. **Add the capabilities.**
   - **Skills:** write `skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, precise `description`, non-empty body). Keep resources beside the skill and reference them relatively.
   - **MCP tools:** write a stdio JSON-RPC server, usually `server.mjs`, using only Node built-ins unless the user approves dependencies. Declare it under `mcpServers`. Set `"exposure": "direct"` when the model should call its tools directly; use `"codemode"` for code-mode-only tools and `"hidden"` for page-only tools.
   - **UI surface:** add an entry to `ui.surfaces` whose `server` exactly matches an `mcpServers` key. The server must advertise the resource and return HTML for `resources/read`. Return `_meta.ui` from a tool result to render the inline card.
5. **Update the marketplace catalog.** Create or update the catalog entry `{ name, version, description, category?, source, listing? }`. `source` points at `./<slug>`. The catalog `version` MUST equal the manifest `version`; a mismatch makes installation fail. Add display names/example prompts under `listing` when useful. Preserve unrelated entries and field order.
6. **Validate.** Re-read the written files and check: valid JSON; slug and manifest name agree; catalog and manifest versions agree; every declared skill path exists with a `SKILL.md`; every `ui.surfaces[].server` names a declared MCP server; relative paths stay inside the plugin; no symlinks; no secrets or machine-specific absolute paths. If `node` is available and you wrote a server, run `node --check server.mjs`. Do not claim protocol validation or installation unless it actually ran.
7. **Hand off through the UI.** Tell the user to open Settings → Plugins → 添加市场 / Add marketplace, paste the absolute path of the **marketplace root** (`.../plugins`, not the plugin subdirectory), then install the plugin, enable it, and start a new task to try it. Do not auto-add the market, install, or enable it.
8. **Report accurately.** Give the source directory, marketplace root and catalog path, manifest name/version, the plugin ID (`name@marketplace`), what was validated, and the step that remains manual. If the user cancels or installation fails, keep the source files and report the real state.

## Updating an existing plugin

Increase the semantic version in both the manifest and the catalog entry, change only the relevant files, keep unrelated catalog data, then tell the user to refresh that marketplace source in Settings → Plugins and click Update on the plugin. A modified source directory is not a hot reload; the installed copy changes only after Update.

## Boundaries

- This Skill writes workspace files with the normal file tools; it does not add tools or permissions.
- Never write into `.pi-web`, installed plugin caches, or global Skill directories.
- Never invent a successful install, validation, or trial. If the user has not performed the manual marketplace/install steps, say so.
- Ask only for a missing detail that changes the scaffold; otherwise choose sensible defaults and proceed.
