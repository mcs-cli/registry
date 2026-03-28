import * as yaml from "js-yaml";
import type { ExtractedPackData, ComponentCounts, ValidationResult } from "../types.js";

const VALID_HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
  "InstructionsLoaded",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "Elicitation",
  "ElicitationResult",
]);

const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const VALID_COMPONENT_TYPES = new Set([
  "mcpServer", "plugin", "skill", "hookFile", "command",
  "agent", "brewPackage", "configuration",
]);

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

const VALID_SCOPES = new Set(["local", "user", "project"]);
const VALID_PROMPT_TYPES = new Set(["fileDetect", "input", "select", "script"]);
const VALID_DOCTOR_CHECK_TYPES = new Set([
  "commandExists", "fileExists", "directoryExists",
  "fileContains", "fileNotContains", "shellScript",
  "hookEventExists", "settingsKeyEquals",
]);

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
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, errors: ["techpack.yaml must be a YAML object"] };
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
      `identifier '${identifier}' must match ^[a-z0-9][a-z0-9-]*$ (lowercase alphanumeric and hyphens, must start with letter or digit)`
    );
  }

  const components = (manifest.components ?? []) as Array<Record<string, unknown>>;
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
  const prompts = (manifest.prompts ?? []) as Array<Record<string, unknown>>;
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

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Step 4: Extract pack data for indexing
  const packData = extractPackData(manifest, components);
  return { valid: true, errors: [], packData };
}

function validateStructure(manifest: Record<string, unknown>, errors: string[]): void {
  // Required string fields
  for (const field of ["identifier", "displayName", "description"] as const) {
    if (typeof manifest[field] !== "string" || (manifest[field] as string).length === 0) {
      errors.push(`'${field}' is required and must be a non-empty string`);
    }
  }

  // Length limits to prevent abuse
  if (typeof manifest.identifier === "string" && manifest.identifier.length > 100) {
    errors.push("'identifier' must not exceed 100 characters");
  }
  if (typeof manifest.displayName === "string" && manifest.displayName.length > 200) {
    errors.push("'displayName' must not exceed 200 characters");
  }
  if (typeof manifest.description === "string" && manifest.description.length > 2000) {
    errors.push("'description' must not exceed 2000 characters");
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
  } else if (comp.id.length > 100) {
    errors.push(`components[${index}].id must not exceed 100 characters`);
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
