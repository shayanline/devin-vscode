const levels = ["low", "high", "max"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) }));
const speeds = [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }];
const leads = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", fast: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", fast: false }
];
const subs = [
  { id: "swe-2-medium", name: "SWE-2 Medium" },
  { id: "swe-2-high", name: "SWE-2 High" },
  { id: "swe-2-flash-max", name: "SWE-2 Flash Max" },
  { id: "gpt-6-luna-high", name: "GPT-6 Luna High" },
  { id: "gpt-6-luna-high-priority", name: "GPT-6 Luna High Fast" }
];
const fusionVariants = leads.flatMap((lead) => subs.flatMap((sub) => {
  if (!lead.fast && (sub.id.includes("flash") || sub.id.endsWith("priority"))) return [];
  return levels.flatMap((level) => (lead.fast ? ["", "-fast"] : [""]).map((speed) => ({
    value: `fusion-${lead.id}-${level.value}${speed}-sidekick-${sub.id}`,
    name: `Fusion (${lead.name} ${level.name}${speed ? " Fast" : ""} + ${sub.name})`,
    maxContextTokens: 1000000
  })));
}));
const models = [
  {
    id: "fusion", name: "Fusion",
    default: "fusion-claude-opus-5-5-high-sidekick-swe-2-medium",
    variants: fusionVariants
  },
  ...leads.map((lead) => ({
    id: lead.id, name: lead.name, default: `${lead.id}-high`,
    variants: levels.flatMap((level) => (lead.fast ? ["", "-fast"] : [""]).map((speed) => ({
      value: `${lead.id}-${level.value}${speed}`,
      name: `${level.name}${speed ? " Fast" : ""}`,
      maxContextTokens: 1000000
    })))
  })),
  { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }, { value: "swe-2-high", name: "High" }] },
  { id: "swe-2-flash", name: "SWE-2 Flash", default: "swe-2-flash-max", variants: [{ value: "swe-2-flash-max", name: "Max" }] },
  { id: "gpt-6-luna", name: "GPT-6 Luna", default: "gpt-6-luna-high", variants: [{ value: "gpt-6-luna-high", name: "High" }, { value: "gpt-6-luna-high-priority", name: "High Fast" }] }
];
function options(overrides = {}) {
  return {
    type: "options", currentMode: "accept-edits",
    modes: [{ value: "accept-edits", name: "Code", icon: "codicon-code" }, { value: "ask", name: "Ask", icon: "codicon-comment-discussion" }],
    models,
    currentModel: models[0].default, currentThoughtLevel: "max", thoughtLevels: levels,
    currentSpeed: "standard", speedOptions: speeds,
    modelChoices: { fusion: fusionVariants.filter((v) => /-high-sidekick-/.test(v.value)) },
    ...overrides
  };
}

module.exports = { models, levels, speeds, options };
