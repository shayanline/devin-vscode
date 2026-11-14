import { fusionIdentity, modelIdentity } from "../src/cli/modelId";
import { contextReports, isUsageAmount, mergeContextReports } from "../src/acp/usage";

function validWindow(used, size) {
  return Number.isFinite(used) && used >= 0 && Number.isFinite(size) && size > 0;
}

export function contextPercent(used, size) {
  return validWindow(used, size) ? Math.round((used / size) * 100) : null;
}

export function normalizeContextUsage(message, previous, modelUid) {
  const contextModel = typeof message.contextModel === "string" ? message.contextModel : modelUid;
  const matching = previous?.contextModel === contextModel ? previous : null;
  const retained = matching?.contexts || [];
  // An aggregate update is not a replacement for the last structured report.
  let contexts = retained;
  if (Array.isArray(message.contexts)) {
    contexts = contextReports(message.contexts);
  } else if (message.contexts && typeof message.contexts === "object") {
    contexts = mergeContextReports(retained, contextReports(message.contexts));
  }
  const incoming = validWindow(message.used, message.size);
  const clear = Array.isArray(message.contexts) && !contexts.length;
  let used = incoming ? message.used : clear ? undefined : matching?.used;
  let size = incoming ? message.size : clear ? undefined : matching?.size;
  if (contexts.length) {
    const fullest = contexts.reduce((a, b) =>
      a.totalTokens / a.maxTokens >= b.totalTokens / b.maxTokens ? a : b
    );
    used = fullest.totalTokens;
    size = fullest.maxTokens;
  }
  const sessionAcus = Object.prototype.hasOwnProperty.call(message, "sessionAcus")
    ? isUsageAmount(message.sessionAcus) ? message.sessionAcus : null
    : previous?.sessionAcus ?? null;
  if (!validWindow(used, size) && sessionAcus === null) return null;
  return { used, size, cost: message.cost, contexts, contextModel, sessionAcus };
}

export function fusionUsageRoles(usage, modelUid) {
  if (!modelUid.startsWith("fusion-")) return null;
  const [leadUid = "", subUid = ""] = modelUid.slice("fusion-".length).split("-sidekick-");
  const identity = fusionIdentity(modelUid);
  const contexts = usage?.contextModel && usage.contextModel !== modelUid ? [] : usage?.contexts || [];
  function resolve(role, uid, otherUid, id, otherId) {
    const scoped = contexts.filter((context) => context.role === role
      && modelIdentity(context.modelId).id === id);
    if (scoped.length === 1) return scoped[0];
    if (uid === otherUid) return null;
    const unscoped = contexts.filter((context) => !context.role);
    const exact = unscoped.filter((context) => context.modelId === uid);
    if (exact.length === 1) return exact[0];
    // A family shared by both roles needs distinct variant ids from ACP.
    if (id === otherId) return null;
    const matching = unscoped.filter((context) => modelIdentity(context.modelId).id === id);
    return matching.length === 1 ? matching[0] : null;
  }
  return [
    {
      role: "lead", letter: "L", uid: leadUid,
      context: resolve("lead", leadUid, subUid, identity.lead, identity.subModel)
    },
    {
      role: "sub", letter: "S", uid: subUid,
      context: resolve("sub", subUid, leadUid, identity.subModel, identity.lead)
    }
  ];
}
