import * as yaml from "js-yaml";
import type { ExtractedPackData, ComponentCounts, ValidationResult, RepoTree } from "../types.js";
import schema from "../../schema/techpack-schema.json";
import { compileMatcher, compileAnyMatcher, type Matcher } from "./glob.js";
import { BUILTIN_IGNORED_DIRS, BUILTIN_INFRASTRUCTURE_FILES } from "./builtinIgnore.js";
import {
  hookInterpreterRejectionReason,
  interpreterBinary,
  isAmbiguouslyTyped,
  isCheckableBinary,
  lastPathComponent,
  resolveHookInterpreter,
  tokens,
} from "./hookInterpreter.js";

const TECHPACK_MANIFEST_FILENAME = "techpack.yaml";

const SOURCE_SHORTHAND_KEYS = ["hook", "command", "skill", "agent"] as const;

// Derive validation constants from the JSON schema (single source of truth)
const defs = schema.definitions;

const VALID_HOOK_EVENTS = new Set(defs.component.properties.hookEvent.enum);
const VALID_COMPONENT_TYPES = new Set(defs.component.properties.type.enum);
const VALID_SCOPES = new Set(defs.mcpShorthand.properties.scope.enum);
const VALID_PROMPT_TYPES = new Set(defs.prompt.properties.type.enum);
const VALID_DOCTOR_CHECK_TYPES = new Set(defs.doctorCheck.properties.type.enum);

const IDENTIFIER_PATTERN = schema.properties.identifier.pattern;
const IDENTIFIER_REGEX = new RegExp(IDENTIFIER_PATTERN);
const IDENTIFIER_MAX_LENGTH = schema.properties.identifier.maxLength;
const DISPLAY_NAME_MAX_LENGTH = schema.properties.displayName.maxLength;
const DESCRIPTION_MAX_LENGTH = schema.properties.description.maxLength;
const COMPONENT_ID_MAX_LENGTH = defs.component.properties.id.maxLength;

// Fail fast if schema structure changed unexpectedly
for (const [name, set] of Object.entries({
  VALID_HOOK_EVENTS, VALID_COMPONENT_TYPES, VALID_SCOPES,
  VALID_PROMPT_TYPES, VALID_DOCTOR_CHECK_TYPES,
})) {
  if (set.size === 0) throw new Error(`Schema derivation failed: ${name} is empty`);
}
for (const [name, val] of Object.entries({
  IDENTIFIER_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH, COMPONENT_ID_MAX_LENGTH,
})) {
  if (typeof val !== "number" || val <= 0) throw new Error(`Schema derivation failed: ${name} is not a positive number`);
}

const COMPONENT_TYPE_MAP: Record<string, keyof ComponentCounts> = {
  mcpServer: "mcpServers",
  plugin: "plugins",
  skill: "skills",
  hookFile: "hooks",
  command: "commands",
  agent: "agents",
  brewPackage: "brewPackages",
  configuration: "configurations",
};

// Maps shorthand keys to their inferred component type
const SHORTHAND_TYPE_MAP: Record<string, string> = {
  brew: "brewPackage",
  mcp: "mcpServer",
  plugin: "plugin",
  shell: "", // shell shorthand requires explicit type field
  hook: "hookFile",
  command: "command",
  skill: "skill",
  agent: "agent",
  settingsFile: "configuration",
  gitignore: "configuration",
};

const HOOK_METADATA_FIELDS = ["hookMatcher", "hookInterpreter", "hookTimeout", "hookAsync", "hookStatusMessage"] as const;

const SHORTHAND_KEYS = Object.keys(SHORTHAND_TYPE_MAP);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "to", "was", "were", "will", "with", "this", "your",
]);

