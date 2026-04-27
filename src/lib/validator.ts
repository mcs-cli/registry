import * as yaml from "js-yaml";
import type { ExtractedPackData, ComponentCounts, ValidationResult, RepoTree } from "../types.js";
import schema from "../../schema/techpack-schema.json";
import { compileMatcher, compileAnyMatcher, type Matcher } from "./glob.js";
import { BUILTIN_IGNORED_DIRS, BUILTIN_INFRASTRUCTURE_FILES } from "./builtinIgnore.js";

const TECHPACK_MANIFEST_FILENAME = "techpack.yaml";

const SOURCE_SHORTHAND_KEYS = ["hook", "command", "skill", "agent"] as const;

const UNREFERENCED_HINT_CAP = 50;

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
      if (comp.hookTimeout !== undefined) {
        errors.push(`Component '${id}': hookTimeout requires hookEvent`);
      }
      if (comp.hookAsync !== undefined) {
        errors.push(`Component '${id}': hookAsync requires hookEvent`);
      }
      if (comp.hookStatusMessage !== undefined) {
        errors.push(`Component '${id}': hookStatusMessage requires hookEvent`);
      }
    }

    if (
      comp.hookTimeout !== undefined &&
      (typeof comp.hookTimeout !== "number" || comp.hookTimeout <= 0)
    ) {
      errors.push(`Component '${id}': hookTimeout must be a positive integer`);
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

function hasReferencedAncestor(file: string, referenced: ReadonlySet<string>): boolean {
  let i = file.lastIndexOf("/");
  while (i > 0) {
    if (referenced.has(file.slice(0, i))) return true;
    i = file.lastIndexOf("/", i - 1);
  }
  return false;
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

export function validateFileReferences(
  manifest: Record<string, unknown>,
  repoTree: RepoTree
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pathsToCheck: Array<{ path: string; label: string }> = [];

  // Extract source paths from components
  const components = (manifest.components ?? []) as Array<Record<string, unknown>>;
  for (const comp of components) {
    const id = (comp.id as string) ?? "unknown";

    for (const key of SOURCE_SHORTHAND_KEYS) {
      const shorthand = comp[key] as Record<string, unknown> | undefined;
      if (shorthand && typeof shorthand === "object" && typeof shorthand.source === "string") {
        pathsToCheck.push({ path: shorthand.source, label: `Component '${id}' ${key} source` });
      }
    }

    // Shorthand: settingsFile (plain string)
    if (typeof comp.settingsFile === "string") {
      pathsToCheck.push({ path: comp.settingsFile, label: `Component '${id}' settingsFile` });
    }

    // Verbose: installAction with source field
    const action = comp.installAction as Record<string, unknown> | undefined;
    if (action && typeof action === "object" && typeof action.source === "string") {
      pathsToCheck.push({ path: action.source, label: `Component '${id}' installAction source` });
    }
  }

  // Extract contentFile from templates
  const templates = (manifest.templates ?? []) as Array<Record<string, unknown>>;
  for (const template of templates) {
    if (typeof template.contentFile === "string") {
      const sectionId = (template.sectionIdentifier as string) ?? "unknown";
      pathsToCheck.push({ path: template.contentFile, label: `Template '${sectionId}' contentFile` });
    }
  }

  // Extract configureProject.script
  const configureProject = manifest.configureProject as Record<string, unknown> | undefined;
  if (configureProject && typeof configureProject === "object" && typeof configureProject.script === "string") {
    pathsToCheck.push({ path: configureProject.script, label: "configureProject script" });
  }

  for (const { path: rawPath, label } of pathsToCheck) {
    const normalized = normalizeReferencedPath(rawPath);

    // source: "." or "./" — repo root, always exists but almost always wrong
    if (normalized === "" || normalized === ".") {
      warnings.push(
        `${label} '${rawPath}' points to the repository root — this will copy unintended files (LICENSE, README.md, techpack.yaml)`
      );
      continue;
    }

    const inFiles = repoTree.files.has(normalized);
    const inDirs = repoTree.directories.has(normalized);

    if (!inFiles && !inDirs) {
      errors.push(`${label} '${normalized}' not found in repository`);
      continue;
    }

    // Warn if a directory source contains repo boilerplate
    if (inDirs) {
      const boilerplate = ["techpack.yaml", "LICENSE", "README.md"];
      const found = boilerplate.filter((f) => repoTree.files.has(`${normalized}/${f}`));
      if (found.length > 0) {
        warnings.push(
          `${label} directory '${normalized}' contains ${found.join(", ")} — may be copying unintended files`
        );
      }
    }
  }

  return { errors, warnings };
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

  // A techpack must have at least one component or template
  const componentsCount = Array.isArray(manifest.components) ? manifest.components.length : 0;
  const templatesCount = Array.isArray(manifest.templates) ? manifest.templates.length : 0;
  if (componentsCount === 0 && templatesCount === 0) {
    errors.push("techpack must contain at least one component or template");
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
  if (comp.hookAsync !== undefined && typeof comp.hookAsync !== "boolean") {
    errors.push(`components[${index}].hookAsync must be a boolean`);
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

function resolveComponentType(comp: Record<string, unknown>): string | null {
  // Check shorthand keys first
  for (const [key, type] of Object.entries(SHORTHAND_TYPE_MAP)) {
    if (comp[key] !== undefined) {
      // shell shorthand requires explicit type field
      if (type === "") return typeof comp.type === "string" ? comp.type : null;
      return type;
    }
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

export function runHeuristics(
  manifest: Record<string, unknown>,
  tree: RepoTree
): string[] {
  const hints: string[] = [];
  const components = (Array.isArray(manifest.components) ? manifest.components : []) as Array<Record<string, unknown>>;

  const referencedPaths = collectReferencedPaths(manifest);
  const ignorePatterns = Array.isArray(manifest.ignore)
    ? manifest.ignore.filter((p): p is string => typeof p === "string")
    : [];
  let ignoreMatcher: (path: string) => boolean;
  try {
    ignoreMatcher = compileAnyMatcher(ignorePatterns);
  } catch {
    ignoreMatcher = () => false;
  }

  const topLevelDirs = new Set<string>();
  for (const dir of tree.directories) {
    if (!dir.includes("/")) topLevelDirs.add(dir);
  }

  const filesByTopDir = new Map<string, string[]>();
  const rootFiles: string[] = [];
  for (const file of tree.files) {
    const slash = file.indexOf("/");
    if (slash < 0) {
      rootFiles.push(file);
      continue;
    }
    const top = file.slice(0, slash);
    if (!topLevelDirs.has(top)) continue;
    let bucket = filesByTopDir.get(top);
    if (!bucket) {
      bucket = [];
      filesByTopDir.set(top, bucket);
    }
    bucket.push(file);
  }

  let capped = false;
  const pushHint = (hint: string): void => {
    if (capped) return;
    if (hints.length >= UNREFERENCED_HINT_CAP) {
      hints.push(`… additional unreferenced files truncated (cap: ${UNREFERENCED_HINT_CAP})`);
      capped = true;
      return;
    }
    hints.push(hint);
  };

  // Mirrors mcs PackHeuristics.checkUnreferencedFiles.
  outer: for (const [dir, files] of filesByTopDir) {
    if (BUILTIN_IGNORED_DIRS.has(dir)) continue;
    if (ignoreMatcher(dir)) continue;

    for (const file of files) {
      if (capped) break outer;
      if (referencedPaths.has(file)) continue;
      if (hasReferencedAncestor(file, referencedPaths)) continue;
      if (ignoreMatcher(file)) continue;
      pushHint(`Unreferenced file '${file}' in ${dir}/ directory — may be unwired content`);
    }
  }

  // Mirrors mcs PackHeuristics.checkRootLevelContentFiles.
  for (const file of rootFiles) {
    if (capped) break;
    if (BUILTIN_INFRASTRUCTURE_FILES.has(file)) continue;
    if (referencedPaths.has(file)) continue;
    if (ignoreMatcher(file)) continue;
    pushHint(`Unreferenced file '${file}' at repository root — not referenced by any component`);
  }

  // Heuristic 2: MCP server uses python/node but no matching brew package
  const mcpComponents = components.filter((c) => {
    const type = c.type as string | undefined;
    return type === "mcpServer" || c.mcp !== undefined;
  });
  const brewIds = new Set(
    components
      .filter((c) => c.type === "brewPackage" || c.brew !== undefined)
      .map((c) => c.id as string)
  );

  for (const mcp of mcpComponents) {
    const mcpConfig = mcp.mcp as Record<string, unknown> | undefined;
    const command = mcpConfig?.command as string | undefined;
    if (!command) continue;

    if ((command === "python" || command === "python3") && !brewIds.has("python") && !brewIds.has("python3")) {
      hints.push(`MCP server '${mcp.id}' uses '${command}' but no python brew package is declared`);
    }
    if ((command === "node" || command === "npx") && !brewIds.has("node")) {
      hints.push(`MCP server '${mcp.id}' uses '${command}' but no node brew package is declared`);
    }
  }

  return hints;
}
