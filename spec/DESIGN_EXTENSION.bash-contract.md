# Design Extension: Bash Tool Contract

**Target:** Replaces and expands §5 of `DESIGN.md`.  
**Concern:** Full behavioral specification for the overridden `bash` tool, including timeout, cancellation, real-time streaming, and fallback semantics.

---

## 5. Containerized Bash

### 5.1 Tool Override Contract

The extension overrides the built-in `bash` tool.  Every `bash` tool call is executed inside the sandbox container via **dockerode**.

**Preconditions:**
1. The sandbox container is running.

**Postconditions:**
1. The command executes as a new process inside the container.
2. `stdout` and `stderr` are collected from the stream.
3. The combined output is truncated per §5.5 before being returned in `content`.  `details` retains the full, untruncated strings.
4. The exit code is returned.
5. If `timeout` is provided and the command exceeds it, the process is killed and the call fails with a timeout error.
6. If the framework aborts the call, the container process is killed and the call fails with an abort error.
7. If `onUpdate` is provided, partial output is streamed in real time using the same rolling-buffer semantics as the built-in tool.

**Parameter schema:**

```typescript
{
  command: string;               // Bash command to execute
  timeout?: number;              // Timeout in seconds (optional, no default)
}
```

*Validation:* `timeout`, when present, MUST be a positive finite number.  If `timeout <= 0`, treat it as if it were absent.

*Note:* This schema is identical to the built-in `bash` tool.

---

### 5.2 Fallback Path (`--no-sandbox`)

When the `--no-sandbox` flag is active, the extension MUST delegate to the built-in local `bash` tool with **identical** arguments, signal, and update callback:

```typescript
return localBash.execute(toolCallId, params, signal, onUpdate);
```

The fallback MUST NOT drop `signal` or `onUpdate`.

---

### 5.3 Execution Semantics

#### 5.3.1 Container Exec Creation

```typescript
const exec = await container.exec({
  Cmd: ["sh", "-c", command],
  WorkingDir: workspaceAbsolutePath,
  AttachStdout: true,
  AttachStderr: true,
});
```

#### 5.3.2 Timeout

If `timeout` is present and > 0:

1. Start a timer for `timeout * 1000` ms around the time `exec.start` is called.
2. If the timer fires before the stream ends:
   - Kill the exec process by sending `SIGKILL` to its host PID (obtained via `exec.inspect()`).
   - Destroy the local stream.
   - Return a result with `isError: true`.  `content[0].text` contains any partial output (truncated per §5.5) followed by `\n\nCommand timed out after {timeout} seconds`.  `details.exitCode` is set to `null`, and `details.stdout` / `details.stderr` contain whatever was emitted before the kill.

If the stream ends before the timer fires, clear the timer.

#### 5.3.3 Cancellation (AbortSignal)

If `signal` is provided:

1. Before `exec.start`, if `signal.aborted` is already true, return a result with `isError: true`, `content[0].text` containing `\n\nCommand aborted`, and `details.exitCode` set to `null`.
2. Otherwise, register an abort listener.  When triggered:
   - Kill the exec process by sending `SIGKILL` to its host PID (obtained via `exec.inspect()`).
   - Destroy the local stream.
   - Return a result with `isError: true`.  `content[0].text` contains any partial output (truncated per §5.5) followed by `\n\nCommand aborted`.  `details.exitCode` is set to `null`, and `details.stdout` / `details.stderr` contain whatever was emitted before the kill.
3. If the stream ends naturally, remove the abort listener.

#### 5.3.4 Real-Time Streaming (`onUpdate`)

If `onUpdate` is provided:

1. Maintain a rolling in-memory buffer of the most recent output chunks, capped at `DEFAULT_MAX_BYTES * 2` (same limit as the built-in tool).
2. On every chunk received from the stream:
   - Append the chunk to the rolling buffer.
   - If the buffer exceeds the cap, drop the oldest chunks until it is under the cap.
   - Concatenate the buffer, apply `truncateTail`, and call `onUpdate` with:
     ```typescript
     {
       content: [{ type: "text", text: truncation.content || "" }],
       details: {
         truncation: truncation.truncated ? truncation : undefined,
       },
     }
     ```

#### 5.3.5 Stream Completion and Result Assembly

After the stream ends (or the exec is killed):

1. If the call timed out or was aborted, `exitCode` is `null`.  Otherwise, await `exec.inspect()` to obtain the exit code.
2. Combine `stdout` and `stderr` into a single string.
3. Apply `truncateTail(combinedOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })`.
4. Build the final `content[0].text`:
   - If truncation occurred, append the truncation marker (§5.5).
   - If the call timed out, append `\n\nCommand timed out after {timeout} seconds`.
   - If the call was aborted, append `\n\nCommand aborted`.
   - If `exitCode !== 0 && exitCode !== null`, append `\n\nCommand exited with code {exitCode}`.
5. Return:
   ```typescript
   {
     content: [{ type: "text", text }],
     details: {
       exitCode: result.exitCode,
       stdout: result.stdout,
       stderr: result.stderr,
     },
     isError: result.exitCode !== 0 || timedOut || aborted,
   }
   ```

