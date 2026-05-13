## Repository Context

This is `pi-sandbox`, a Pi extension. See `spec/DESIGN.md` for the full behavioral specification and `src/index.ts` for the extension entry point.

### Spec Structure (`spec/`)

- **`spec/DESIGN.md`** — Root specification. Schema-first, section-numbered (§1–§9). Defines preconditions, postconditions, and concrete input/output examples that serve as acceptance criteria.
- **`spec/DESIGN_EXTENSION.*.md`** — Modular extensions that replace or append to specific subsections of `DESIGN.md` by reference. Each targets a single concern (e.g., `DESIGN_EXTENSION.symlinks.md` replaces the `UNDERSPECIFIED` paragraph in §4.2). Extensions are independently mergeable and must not duplicate the root spec.

**Invariant:** Behavioral changes start in `spec/` and are only then reflected in `src/` and `tests/`.

## Guidelines

- **Escalate rigid rules.** If a guideline conflicts with existing conventions, idioms, or practical constraints, raise it with me before overriding local patterns.

### Specification

- **Remove ambiguity.** Label open details `UNDERSPECIFIED`. State invariants as pre/post conditions, not prose. Provide happy-path, error, and edge-case examples.
- **Flag conflicts and bound scope.** Call out contradictions and state which wins. List non-goals, forbidden patterns, and out-of-scope features. Mark non-essentials as `EXTENSION POINT`.

### Architecture

- **Small surfaces, explicit contracts, local behavior.** Small module interfaces with full types/schemas. Co-locate logic, helpers, types, constants, and tests. No `utils/` graveyards.
- **Explicit over implicit.** Ban magic: reflection, auto-wiring, implicit imports, convention routing, implicit ORM, metaprogramming, global mutable state.
- **Flat graphs, shallow stacks.** Composition over inheritance. Unidirectional data flow. Avoid global event buses, bidirectional reactive state, deeply nested observers.
- **Schema-first.** Define APIs and data models with explicit schemas before implementation.
- **Split business logic from presentation.** Domain rules, state transitions, and orchestration must not depend on UI frameworks, rendering, or view state. Presentation layers adapt to the core; the core remains framework-agnostic.
- **Vertical slices.** End-to-end features (schema → API → handler → test), independently verifiable.
- **Boring patterns.** Mainstream abstractions only. Avoid niche DSLs, custom meta-frameworks, bleeding-edge libraries.

### Implementation

- **Small, consistent files.** One module or feature per file, context-window-sized. One paradigm per module.
- **Pure core, effects at edges.** Core logic must be pure. Push I/O and mutation to boundaries. Inject dependencies; prefer interfaces over concrete ones.
- **Fail fast.** Validate inputs at boundaries and throw immediately. State the exact invariant violated (e.g., `"timeout must be > 0, got {value}"`).
- **Fast feedback.** Module tests and lint under ten seconds. Standard one-command entry points.
- **Pedantic linting.** Strictest configs; treat warnings as errors. No blanket inline suppressions in production code. Fix root cause or justify inline. Test files may suppress freely at file level.
- **Dependency hygiene.** Prefer standard library. Wrap third-party libs behind thin internal interfaces. Pin versions.
- **Comments explain why, not what.** Delete comments that narrate syntax.
- **Observability and defense.** Log at major branches and state changes with correlation IDs. Sanitize and validate all external inputs.

## Conventions

See [`CONVENTIONS.md`](./CONVENTIONS.md) for coding conventions, style rules, and idioms used in this repository.

## Agent Interaction

### Tests
Test files in `tests/` are verbose integration suites. Do **not** read them speculatively or in full to "understand the codebase."

- **Spec over tests.** For behavioral questions, read `spec/DESIGN.md` (and any `spec/DESIGN_EXTENSION.*.md`) first. The spec is the source of truth; tests are verification artifacts.
- **Search before reading.** Use `bash` with `rg`/`grep`/`sed` to locate relevant `describe` / `it` blocks by keyword. Never page through a large test file blindly.
- **Read selectively.** If a specific test block is needed (e.g., debugging a failure), use `read` with `limit`/`offset` to extract only that block.
