import Ajv from "ajv";
import * as yaml from "js-yaml";
import type { ExtractedPackData, ComponentCounts, ValidationResult } from "../types.js";
import techpackSchema from "../../schema/techpack-schema.json" with { type: "json" };

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
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, errors: ["techpack.yaml must be a YAML object"] };
  }

  const manifest = parsed as Record<string, unknown>;

  // Step 2: JSON Schema structural validation
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(techpackSchema);
  const schemaValid = validate(manifest);

  const errors: string[] = [];
  if (!schemaValid && validate.errors) {
    for (const err of validate.errors) {
      const path = err.instancePath || "/";
      errors.push(`${path}: ${err.message ?? "unknown schema error"}`);
    }
  }

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

    // IDs must not contain dots (the CLI auto-prefixes with identifier.)
    if (id.includes(".")) {
      errors.push(`Component id '${id}' must not contain dots`);
    }

    // Unique check
    if (componentIds.has(id)) {
      errors.push(`Duplicate component id: '${id}'`);
    }
    componentIds.add(id);

    // hookEvent validation
    const hookEvent = comp.hookEvent as string | undefined;
    if (hookEvent && !VALID_HOOK_EVENTS.has(hookEvent)) {
      errors.push(
        `Component '${id}': invalid hookEvent '${hookEvent}'. Valid values: ${[...VALID_HOOK_EVENTS].join(", ")}`
      );
    }

    // hookTimeout/hookAsync/hookStatusMessage require hookEvent
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

    // hookTimeout must be positive
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

  const keywords = extractKeywords(identifier, description, counts);

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
    if (comp[key] !== undefined) return type;
  }

  // Check explicit type field
  if (typeof comp.type === "string") return comp.type;

  // Check shell shorthand (requires explicit type)
  if (comp.shell !== undefined && typeof comp.type === "string") return comp.type;

  return null;
}

function extractKeywords(
  identifier: string,
  description: string,
  counts: ComponentCounts
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

  // Add component type names as keywords
  if (counts.mcpServers > 0) words.add("mcp");
  if (counts.hooks > 0) words.add("hooks");
  if (counts.skills > 0) words.add("skills");
  if (counts.commands > 0) words.add("commands");
  if (counts.agents > 0) words.add("agents");
  if (counts.brewPackages > 0) words.add("brew");
  if (counts.plugins > 0) words.add("plugins");
  if (counts.templates > 0) words.add("templates");

  return [...words];
}