*Note:* `details.stdout` and `details.stderr` MUST contain the full, untruncated strings collected from the stream, even when the call is killed or timed out.

---

### 5.4 Error Conditions

| Condition | Detection | Response |
|---|---|---|
| Container not running | `container.inspect()` → `!State.Running` | Return `{ content: [{ type: "text", text: "Sandbox container not running" }], details: { error: "Sandbox container not running" }, isError: true }` |
| Docker daemon unreachable | Connection error inspecting container | Return `{ content: [{ type: "text", text: "Docker daemon unreachable" }], details: { error: "Docker daemon unreachable" }, isError: true }` |
| Timeout | Timer fires before stream end | Kill exec PID, return `{ content, details: { exitCode: null, stdout, stderr }, isError: true }` with timeout message appended after partial output |
| Abort | `signal.aborted` or abort event | Kill exec PID, return `{ content, details: { exitCode: null, stdout, stderr }, isError: true }` with abort message appended after partial output |
| Command references path outside mounts | Exec returns `No such file or directory` | Forwarded natively via `exitCode: 1` and `stderr` |

---

### 5.5 Output Truncation

Tool results MUST be truncated to avoid overwhelming the LLM context. The limit is **2000 lines** and **50KB**, whichever is hit first.

**Algorithm:**
1. Concatenate `stdout` and `stderr` into `combinedOutput`.
2. Apply `truncateTail(combinedOutput, { maxLines: 2000, maxBytes: 51200 })`. Rationale: for command output, the tail (most recent lines) is usually the most informative.
3. Let `truncatedText` be the result of step 2.
4. If truncation occurred, append to `truncatedText`:
   ```
   [Output truncated: {N} of {M} lines ({X} of {Y} bytes).]
   ```
5. Return `truncatedText` as `content[0].text`.

**Postconditions:**
- `content[0].text` does not exceed 2000 lines.
- `content[0].text` does not exceed 50KB (excluding the truncation marker).
- `details.stdout` and `details.stderr` contain the full, untruncated strings.
- `details.exitCode` is preserved exactly.

In addition to the final result, truncation is applied to every `onUpdate` payload (rolling buffer).

---

### 5.6 Examples

**Example 1 — Happy path:**
```
Input:  bash({ command: "echo hello" })
Output: {
  content: [{ type: "text", text: "hello\n" }],
  details: { exitCode: 0, stdout: "hello\n", stderr: "" },
  isError: false,
}
```

**Example 2 — Command failure:**
```
Input:  bash({ command: "exit 42" })
Output: {
  content: [{ type: "text", text: "\n\nCommand exited with code 42" }],
  details: { exitCode: 42, stdout: "", stderr: "" },
  isError: true,
}
```

**Example 3 — Container not running:**
```
Input:  bash({ command: "echo hello" })
Output: {
  content: [{ type: "text", text: "Sandbox container not running" }],
  details: { error: "Sandbox container not running" },
  isError: true,
}
```

**Example 4 — Path outside mounts:**
```
Input:  bash({ command: "cat /etc/shadow" })
Output: {
  content: [{ type: "text", text: "cat: /etc/shadow: No such file or directory\n\nCommand exited with code 1" }],
  details: { exitCode: 1, stdout: "", stderr: "cat: /etc/shadow: No such file or directory\n" },
  isError: true,
}
```

**Example 5 — Output truncation:**
```
Input:  bash({ command: "seq 1 5000" })
Result: content.text contains lines 3001–5000 plus truncation marker.
        details.stdout contains all 5000 lines.
        details.exitCode is 0.
        isError is false.
```

**Example 6 — Timeout kills long-running command:**
```
Input:  bash({ command: "echo partial; sleep 60", timeout: 1 })
Result: After ~1 second, the exec process is killed.
        content: [{ type: "text", text: "partial\n\nCommand timed out after 1 seconds" }],
        details: { exitCode: null, stdout: "partial\n", stderr: "" },
        isError: true.
```

**Example 7 — Abort signal kills in-flight command:**
```
Input:  bash({ command: "echo partial; sleep 60" })  // framework cancels after 500 ms
Result: The exec process is killed.
        content: [{ type: "text", text: "partial\n\nCommand aborted" }],
        details: { exitCode: null, stdout: "partial\n", stderr: "" },
        isError: true.
```

**Example 8 — Streaming via onUpdate:**
```
Input:  bash({ command: "for i in 1 2 3; do echo $i; sleep 0.1; done" })
Result: onUpdate is called at least three times with progressively
        longer rolling-buffer output, ending with the final result:
        { content: [{ type: "text", text: "1\n2\n3\n" }], details: { exitCode: 0, stdout: "1\n2\n3\n", stderr: "" }, isError: false }.
```

---

## 9. Extension Points (Delta)

The following items from `DESIGN.md` §9 are **removed** because they are now specified above:

- ~~Signal / timeout handling. Kill `docker exec` processes on cancellation.~~

Remaining extension points are unchanged.
