import { execFile } from "child_process";

export interface ModelChoice {
  value: string;
  name: string;
}

interface ModelsJson {
  families?: {
    family_label?: string;
    variants?: { model_uid?: string; label?: string }[];
  }[];
}

let cache: { at: number; models: ModelChoice[] } | undefined;

// Lists the account's available models via `devin models list --format json`.
// This needs no ACP session, so the model picker can be populated before any
// session exists. The returned `value`s are the same model uids the ACP
// `model` config option accepts. Cached in-memory for a few minutes.
export async function listModels(cliPath: string, env?: NodeJS.ProcessEnv): Promise<ModelChoice[]> {
  if (cache && Date.now() - cache.at < 300000) {
    return cache.models;
  }
  const models = await run(cliPath, env);
  if (models.length) {
    cache = { at: Date.now(), models };
  }
  return models;
}

function run(cliPath: string, env?: NodeJS.ProcessEnv): Promise<ModelChoice[]> {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ["models", "list", "--format", "json"],
      { env, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as ModelsJson;
          const out: ModelChoice[] = [];
          for (const fam of parsed.families || []) {
            for (const v of fam.variants || []) {
              if (v.model_uid) {
                out.push({ value: v.model_uid, name: v.label || v.model_uid });
              }
            }
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      }
    );
  });
}
