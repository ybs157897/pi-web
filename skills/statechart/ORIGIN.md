# Origin

This Skill adapts the `statechart` skill from `backnotprop/pstack` (distributed in
the `cursor/plugins` repository) to pi-web. The pstack skill models a system in
TLA+, checks it exhaustively with TLC, and surfaces each violated rule's shortest
counterexample path as a Mermaid statechart.

This adaptation keeps the method — declare rules, enumerate exhaustively, treat a
violation as a finding — but re-expresses every stage as a prompt method with no
runtime dependency: invariants become review questions for `ask_user_question`,
the TLC state space becomes the state × event matrix presented in the reply, and
the shortest counterexample path becomes the row the user adjusts before code is
written. TLA+/TLC, mise and Java are intentionally not shipped; for design-level
model checking, bring your own TLA+ environment and feed it the table this Skill
produces.