export function validateTechpackYaml(yamlContent: string): ValidationResult {
  // Step 1: Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlContent);
  } catch (e) {
    return {
      valid: false,
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, errors: ["techpack.yaml must be a YAML object"], warnings: [] };
  }

  const manifest = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // Step 2: Structural validation (replaces Ajv — Workers block new Function())
  validateStructure(manifest, errors);

  // Step 3: Semantic validation (mirrors Swift ExternalPackManifest.validate())
  if (manifest.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  const identifier = manifest.identifier as string | undefined;
  if (identifier && !IDENTIFIER_REGEX.test(identifier)) {
    errors.push(
      `identifier '${identifier}' must match ${IDENTIFIER_PATTERN} (lowercase alphanumeric and hyphens, must start with letter or digit)`
    );
  }

  const components = (Array.isArray(manifest.components) ? manifest.components : []) as Array<Record<string, unknown>>;
  const componentIds = new Set<string>();

  for (const comp of components) {
    const id = comp.id as string | undefined;
    if (!id) continue;

    if (id.includes(".")) {
      errors.push(`Component id '${id}' must not contain dots`);
    }

    if (componentIds.has(id)) {
      errors.push(`Duplicate component id: '${id}'`);
    }
    componentIds.add(id);

    const hookEvent = comp.hookEvent as string | undefined;
    if (hookEvent && !VALID_HOOK_EVENTS.has(hookEvent)) {
      errors.push(
        `Component '${id}': invalid hookEvent '${hookEvent}'. Valid values: ${[...VALID_HOOK_EVENTS].join(", ")}`
      );
    }

    if (!hookEvent) {
      for (const field of HOOK_METADATA_FIELDS) {
        if (comp[field] != null) errors.push(`Component '${id}': ${field} requires hookEvent`);
      }
    }

    if (
      comp.hookTimeout != null &&
      (typeof comp.hookTimeout !== "number" || comp.hookTimeout <= 0)
    ) {
      errors.push(`Component '${id}': hookTimeout must be a positive integer`);
    }

    if (hookEvent && typeof comp.hookInterpreter === "string") {
      const reason = hookInterpreterRejectionReason(comp.hookInterpreter);
      if (reason) errors.push(`Component '${id}': ${reason}`);
    }
  }

  for (const check of allDoctorChecks(manifest)) {
    if (check.type !== "hookEventExists") continue;
    for (const field of ["matcher", "command"] as const) {
      if (check[field] === "") {
        errors.push(
          `Invalid doctor check '${check.name}': hookEventExists '${field}' must be non-empty — omit it to skip the assertion`
        );
      }
    }
  }

  // Unique prompt keys
  const prompts = (Array.isArray(manifest.prompts) ? manifest.prompts : []) as Array<Record<string, unknown>>;
  const promptKeys = new Set<string>();
  for (const prompt of prompts) {
    const key = prompt.key as string | undefined;
    if (key) {
      if (promptKeys.has(key)) {
        errors.push(`Duplicate prompt key: '${key}'`);
      }
      promptKeys.add(key);
    }
  }

  validateIgnoreField(manifest, errors);

  if (errors.length > 0) {
    return { valid: false, errors, warnings: [] };
  }

  // Step 4: Extract pack data for indexing
  const packData = extractPackData(manifest, components);
  return { valid: true, errors: [], warnings: [], packData, manifest };
}

function normalizeReferencedPath(path: string): string {
  return path.replace(/^\.\//, "").trim();
}

export function collectReferencedPaths(manifest: Record<string, unknown>): ReadonlySet<string> {
  const paths = new Set<string>();

  const components = Array.isArray(manifest.components) ? manifest.components : [];
  for (const raw of components) {
    if (!raw || typeof raw !== "object") continue;
    const comp = raw as Record<string, unknown>;
    for (const key of SOURCE_SHORTHAND_KEYS) {
      const shorthand = comp[key];
      if (shorthand && typeof shorthand === "object") {
        const source = (shorthand as Record<string, unknown>).source;
        if (typeof source === "string") paths.add(normalizeReferencedPath(source));
      }
    }
    if (typeof comp.settingsFile === "string") {
      paths.add(normalizeReferencedPath(comp.settingsFile));
    }
    const action = comp.installAction;
    if (action && typeof action === "object") {
      const source = (action as Record<string, unknown>).source;
      if (typeof source === "string") paths.add(normalizeReferencedPath(source));
    }
  }

  const templates = Array.isArray(manifest.templates) ? manifest.templates : [];
  for (const raw of templates) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.contentFile === "string") {
      paths.add(normalizeReferencedPath(t.contentFile));
    }
  }

  const configureProject = manifest.configureProject;
  if (configureProject && typeof configureProject === "object") {
    const script = (configureProject as Record<string, unknown>).script;
    if (typeof script === "string") paths.add(normalizeReferencedPath(script));
  }

  return paths;
}

