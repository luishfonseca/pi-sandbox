# pi-sandbox Coding Conventions

This document covers patterns and idioms that Prettier and ESLint do **not** enforce. For everything else, Prettier is the source of truth. Run `npm run format` before committing.

## 1. Language & Runtime

- **TypeScript 5.5+**, **ES2022**, **NodeNext** module resolution.
- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noImplicitReturns` are enabled. Do not fight the compiler.
- Assume a POSIX host. Windows-specific guards are out of scope.

## 2. Imports

### 2.1 Ordering
Import order and spacing are handled by `@trivago/prettier-plugin-sort-imports`. Do not manually reorder imports; run `npm run format`.

### 2.2 Type Imports
Use `import type` for types that are erased at runtime. Mixing inline `type` in value imports is allowed when it keeps import statements compact:

```ts
// Good
import { isNodeError, type AccessOperation } from "./acl.js";
import type Dockerode from "dockerode";

// Bad — imports a value that is only used as a type
import Dockerode from "dockerode";
```

Do not use inline `import("./module").Type` in production code. Import the type at the top of the file like any other dependency:

```ts
// Bad
const opts: import("./docker.js").ExecInContainerOptions = { ... };

// Good
import { type ExecInContainerOptions } from "./docker.js";
const opts: ExecInContainerOptions = { ... };
```

### 2.3 `node:` Prefix
Always use the `node:` prefix for built-in modules. Do not rely on bare module names (`fs`, `path`).

## 3. Error Handling

### 3.1 Node Error Guards
Use the shared `isNodeError` helper from `./acl.js` for all `NodeJS.ErrnoException` checks. Do not inline `err instanceof Error && "code" in err` anywhere.

```ts
// Good
import { isNodeError } from './acl.js';
if (isNodeError(err) && err.code === 'ENOENT') { … }

// Bad
if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') { … }
```

### 3.2 Fail Fast
Validate at boundaries and throw immediately. Error messages must state the exact invariant violated:

```ts
throw new Error(`timeout must be > 0, got ${value}`);
```

### 3.3 Custom Error Types
Extend `Error` for domain-specific failures (e.g., `DockerDaemonUnreachableError`). Place them next to the code that throws them.

### 3.4 Error Swallowing
Only swallow specific, known-benign errors. Rethrow everything else. Do not use broad catch-all comments like "other errors are benign" as a license to silence unexpected failures.

```ts
// Good — each swallowed case is explicit
if (isDockerNotFound(err)) { return; }
if (isDockerNotModified(err)) { return; }
rethrowDockerDaemonError(err);
throw err;

// Bad — silently swallows permission denied, invalid state, etc.
rethrowDockerDaemonError(err);
// Other stop errors are benign.
```

## 4. Template Literals

### 4.1 Explicit Coercion in Templates
`@typescript-eslint/restrict-template-expressions` is strict. When interpolating `number` (or `number | undefined`) into a template literal, wrap with `String()`:

```ts
// Required by lint
ctx.ui.notify(`Reset sandbox container. Removed ${String(stale)} stale session reference(s).`, 'info');
```

## 5. Paths

Always construct file-system paths with `join` from `node:path`. Do not use string concatenation or template literals for paths, even when the separator looks obvious.

```ts
// Good
import { join } from 'node:path';
const sessionFile = join(stateDir, 'sessions', sessionId);

