---
name: statechart
description: Model behavior as one finite state machine with an exhaustive state × event matrix before drawing conclusions or writing code, and let the user adjust the disputed rows before implementation. Use when the task involves behavior over time — flows, protocols, lifecycles, guarded transitions, async UI state, connection or job handling, or "which flows are allowed and which are not". Do not load for pure computation, static formatting, or questions with no event-driven behavior.
---

# Statechart

Turn the behavior into one finite state machine and make it the standard: the transition table lists every allowed flow, everything outside it is forbidden, and the exhaustive matrix is what conclusions and tests are checked against.

## When to use this Skill

Load this Skill when the request carries behavior over time: analyzing why a flow, protocol, lifecycle, or event-driven UI misbehaves; designing or reviewing such behavior; or implementing logic where events can arrive in many orders (cards that open and close, uploads, connections, parsers, job pipelines). Skip it for pure computation, data formatting, and static questions — forcing a machine onto stateless work adds noise, not robustness.

## Workflow

1. **Model the machine.** Name the states (mutually exclusive situations, exactly one at a time), the events (inputs that can arrive at any moment, including timeouts, errors, and repeat clicks), the initial state, and the invariants — one-sentence rules that must hold in every state. When analyzing existing code, model what the code actually does first, including the transitions it gets wrong; when implementing, model the intended machine. Read [references/method.md](references/method.md) for the extraction heuristics, the enumeration procedure, the table and diagram templates, and the known pitfalls.
2. **Enumerate exhaustively.** Build the full state × event matrix and give every cell a verdict: a legal transition (to which state, with which action), a deliberate no-op (ignored on purpose, with why), or forbidden (cannot happen — say what makes it unreachable). Then walk every invariant against the matrix. An unlisted combination is a bug, not freedom; a blank cell is unfinished work.
3. **Present the standard.** Show the transition table and a mermaid `stateDiagram-v2` diagram — pi-web renders mermaid fences inline, so the user sees the machine, not prose about it. For analysis requests the table plus the invariant walk IS the conclusion: read off which flows are possible, which are impossible, and where the defect lives. For implementation requests show the table in the same reply as step 4's questions and continue.
4. **Review before writing code.** Turn the rows that carry policy or feel disputed into `ask_user_question` questions — one to three questions, at most twelve options each, multiSelect when several rows change together, plus a free-form text line for adjustments that fit no label. Label the question so the user knows the stakes, for example 「勾选需要调整的转移行，其余按表执行」. End the turn while the questions are pending and do not start implementing. When the answers arrive, apply the adjustments, re-enumerate every row the change touches, and only then write code. If the user dismisses the questions, continue on the last agreed table and say so in the report.
5. **Implement one row at a time.** Make forbidden combinations structurally impossible: one state enum or discriminated union drives the branches, not parallel booleans that can contradict each other. Each legal transition becomes the code that moves the state; each deliberate no-op becomes an explicit early return or guard, so silence is a decision rather than an accident. Read the surrounding code first and keep its idioms.
6. **Test one row per case.** Derive tests one-to-one from the matrix: legal rows assert the destination state and action, no-op rows assert nothing changed, forbidden rows assert the guard rejects or the combination is unreachable. Report the final table, the adjustments the user made in review, and which test covers which row — a row with no test is not done.

## Boundaries

- This Skill is a method: it grants no permissions and calls only tools that are callable in the current request.
- Keep the machine minimal: merge states that never differ observably; split a state only when some event treats its situations differently.
- Scope the review questions to user-owned decisions (policy, product behavior, edge semantics); mechanical consequences of an agreed row stay model-owned.
- Do not invent tool results or test runs: a row is verified by a real run, and verification you did not run is reported as not run.
