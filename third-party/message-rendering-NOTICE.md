# Message rendering references

The conversation rendering work follows the component behavior and layout in ZCode 3.16.2 (`3c5b2276`), licensed under Apache-2.0. ZCode's ai-elements components are derived from Vercel AI Elements (Copyright 2023 Vercel, Inc., Apache-2.0). Host-specific code was independently adapted for pi-web; references are listed in `docs/zcode-markdown-rendering-plan.md`.

`src/web/message-rendering/icons/*.svg` are copied from Material Icon Theme as vendored by ZCode, upstream revision `cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`. They retain the MIT license in `material-icon-theme-LICENSE.txt`.

Streamdown, @pierre/diffs and Lucide are installed as npm dependencies and retain their distributed licenses.

`src/web/message-rendering/terminal-ansi.ts` retains the MIT terminal-control parser from DeepSeek Harness `687f282e86` (Copyright 2026 DeepSeek); see `dsh-terminal-parser-LICENSE.txt`. It supplies text/SGR parsing only, not the former DSH terminal UI.