function validateIgnoreField(manifest: Record<string, unknown>, errors: string[]): void {
  if (manifest.ignore === undefined) return;

  if (!Array.isArray(manifest.ignore)) {
    errors.push("'ignore' must be an array of strings");
    return;
  }

  const referenced = collectReferencedPaths(manifest);

  for (let i = 0; i < manifest.ignore.length; i++) {
    const entry = manifest.ignore[i];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`ignore[${i}] must be a non-empty string`);
      continue;
    }

    let matcher: Matcher;
    try {
      matcher = compileMatcher(entry);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      errors.push(`ignore[${i}] '${entry}' is not a valid pattern${detail}`);
      continue;
    }

    if (matcher(TECHPACK_MANIFEST_FILENAME)) {
      errors.push(
        `ignore[${i}] '${entry}' matches techpack.yaml — silencing the manifest is not allowed (supply-chain safety)`
      );
      continue;
    }

    for (const ref of referenced) {
      if (matcher(ref)) {
        errors.push(
          `ignore[${i}] '${entry}' matches referenced path '${ref}' — load-bearing files cannot be silenced`
        );
        break;
      }
    }
  }
}

// Mirrors ExternalPackLoader.findMissingReferencedFiles: a missing template, configure script or
// copied source fails `mcs pack validate` before any heuristic runs.
export function validateFileReferences(manifest: Record<string, unknown>, repoTree: RepoTree): string[] {
  const pathsToCheck: Array<{ path: string; label: string }> = [];

  for (const template of records(manifest.templates)) {
    if (typeof template.contentFile === "string") {
      const sectionId = (template.sectionIdentifier as string) ?? "unknown";
      pathsToCheck.push({ path: template.contentFile, label: `Template '${sectionId}' contentFile` });
    }
  }

  const configureProject = manifest.configureProject;
  if (configureProject && typeof configureProject === "object") {
    const script = (configureProject as Record<string, unknown>).script;
    if (typeof script === "string") pathsToCheck.push({ path: script, label: "configureProject script" });
  }

  for (const comp of records(manifest.components)) {
    const action = resolveInstallAction(comp);
    if (action?.kind === "copy" && action.source !== undefined) {
      pathsToCheck.push({ path: action.source, label: `Component '${comp.id}' source` });
    }
  }

  return pathsToCheck
    .filter(({ path }) => !existsInTree(path, repoTree))
    .map(({ path, label }) => `${label} '${normalizeReferencedPath(path)}' not found in repository`);
}

// The empty path is the pack root, which always exists — as it does for mcs's fileExists.
function existsInTree(rawPath: string, tree: RepoTree): boolean {
  const path = normalizeReferencedPath(rawPath);
  return path === "" || path === "." || tree.files.has(path) || tree.directories.has(path);
}