// Bad
const sessionFile = `${stateDir}/sessions/${sessionId}`;
```

## 6. Types & Signatures

### 6.1 Explicit Return Types
Every exported function must declare an explicit return type. Internal functions should too, when the inferred type is non-obvious.

### 6.2 Optional vs `undefined`
With `exactOptionalPropertyTypes` enabled:

- Use `?: T` when a property/argument may be omitted.
- Use `| undefined` **only** when the value may be explicitly set to `undefined` (common in options objects that are built dynamically).

```ts
interface ExecInContainerOptions {
  command: string;
  signal?: AbortSignal | undefined; // caller may pass `signal: undefined`
}
```

### 6.3 Type Assertions
Avoid `as` when possible. Mock objects in tests may use `as unknown as Target` to satisfy strict assignment checks, but prefer building realistic stubs.

## 7. Testing

### 7.1 Runner
Use Node’s built-in test runner (`node:test`). Do not add jest, mocha, or vitest.

### 7.2 Assertions
Prefer `assert.ok` and `assert.strictEqual` / `assert.deepStrictEqual`. Use `assert.ok(x !== undefined)` rather than `assert.strictEqual(x !== undefined, true)`.

### 7.3 Temp Directories
Use `mkdtempSync(join(tmpdir(), 'pi-sandbox-<feature>-test-'))`. Clean up in `afterEach` with `rmSync(tmpDir, { recursive: true, force: true })`. Do not inline cleanup with `try/finally` inside a single test.

### 7.4 Skipping Integration Tests
When skipping tests that require Docker, define a conditional `describe` block at module level:

```ts
const dockerAvailable = await isDockerAvailable();
const describeIntegration = dockerAvailable ? describe : describe.skip;
```

### 7.5 Test File Helpers
It is fine for each test file to define its own `makeTempDir`, mock factories, and assertion helpers at module scope. Do not create a shared `tests/utils.ts` graveyard.

## 8. Naming

- **Files**: kebab-case for multi-word files (`start-container.ts`).
- **Functions & variables**: camelCase.
- **Types & interfaces**: PascalCase.
- **Constants**: camelCase or PascalCase for `Set`/`Map` constants (`TOP_LEVEL_KEYS`, `PRIVATE_CIDRS`).

## 9. Comments

Comments explain **why**, not what. JSDoc is required for:

- Non-obvious public APIs.
- Complex invariants (e.g., `Mutex` is single-process only).
- Anything that looks like a hack and needs justification.

Delete comments that narrate syntax.

## 10. Notifications

Pi is a TUI application. Never use `console.log`, `console.warn`, or `console.error` for user-facing output. Always use `ctx.ui.notify(message, severity)`:

```ts
ctx.ui.notify('Docker daemon unreachable', 'error');
ctx.ui.notify('Sandbox config has changed', 'warning');
```

Reserve `console.*` for local debugging only.

## 11. Dependency Injection

The extension uses an options bag (`SandboxExtensionOptions`) to inject dependencies for testing.

- **Only inject what tests actually mock.** Do not add indirection for internal helpers, sidecar-specific functions, or stable utilities that tests never replace. If no test passes the option, remove it.
- When a dependency is only used as a type in the interface, import it as `import type`.
- Default to `??` fallbacks to the real implementation in the extension factory.

## 12. Process Globals

`process` is available as a global in Node, but be consistent:

- Use `process.env.*` and `process.cwd()` directly.
- Import from `node:process` only when you need a specific export such as `kill`.
- For the user's home directory, use `os.homedir()` (from `node:os`) rather than `process.env.HOME`. It is more reliable and avoids `undefined` checks.

## 13. Mutation and Purity

Exported utility functions must not mutate their arguments unless the mutation is the sole purpose of the function and clearly named (e.g., `resetState`).

```ts
// Bad — hidden side effect
export function augmentConfigWithPiDir(config: SandboxConfig): AugmentResult {
  config.filesystem.ro.push(piDir);
  return { augmented: true };
}

// Good — returns a new object
export function augmentConfigWithPiDir(config: SandboxConfig): AugmentResult {
  return {
    config: { ...config, filesystem: { ...config.filesystem, ro: [...config.filesystem.ro, piDir] } },
    augmented: true,
  };
}
```

## 14. Magic Strings

External identifiers (image names, CLI flags, default URLs) that appear more than once must be extracted to a named constant.

```ts
// Good
export const DEFAULT_SIDECAR_IMAGE = 'ghcr.io/sagernet/sing-box:v1.12.0';

// Bad — literal duplicated in two functions
'ghcr.io/sagernet/sing-box:v1.12.0'
```

## 15. Workspace Scoping in Commands

Commands and status queries must resolve the workspace from `ctx.cwd` (or `realpathSync(ctx.cwd)`) directly. Do not fall back to in-memory `state.workspaceAbsolutePath`, which may be stale or belong to a different session.

```ts
// Good
const workspacePath = realpathSync(ctx.cwd);

// Bad — may target the wrong workspace
const workspacePath = state.workspaceAbsolutePath ?? realpathSync(ctx.cwd);
```
