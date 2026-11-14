export const EFFORT_NAMES: Record<string, string> = {
  none: "No Thinking", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max"
};
export const EFFORT_ORDER = Object.keys(EFFORT_NAMES);

export function modelIdentity(uid: string): { id: string; effort: string; speed: string } {
  const speed = /-(fast|priority)$/.test(uid) ? "fast" : "standard";
  const base = uid.replace(/-(fast|priority)$/, "");
  const effort = /-(none|low|medium|high|xhigh|max)$/.exec(base)?.[1] || "";
  return { id: effort ? base.slice(0, -effort.length - 1) : base, effort, speed };
}

export function fusionIdentity(uid: string): {
  lead: string; effort: string; speed: string;
  sidekick: string; subModel: string; subEffort: string; subSpeed: string;
} {
  const [leadUid = "", sidekick = ""] = uid.replace(/^fusion-/, "").split("-sidekick-");
  const lead = modelIdentity(leadUid);
  const sub = modelIdentity(sidekick);
  return {
    lead: lead.id, effort: lead.effort, speed: lead.speed,
    sidekick, subModel: sub.id, subEffort: sub.effort, subSpeed: sub.speed
  };
}

// The pair identity ACP uses to accept a Fusion model: Lead effort and speed
// normalize away, while the complete Sub uid is preserved verbatim, including
// its own effort and Fast suffix.
export function fusionModelKey(uid: string): string | undefined {
  if (!uid.startsWith("fusion-")) return undefined;
  const { lead, sidekick } = fusionIdentity(uid);
  return `${lead}+${sidekick}`;
}