function validateStructure(manifest: Record<string, unknown>, errors: string[]): void {
  // Required string fields
  for (const field of ["identifier", "displayName", "description"] as const) {
    if (typeof manifest[field] !== "string" || (manifest[field] as string).length === 0) {
      errors.push(`'${field}' is required and must be a non-empty string`);
    }
  }

  // Length limits (derived from schema maxLength)
  if (typeof manifest.identifier === "string" && manifest.identifier.length > IDENTIFIER_MAX_LENGTH) {
    errors.push(`'identifier' must not exceed ${IDENTIFIER_MAX_LENGTH} characters`);
  }
  if (typeof manifest.displayName === "string" && manifest.displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    errors.push(`'displayName' must not exceed ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  if (typeof manifest.description === "string" && manifest.description.length > DESCRIPTION_MAX_LENGTH) {
    errors.push(`'description' must not exceed ${DESCRIPTION_MAX_LENGTH} characters`);
  }

  // schemaVersion must be a number
  if (typeof manifest.schemaVersion !== "number") {
    errors.push("'schemaVersion' is required and must be a number");
  }

  // Optional string fields
  for (const field of ["author", "minMCSVersion"] as const) {
    if (manifest[field] !== undefined && typeof manifest[field] !== "string") {
      errors.push(`'${field}' must be a string`);
    }
  }

  // components must be an array of objects
  if (manifest.components !== undefined) {
    if (!Array.isArray(manifest.components)) {
      errors.push("'components' must be an array");
    } else {
      for (let i = 0; i < manifest.components.length; i++) {
        const comp = manifest.components[i];
        if (!comp || typeof comp !== "object") {
          errors.push(`components[${i}] must be an object`);
          continue;
        }
        validateComponent(comp as Record<string, unknown>, i, errors);
      }
    }
  }

  // templates must be an array
  if (manifest.templates !== undefined && !Array.isArray(manifest.templates)) {
    errors.push("'templates' must be an array");
  }

  // configureProject must be an object with a script field if present
  if (manifest.configureProject !== undefined) {
    if (!manifest.configureProject || typeof manifest.configureProject !== "object") {
      errors.push("'configureProject' must be an object");
    } else {
      const cp = manifest.configureProject as Record<string, unknown>;
      if (typeof cp.script !== "string" || cp.script.length === 0) {
        errors.push("'configureProject.script' is required and must be a non-empty string");
      }
    }
  }

  // prompts must be an array
  if (manifest.prompts !== undefined) {
    if (!Array.isArray(manifest.prompts)) {
      errors.push("'prompts' must be an array");
    } else {
      for (let i = 0; i < manifest.prompts.length; i++) {
        const prompt = manifest.prompts[i] as Record<string, unknown>;
        if (!prompt || typeof prompt !== "object") {
          errors.push(`prompts[${i}] must be an object`);
          continue;
        }
        if (typeof prompt.key !== "string") {
          errors.push(`prompts[${i}].key is required and must be a string`);
        }
        if (prompt.type === undefined) {
          errors.push(`prompts[${i}].type is required`);
        } else if (!VALID_PROMPT_TYPES.has(prompt.type as string)) {
          errors.push(`prompts[${i}].type must be one of: ${[...VALID_PROMPT_TYPES].join(", ")}`);
        }
      }
    }
  }

  // supplementaryDoctorChecks must be an array
  if (manifest.supplementaryDoctorChecks !== undefined) {
    if (!Array.isArray(manifest.supplementaryDoctorChecks)) {
      errors.push("'supplementaryDoctorChecks' must be an array");
    } else {
      for (let i = 0; i < manifest.supplementaryDoctorChecks.length; i++) {
        const check = manifest.supplementaryDoctorChecks[i] as Record<string, unknown>;
        if (!check || typeof check !== "object") continue;
        if (typeof check.name !== "string" || (check.name as string).length === 0) {
          errors.push(`supplementaryDoctorChecks[${i}].name is required and must be a non-empty string`);
        }
        if (check.type === undefined) {
          errors.push(`supplementaryDoctorChecks[${i}].type is required`);
        } else if (!VALID_DOCTOR_CHECK_TYPES.has(check.type as string)) {
          errors.push(`supplementaryDoctorChecks[${i}].type must be one of: ${[...VALID_DOCTOR_CHECK_TYPES].join(", ")}`);
        }
      }
    }
  }
}

function validateComponent(comp: Record<string, unknown>, index: number, errors: string[]): void {
  // id is required, displayName is optional
  if (typeof comp.id !== "string") {
    errors.push(`components[${index}].id is required and must be a string`);
  } else if (comp.id.length > COMPONENT_ID_MAX_LENGTH) {
    errors.push(`components[${index}].id must not exceed ${COMPONENT_ID_MAX_LENGTH} characters`);
  }
  if (comp.displayName !== undefined && typeof comp.displayName !== "string") {
    errors.push(`components[${index}].displayName must be a string`);
  }

  // description is required on components
  if (typeof comp.description !== "string" || (comp.description as string).length === 0) {
    errors.push(`components[${index}].description is required and must be a non-empty string`);
  }

  // Resolve type (shorthand or explicit)
  const resolvedType = resolveComponentType(comp);

  // If explicit type field, validate it
  if (comp.type !== undefined && typeof comp.type === "string" && !VALID_COMPONENT_TYPES.has(comp.type)) {
    errors.push(`components[${index}].type '${comp.type}' is not a valid component type`);
  }

  // Component must have a resolvable type (via shorthand or explicit type field)
  if (!resolvedType) {
    errors.push(`components[${index}] must have a type (via 'type' field or a shorthand like mcp, hook, skill, etc.)`);
  }

  // Scope validation
  if (comp.scope !== undefined && !VALID_SCOPES.has(comp.scope as string)) {
    errors.push(`components[${index}].scope must be one of: ${[...VALID_SCOPES].join(", ")}`);
  }

  // hookEvent must be a string if present
  if (comp.hookEvent !== undefined && typeof comp.hookEvent !== "string") {
    errors.push(`components[${index}].hookEvent must be a string`);
  }

  // hookAsync must be boolean
  if (comp.hookAsync != null && typeof comp.hookAsync !== "boolean") {
    errors.push(`components[${index}].hookAsync must be a boolean`);
  }

  for (const field of ["hookMatcher", "hookStatusMessage", "hookInterpreter"] as const) {
    if (comp[field] != null && typeof comp[field] !== "string") {
      errors.push(`components[${index}].${field} must be a string`);
    }
  }
}

function extractPackData(
  manifest: Record<string, unknown>,
  components: Array<Record<string, unknown>>
): ExtractedPackData {
  const counts: ComponentCounts = {
    mcpServers: 0,
    hooks: 0,
    skills: 0,
    commands: 0,
    agents: 0,
    brewPackages: 0,
    plugins: 0,
    configurations: 0,
    templates: 0,
  };

  for (const comp of components) {
    const type = resolveComponentType(comp);
    if (type && type in COMPONENT_TYPE_MAP) {
      const key = COMPONENT_TYPE_MAP[type];
      counts[key]++;
    }
  }

  const templates = (manifest.templates ?? []) as Array<unknown>;
  counts.templates = templates.length;

  const description = (manifest.description as string) ?? "";
  const identifier = (manifest.identifier as string) ?? "";

  const keywords = extractKeywords(identifier, description);

  return {
    identifier,
    displayName: (manifest.displayName as string) ?? identifier,
    description,
    author: (manifest.author as string) ?? null,
    components: counts,
    keywords,
  };
}

// The shorthand mcs resolveShorthand picks, in its precedence order; its `contains` is true for an explicit null too.
function shorthandKey(comp: Record<string, unknown>): string | undefined {
  return SHORTHAND_KEYS.find((key) => comp[key] !== undefined);
}

function resolveComponentType(comp: Record<string, unknown>): string | null {
  const key = shorthandKey(comp);
  if (key !== undefined) {
    const type = SHORTHAND_TYPE_MAP[key];
    // shell shorthand requires explicit type field
    if (type === "") return typeof comp.type === "string" ? comp.type : null;
    return type;
  }

  // Check explicit type field
  if (typeof comp.type === "string") return comp.type;

  return null;
}

function extractKeywords(
  identifier: string,
  description: string
): string[] {
  const words = new Set<string>();

  // Split identifier on hyphens
  for (const part of identifier.split("-")) {
    if (part.length > 2 && !STOP_WORDS.has(part)) {
      words.add(part.toLowerCase());
    }
  }

  // Split description into words
  for (const word of description.split(/\s+/)) {
    const cleaned = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (cleaned.length > 2 && !STOP_WORDS.has(cleaned)) {
      words.add(cleaned);
    }
  }

  return [...words];
}

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  message: string;
}

const error = (message: string): Finding => ({ severity: "error", message });
const warning = (message: string): Finding => ({ severity: "warning", message });

// Shared with the hint detector below, as mcs's `unreferencedMarker` is.
const UNREFERENCED_MARKER = "is not referenced";

// Mirrors mcs PackHeuristics.check, check for check and in its order. Checks that read the
// pack's files are skipped when the repository tree could not be enumerated.
export function runHeuristics(manifest: Record<string, unknown>, tree: RepoTree | null): Finding[] {
  const components = records(manifest.components);
  const resolved = components.map(resolveComponent);
  const brewPackages = collectBrewPackages(resolved);
  const doctorChecks = allDoctorChecks(manifest);

  const unreferenced = tree
    ? [...checkUnreferencedFiles(manifest, tree), ...checkRootLevelContentFiles(manifest, tree)]
    : [];

  const findings: Finding[] = [
    ...checkEmptyPack(manifest),
    ...checkRootSourceCopy(resolved),
    ...(tree ? checkSettingsFileSources(components, tree) : []),
    ...unreferenced,
    ...checkMCPDependencyGaps(resolved, brewPackages).map(warning),
    ...(tree ? checkPythonModulePaths(resolved, tree) : []),
    ...checkDoctorCheckScopeUsage(doctorChecks).map(warning),
    ...checkDoctorCheckMatcherUsage(doctorChecks).map(warning),
    ...checkAmbiguousHookExtensions(resolved).map(warning),
    ...checkUninstalledHookRuntimes(resolved, brewPackages).map(warning),
    ...checkHookDoctorCheckInterpreters(manifest, resolved).map(warning),
    ...checkDeprecatedKeys(manifest, components).map(warning),
  ];

  if (unreferenced.some((f) => f.message.includes(UNREFERENCED_MARKER))) {
    findings.push(warning(
      "Add intentional non-material paths (docs/, examples/, assets) to the `ignore:` field in techpack.yaml to silence these warnings."
    ));
  }

  return findings;
}

function checkEmptyPack(manifest: Record<string, unknown>): Finding[] {
  const empty = (value: unknown) => !Array.isArray(value) || value.length === 0;
  if (empty(manifest.components) && empty(manifest.templates) && manifest.configureProject == null) {
    return [error("Pack has no components, templates, or configure script — nothing to install")];
  }
  return [];
}

function checkRootSourceCopy(resolved: ResolvedComponent[]): Finding[] {
  return resolved
    .filter(({ action }) => action?.kind === "copy" && action.source !== undefined && isPackRoot(action.source))
    .map(({ comp }) => error(
      `Component '${comp.id}' uses source '.' which copies the entire pack root (including techpack.yaml, LICENSE, README)`
    ));
}

function isPackRoot(rawPath: string): boolean {
  const path = normalizeReferencedPath(rawPath);
  return path === "" || path === ".";
}

function settingsFileSource(comp: Record<string, unknown>): string | undefined {
  if (shorthandKey(comp) === "settingsFile") return optionalString(comp.settingsFile);
  if (shorthandKey(comp) !== undefined) return undefined;
  const action = comp.installAction;
  if (!action || typeof action !== "object") return undefined;
  const a = action as Record<string, unknown>;
  return a.type === "settingsFile" ? optionalString(a.source) : undefined;
}

function checkSettingsFileSources(components: Array<Record<string, unknown>>, tree: RepoTree): Finding[] {
  const findings: Finding[] = [];
  for (const comp of components) {
    const source = settingsFileSource(comp);
    if (source === undefined || existsInTree(source, tree)) continue;
    findings.push(error(`Component '${comp.id}' references settings file '${source}' which does not exist`));
  }
  return findings;
}

const isHidden = (name: string) => name.startsWith(".");

// The direct children of a directory, as FileManager.contentsOfDirectory(.skipsHiddenFiles) lists them.
function childrenOf(dir: string, tree: RepoTree): { files: string[]; directories: string[] } {
  const prefix = dir === "" ? "" : `${dir}/`;
  const direct = (paths: Set<string>) =>
    [...paths]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .filter((p) => !isHidden(p.slice(prefix.length)))
      .sort();
  return { files: direct(tree.files), directories: direct(tree.directories) };
}

// Mirrors PackHeuristics.checkUnreferencedFiles: one level into each top-level directory, so a
// nested directory is reported once rather than file by file.
function checkUnreferencedFiles(manifest: Record<string, unknown>, tree: RepoTree): Finding[] {
  const referenced = collectReferencedPaths(manifest);
  const ignored = ignoreMatcherFor(manifest);
  const findings: Finding[] = [];

  for (const dir of childrenOf("", tree).directories) {
    if (BUILTIN_IGNORED_DIRS.has(dir) || ignored(dir)) continue;
    const { files, directories } = childrenOf(dir, tree);
    for (const item of [...directories, ...files].sort()) {
      if (referenced.has(item) || ignored(item)) continue;
      findings.push(warning(`${item} ${UNREFERENCED_MARKER} by any component or template`));
    }
  }
  return findings;
}

// Mirrors PackHeuristics.checkRootLevelContentFiles.
function checkRootLevelContentFiles(manifest: Record<string, unknown>, tree: RepoTree): Finding[] {
  const referenced = collectReferencedPaths(manifest);
  const ignored = ignoreMatcherFor(manifest);
  return childrenOf("", tree).files
    .filter((name) => !BUILTIN_INFRASTRUCTURE_FILES.has(name) && !referenced.has(name) && !ignored(name))
    .map((name) => warning(`${name} ${UNREFERENCED_MARKER} by any component`));
}

// An unparseable pattern already fails validateTechpackYaml; here it must not take the other checks down.
function ignoreMatcherFor(manifest: Record<string, unknown>): Matcher {
  const patterns = Array.isArray(manifest.ignore)
    ? manifest.ignore.filter((p): p is string => typeof p === "string")
    : [];
  try {
    return compileAnyMatcher(patterns);
  } catch {
    return () => false;
  }
}

// Mirrors PackHeuristics.checkPythonModulePaths: `python -m pkg` needs a `pkg/` directory in the pack.
function checkPythonModulePaths(resolved: ResolvedComponent[], tree: RepoTree): Finding[] {
  const findings: Finding[] = [];
  for (const { action } of resolved) {
    if (action?.kind !== "mcp" || action.command === undefined || action.args === undefined) continue;
    if (!["python", "python3"].includes(lastPathComponent(action.command))) continue;
    const m = action.args.indexOf("-m");
    if (m < 0 || m + 1 >= action.args.length) continue;
    const moduleName = action.args[m + 1];
    if (tree.directories.has(moduleName)) continue;
    findings.push(warning(
      `MCP server '${action.name}' references module '${moduleName}' but ${moduleName}/ directory not found in pack`
    ));
  }
  return findings;
}

type InstallAction =
  | { kind: "brew"; package: string }
  | { kind: "mcp"; name: string; command?: string; args?: string[] }
  | { kind: "copy"; source?: string; destination?: string; fileType?: string };

interface HookInvocation {
  interpreter: string;
  explicit: boolean;
  destination: string;
  source?: string;
}

interface ResolvedComponent {
  comp: Record<string, unknown>;
  action: InstallAction | null;
  hook: HookInvocation | null;
}

const COPY_SHORTHAND_KEYS = new Set<string>(SOURCE_SHORTHAND_KEYS);

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function brewAction(pkg: unknown): InstallAction | null {
  return typeof pkg === "string" ? { kind: "brew", package: pkg } : null;
}

function mcpAction(config: Record<string, unknown>, id: unknown): InstallAction {
  const args = Array.isArray(config.args) && config.args.every((a) => typeof a === "string")
    ? (config.args as string[])
    : undefined;
  return { kind: "mcp", name: optionalString(config.name) ?? String(id), command: optionalString(config.command), args };
}

function copyAction(config: Record<string, unknown>, fileType: string | undefined): InstallAction {
  return {
    kind: "copy",
    source: optionalString(config.source),
    destination: optionalString(config.destination),
    fileType,
  };
}

function resolveInstallAction(comp: Record<string, unknown>): InstallAction | null {
  const key = shorthandKey(comp);
  if (key !== undefined) {
    const value = comp[key];
    const config = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    switch (key) {
      case "brew":
        return brewAction(value);
      case "mcp":
        return config && mcpAction(config, comp.id);
      default:
        return config && COPY_SHORTHAND_KEYS.has(key) ? copyAction(config, key) : null;
    }
  }

  const action = comp.installAction;
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  switch (a.type) {
    case "brewInstall":
      return brewAction(a.package);
    case "mcpServer":
      return mcpAction(a, comp.id);
    case "copyPackFile":
      return copyAction(a, optionalString(a.fileType));
    default:
      return null;
  }
}

// Mirrors ExternalComponentDefinition.hookInvocation. Dropping any guard reports hooks that sync never registers.
function resolveComponent(comp: Record<string, unknown>): ResolvedComponent {
  const action = resolveInstallAction(comp);
  if (
    resolveComponentType(comp) !== "hookFile" ||
    typeof comp.hookEvent !== "string" ||
    action?.kind !== "copy" ||
    action.fileType !== "hook" ||
    action.destination === undefined
  ) {
    return { comp, action, hook: null };
  }
  const { destination, source } = action;
  const explicit = optionalString(comp.hookInterpreter);
  const interpreter = resolveHookInterpreter(explicit, destination, source);
  return { comp, action, hook: { interpreter, explicit: explicit !== undefined, destination, source } };
}

function allDoctorChecks(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    ...records(manifest.supplementaryDoctorChecks),
    ...records(manifest.components).flatMap((c) => records(c.doctorChecks)),
  ];
}

// Every name a formula can be matched by — `brew: owner/tap/node` must still read as installing node.
function collectBrewPackages(resolved: ResolvedComponent[]): Set<string> {
  const packages = new Set<string>();
  for (const { action } of resolved) {
    if (action?.kind !== "brew") continue;
    packages.add(action.package);
    packages.add(lastPathComponent(action.package));
  }
  return packages;
}

// The executable and its formula are not always spelled the same: python3 ships in `python`, npx in `node`.
const FORMULA_ALIASES: Record<string, string[]> = {
  python3: ["python"],
  python: ["python3"],
  npx: ["node"],
};

function installs(executable: string, packages: ReadonlySet<string>): boolean {
  for (const formula of [executable, ...(FORMULA_ALIASES[executable] ?? [])]) {
    if (packages.has(formula)) return true;
    const versioned = `${formula}@`;
    for (const p of packages) if (p.startsWith(versioned)) return true;
  }
  return false;
}

const MCP_RUNTIMES: Record<string, string> = { python: "python", python3: "python", node: "node", npx: "node" };

function checkMCPDependencyGaps(resolved: ResolvedComponent[], brewPackages: ReadonlySet<string>): string[] {
  const findings: string[] = [];
  for (const { action } of resolved) {
    if (action?.kind !== "mcp" || action.command === undefined) continue;
    const runtime = MCP_RUNTIMES[lastPathComponent(action.command)];
    if (runtime && !installs(runtime, brewPackages)) {
      findings.push(`MCP server '${action.name}' uses ${runtime} but no brew component installs ${runtime}`);
    }
  }
  return findings;
}

const SCOPE_HONORING_CHECK_TYPES = new Set(["fileExists", "directoryExists", "fileContains", "fileNotContains"]);

function checkDoctorCheckScopeUsage(checks: Array<Record<string, unknown>>): string[] {
  return checks
    .filter((c) => c.scope != null && typeof c.type === "string" && !SCOPE_HONORING_CHECK_TYPES.has(c.type))
    .map((c) => {
      const detail = c.type === "hookEventExists" || c.type === "settingsKeyEquals"
        ? "settings are resolved from the project root automatically (project settings.local.json, then global settings.json)"
        : "`scope` only applies to checks with a `path`";
      return `Doctor check '${c.name}' declares \`scope\` but type \`${c.type}\` ignores it — ${detail}`;
    });
}

