---
name: statechart
description: Build a state × event matrix for guarded transitions, event-order bugs, or an explicit exhaustive-state review. Skip ordinary business-flow lookup, stateless logic, and formatting. Ask only about unresolved user-owned policy.
---

# Statechart

Turn the behavior into one finite state machine and make it the standard: the transition table lists every allowed flow, everything outside it is forbidden, and the exhaustive matrix is what conclusions and tests are checked against.

## When to use this Skill

Load this Skill when the user requests an exhaustive state review, or the task depends on guarded transitions or competing event orders: reconnect versus cancel, repeated submissions, job completion versus interruption, or an async UI state race. A mention of a business flow, protocol, or lifecycle alone is insufficient. Skip ordinary call-chain lookup, stateless computation, formatting, and changes whose correctness does not depend on state transitions.

## Workflow

1. **Model the machine.** Name the states (mutually exclusive situations, exactly one at a time), the events (inputs that can arrive at any moment, including timeouts, errors, and repeat clicks), the initial state, and the invariants — one-sentence rules that must hold in every state. When analyzing existing code, model what the code actually does first, including the transitions it gets wrong; when implementing, model the intended machine. Read [references/method.md](references/method.md) for the extraction heuristics, the enumeration procedure, the table and diagram templates, and the known pitfalls.
2. **Enumerate exhaustively.** Build the full state × event matrix and give every cell a verdict: a legal transition (to which state, with which action), a deliberate no-op (ignored on purpose, with why), or forbidden (cannot happen — say what makes it unreachable). Then walk every invariant against the matrix. An unlisted combination is a bug, not freedom; a blank cell is unfinished work.
3. **Present the standard.** Show the transition table and, when useful, a mermaid `stateDiagram-v2` diagram. For analysis requests, use the table and invariant checks to explain possible flows and the defect. For implementation requests, carry forward decisions and authorization already established in the conversation.
4. **Resolve only missing policy.** Ask only when a row depends on an unresolved user-owned business decision or missing authorization that cannot be established from code and context. If `ask_user_question` is callable, ask one to three focused questions; otherwise state the missing decision in your reply. A delegated child reports the question and its recommendation to its delegator. Pause only the work that depends on the missing answer, and continue independent authorized work. Do not ask for approval of deterministic consequences, previously agreed rows, or an already authorized implementation. If no such decision is missing, proceed directly to implementation. Dismissing a question does not authorize an unresolved choice.
5. **Implement one row at a time.** Make forbidden combinations structurally impossible: one state enum or discriminated union drives the branches, not parallel booleans that can contradict each other. Each legal transition becomes the code that moves the state; each deliberate no-op becomes an explicit early return or guard, so silence is a decision rather than an accident. Read the surrounding code first and keep its idioms.
6. **Test one row per case.** Derive tests one-to-one from the matrix: legal rows assert the destination state and action, no-op rows assert nothing changed, forbidden rows assert the guard rejects or the combination is unreachable. Report the final table, the adjustments the user made in review, and which test covers which row — a row with no test is not done.

## Boundaries

- This Skill is a method: it grants no permissions and calls only tools that are callable in the current request.
- Keep the machine minimal: merge states that never differ observably; split a state only when some event treats its situations differently.
- Scope the review questions to user-owned decisions (policy, product behavior, edge semantics); mechanical consequences of an agreed row stay model-owned.
- Do not invent tool results or test runs: a row is verified by a real run, and verification you did not run is reported as not run.
