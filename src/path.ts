import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Expand a leading `~` to the user's home directory.
 * `~username` is unsupported and returned as-is.
 */
export function expandTilde(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}