function checkDoctorCheckMatcherUsage(checks: Array<Record<string, unknown>>): string[] {
  return checks
    .filter((c) => c.matcher != null && typeof c.type === "string" && c.type !== "hookEventExists")
    .map((c) =>
      `Doctor check '${c.name}' declares \`matcher\` but type \`${c.type}\` ignores it — \`matcher\` applies only to \`hookEventExists\``
    );
}

function checkAmbiguousHookExtensions(resolved: ResolvedComponent[]): string[] {
  const findings: string[] = [];
  for (const { comp, hook } of resolved) {
    if (!hook || hook.explicit) continue;
    if (!isAmbiguouslyTyped(hook.destination, hook.source)) continue;
    findings.push(
      `Hook '${comp.id}' installs '${hook.destination}' but declares no hookInterpreter — it will run under bash. TypeScript has no single default; declare one (e.g. \`hookInterpreter: node --experimental-strip-types\`).`
    );
  }
  return findings;
}

function checkUninstalledHookRuntimes(resolved: ResolvedComponent[], brewPackages: ReadonlySet<string>): string[] {
  const findings: string[] = [];
  const reported = new Set<string>();
  for (const { comp, hook } of resolved) {
    if (!hook) continue;
    const binary = interpreterBinary(hook.interpreter);
    if (!isCheckableBinary(binary) || binary.startsWith("/") || installs(binary, brewPackages) || reported.has(binary)) continue;
    reported.add(binary);
    findings.push(`Hook '${comp.id}' uses ${binary} but no brew component installs ${binary}`);
  }
  return findings;
}

