import { execFile } from "child_process";
import { cliCommand } from "./locate";

export interface ModelVariant {
  value: string; // model uid the ACP `model` option accepts
  name: string; // effort label, e.g. "Medium", "High", "No Thinking"
}

export interface ModelFamily {
  id: string; // stable family id (slug/uid)
  name: string; // family label, e.g. "Claude Sonnet 5"
  default: string; // default variant uid (the family's first/base option)
  variants: ModelVariant[];
}

interface ModelsJson {
  families?: {
    family_label?: string;
    family_uid?: string;
    slug?: string;
    variants?: { model_uid?: string; label?: string }[];
  }[];
}

let cache: { at: number; families: ModelFamily[] } | undefined;
// variant uid -> family, so a session's flat currentValue can be resolved.
const familyByValue = new Map<string, ModelFamily>();

// Lists the account's models as families (with effort variants) via
// `devin models list --format json`. Needs no ACP session, and the uids match
// what the ACP `model` config option accepts. Cached in-memory for a few minutes.
export async function listModelFamilies(cliPath: string, env?: NodeJS.ProcessEnv): Promise<ModelFamily[]> {
  if (cache && Date.now() - cache.at < 300000) {
    return cache.families;
  }
  const families = await run(cliPath, env);
  if (families.length) {
    setCache(families);
    return families;
  }
  // The CLI call failed or returned nothing: keep serving the last successful
  // families (even if now stale) so the dropdowns don't empty out on a
  // transient error.
  return cache?.families ?? families;
}

// Families from the last successful fetch, synchronously (may be empty).
export function cachedFamilies(): ModelFamily[] {
  return cache?.families || [];
}

export function familyOf(value: string): ModelFamily | undefined {
  return familyByValue.get(value);
}

function setCache(families: ModelFamily[]): void {
  cache = { at: Date.now(), families };
  familyByValue.clear();
  for (const fam of families) {
    for (const v of fam.variants) {
      familyByValue.set(v.value, fam);
    }
  }
}

// "Claude Sonnet 5 Medium" + family "Claude Sonnet 5" -> "Medium".
// When the variant label is exactly the family name (the base, no-thinking
// variant), there is nothing left after stripping, so call it "Base".
function effortLabel(familyLabel: string, variantLabel: string): string {
  let e = variantLabel;
  if (familyLabel && variantLabel.toLowerCase().startsWith(familyLabel.toLowerCase())) {
    e = variantLabel.slice(familyLabel.length).trim();
  }
  return e || "Base";
}

// Best-effort ordering of thinking effort, lowest to highest.
function effortRank(name: string): number {
  const s = name.toLowerCase();
  if (/^base$|no\s*thinking|none/.test(s)) return 0;
  if (/x-?high|xhigh|extra/.test(s)) return 4;
  if (/\bmax\b/.test(s)) return 5;
  if (/high/.test(s)) return 3;
  if (/medium|\bmed\b/.test(s)) return 2;
  if (/low/.test(s)) return 1;
  return 2.5; // unknown efforts sit in the middle, keeping their original order
}

function run(cliPath: string, env?: NodeJS.ProcessEnv): Promise<ModelFamily[]> {
  return new Promise((resolve) => {
    const cmd = cliCommand(cliPath, ["models", "list", "--format", "json"]);
    execFile(
      cmd.file,
      cmd.args,
      { env, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, shell: cmd.shell },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as ModelsJson;
          const out: ModelFamily[] = [];
          for (const fam of parsed.families || []) {
            const label = fam.family_label || fam.slug || "";
            const variants: ModelVariant[] = [];
            for (const v of fam.variants || []) {
              if (v.model_uid) {
                variants.push({ value: v.model_uid, name: effortLabel(label, v.label || v.model_uid) });
              }
            }
            if (!variants.length) {
              continue;
            }
            // Sort effort variants low -> high; the lowest becomes the default.
            variants.sort((a, b) => effortRank(a.name) - effortRank(b.name));
            out.push({
              id: fam.slug || fam.family_uid || variants[0].value,
              name: label || variants[0].value,
              default: variants[0].value,
              variants
            });
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      }
    );
  });
}
