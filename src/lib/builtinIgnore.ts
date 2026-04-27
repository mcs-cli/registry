// Mirrors mcs's PackHeuristics.ignoredDirectories and PackHeuristics.infrastructureFiles.
// Keep these in sync with the mcs binary — drift means registry warnings disagree
// with `mcs pack validate` output for the same pack.

export const BUILTIN_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".github",
  ".gitlab",
  ".vscode",
  "node_modules",
  "__pycache__",
  ".build",
]);

export const BUILTIN_INFRASTRUCTURE_FILES: ReadonlySet<string> = new Set([
  "techpack.yaml",
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  ".gitignore",
  ".editorconfig",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "Makefile",
  "Dockerfile",
  ".dockerignore",
]);
