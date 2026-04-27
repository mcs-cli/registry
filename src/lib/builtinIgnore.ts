// Mirrors mcs's Sources/mcs/ExternalPack/PackHeuristics.swift:97-100 and :215-220.
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
