import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { accountAcuUsage, AccountAcuUsage } from "../acp/usage";

const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

export interface AccountUsageSnapshot {
  usage?: AccountAcuUsage;
  fetchedAt: number;
  account?: { id?: string; teamId?: string; name?: string; email?: string };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseAccountUsage(value: unknown, fetchedAt = Date.now()): AccountUsageSnapshot {
  const root = record(value);
  const status = record(root?.userStatus) || record(root?.user_status) || root;
  const plan = record(status?.planStatus) || record(status?.plan_status);
  return {
    usage: accountAcuUsage(plan?.acuConsumed ?? plan?.acu_consumed, plan?.acuLimit ?? plan?.acu_limit),
    fetchedAt,
    account: status ? {
      id: text(status.userId ?? status.user_id),
      teamId: text(status.teamId ?? status.team_id),
      name: text(status.name),
      email: text(status.email)
    } : undefined
  };
}

function credentialField(raw: string, key: string): string | undefined {
  const root = raw.split(/^\s*\[/m, 1)[0];
  const match = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, "m").exec(root);
  if (!match) return undefined;
  return text(match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]));
}

async function usageAuth(env: NodeJS.ProcessEnv): Promise<{ key: string; server: string } | undefined> {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dir = process.platform === "win32" && env.APPDATA
    ? path.join(env.APPDATA, "devin")
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "devin");
  let stored = "";
  try {
    stored = await fs.readFile(path.join(dir, "credentials.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read the Devin account credentials.");
  }
  // ACP uses WINDSURF_API_KEY or the stored CLI credential. DEVIN_API_KEY
  // belongs to the Cloud API and cannot authenticate this account endpoint.
  const key = text(env.WINDSURF_API_KEY) || credentialField(stored, "windsurf_api_key");
  if (!key) return undefined;
  const server = text(env.WINDSURF_API_SERVER_URL) || text(env.DEVIN_API_SERVER_URL)
    || credentialField(stored, "api_server_url") || "https://server.codeium.com";
  const url = new URL(server);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("The Devin account usage server URL is not safe.");
  }
  return { key, server: server.replace(/\/+$/, "") };
}

// The raw GetUserStatus transport shared by the usage projection and the
// model catalogue read. HTTP and parser errors can carry credentials, so
// failures surface as one safe fixed message.
export async function fetchAccountStatus(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<unknown> {
  try {
    const auth = await usageAuth(env);
    if (!auth) return undefined;
    const response = await fetcher(auth.server + STATUS_PATH, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${auth.key}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1"
      },
      body: JSON.stringify({
        // Match the CLI metadata because the server uses it to choose the model catalogue.
        metadata: {
          apiKey: auth.key,
          ideName: "chisel",
          ideVersion: "0.0.0-dev",
          extensionName: "chisel",
          extensionVersion: "0.0.0-dev",
          locale: "en"
        }
      })
    });
    if (!response.ok) throw new Error("Account status request failed.");
    const json: unknown = await response.json();
    const current = await usageAuth(env);
    if (current?.key !== auth.key || current?.server !== auth.server) {
      throw new Error("The Devin account changed while refreshing status.");
    }
    return json;
  } catch {
    throw new Error("Could not refresh account status.");
  }
}

export async function fetchAccountUsage(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<AccountUsageSnapshot> {
  try {
    const json = await fetchAccountStatus(env, fetcher);
    if (json === undefined) return { fetchedAt: Date.now() };
    return parseAccountUsage(json);
  } catch {
    // HTTP and parser errors can contain credentials, so expose only a safe message.
    throw new Error("Could not refresh account ACU usage.");
  }
}
