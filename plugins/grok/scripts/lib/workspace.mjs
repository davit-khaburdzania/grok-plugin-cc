import { ensureGitRepository } from "./git.mjs";

/**
 * The workspace root is the git toplevel when available, otherwise the cwd.
 * Job state is keyed by this path so that every subdirectory of one repository
 * shares the same job list.
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
