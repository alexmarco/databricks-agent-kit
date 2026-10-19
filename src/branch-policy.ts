/** Verdict on a pull request from `source` into `target`; `reason` is shown to the contributor when the pull request is rejected. */
export type BranchDecision = { allowed: true } | { allowed: false; reason: string };

/** Decides from the branch names alone whether a pull request may target its base branch (GitFlow, simplified). */
export function checkBranchPolicy(source: string, target: string): BranchDecision {
  if (target === "main") {
    if (source === "develop" || source.startsWith("hotfix/")) return { allowed: true };
    return { allowed: false, reason: `A pull request into "main" must come from "develop" or a "hotfix/*" branch, not from "${source}".` };
  }
  if (target === "develop") {
    if (source.startsWith("feature/") || source.startsWith("bugfix/") || source.startsWith("hotfix/")) return { allowed: true };
    return { allowed: false, reason: `A pull request into "develop" must come from a "feature/*", "bugfix/*" or "hotfix/*" branch, not from "${source}".` };
  }
  return { allowed: false, reason: `A pull request from "${source}" must target "develop" or "main", not "${target}".` };
}
