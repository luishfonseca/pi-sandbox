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
