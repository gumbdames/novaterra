# AGENTS.md — tests

Vitest suites, all headless: unit tests for sim logic, scripted gameplay
scenarios (driven via the sim command log), and perf-budget scenarios.
CI fails when a perf scenario exceeds its budget — budgets are tests, not
aspirations. Re-run the whole suite after every step (step gate, AGENTS.md §2).