// Only an assertion naming the whole invocation (`bash .claude/hooks/gate.ts`) can contradict the hook.
function assertedInterpreter(asserted: string, destination: string): string | null {
  const parts = tokens(asserted);
  let pathIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes(destination)) {
      pathIndex = i;
      break;
    }
  }
  if (pathIndex <= 0) return null;
  return parts.slice(0, pathIndex).join(" ");
}

function checkHookDoctorCheckInterpreters(manifest: Record<string, unknown>, resolved: ResolvedComponent[]): string[] {
  const supplementary = records(manifest.supplementaryDoctorChecks);
  const findings: string[] = [];
  for (const { comp, hook } of resolved) {
    if (!hook) continue;
    // Pairing every pack-level check with every hook would flag a bash assertion meant for the pack's bash hook.
    const correlated = supplementary.filter((c) => typeof c.command === "string" && c.command.includes(hook.destination));
    for (const check of [...records(comp.doctorChecks), ...correlated]) {
      if (check.type !== "hookEventExists" || typeof check.command !== "string") continue;
      const demanded = assertedInterpreter(check.command, hook.destination);
      if (demanded === null || demanded === hook.interpreter) continue;
      findings.push(
        `Doctor check '${check.name}' asserts command '${check.command}' but hook '${comp.id}' is registered with '${hook.interpreter}' — the check will never match`
      );
    }
  }
  return findings;
}

const DEPRECATED_KEYS = ["isRequired", "dependencies"] as const;

// `in`, not a null test: mcs checks `container.contains`, so a blank key still counts as declared.
function checkDeprecatedKeys(manifest: Record<string, unknown>, components: Array<Record<string, unknown>>): string[] {
  const owners: Array<[string, Record<string, unknown>]> = [
    ...components.map((c): [string, Record<string, unknown>] => [`Component '${c.id}'`, c]),
    ...records(manifest.templates).map((t): [string, Record<string, unknown>] => [`Template '${t.sectionIdentifier}'`, t]),
  ];
  const findings: string[] = [];
  for (const [owner, obj] of owners) {
    for (const key of DEPRECATED_KEYS) {
      if (key in obj) {
        findings.push(
          `${owner} declares \`${key}\`, which is deprecated and ignored — packs install every component, in declaration order`
        );
      }
    }
  }
  return findings;
}
