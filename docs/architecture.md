# Architecture

The browser renders application DTOs using DSH React display components and the pinned DSH theme. The HTTP server owns input validation and streaming transport. The runtime owns Pi Durable, its SQLite session, provider configuration, and conversation metadata.

## Data ownership

A UI conversation maps to a Pi `Conversation`, not its storage-level `Session`. Entries and Pi documents own messages, active generation, tools, inbox, agent configuration, and usage. Application metadata owns titles, pinning, and archiving. Browser storage owns drafts and display preferences.

`src/shared/types.ts` is the browser protocol. It contains no credentials and imports no server runtime. Tool calls and results correlate by tool call ID. Submission request IDs provide retry idempotency; a network failure does not authorize creating a second input.

## Streaming

The server projects Pi state into complete `ConversationDetail` snapshots. A stream attaches with an initial snapshot, then publishes fresh views. Reconnection obtains a new baseline; it does not claim durable cursor replay. Slow or disconnected browser subscribers release their runtime watch. Stable message identity keeps Markdown caches and disclosure state attached to the same content.

## UI integration

DSH primitives remain the owner of Markdown parsing, code highlighting, tool-output blocks, and shared controls. DSH theme CSS is pinned under `vendor/dsh-theme`; project CSS consumes its semantic variables. The application owns its React composition and Pi actions instead of emulating DSH Cordis services.

## Model configuration

The runtime imports existing Pi configuration read-only and keeps project-specific overrides in its own data directory. Provider credentials are write-only through HTTP and are omitted from catalog responses. Deterministic demo models require explicit startup configuration and are never an error fallback.

## Stop semantics

The public stop operation uses Pi's native abort, which also withdraws queued input. The UI names this effect. A stop operation that retains the inbox requires a separately validated runtime implementation.
