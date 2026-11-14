import { fusionIdentity, modelIdentity } from "../src/cli/modelId";

const ROW_ORDER = ["Input", "Output", "Cache Read", "Cache Write"];

export function estimatedOriginalPrice(value, promotion) {
  const discountMatch = /^(\d+(?:\.\d+)?)\s*%\s+off$/i.exec(String(promotion || "").trim());
  const priceMatch = /^\$(\d+(?:\.\d+)?)$/.exec(String(value || "").trim());
  if (!discountMatch || !priceMatch) return "";
  const [priceWhole, priceDecimals = ""] = priceMatch[1].split(".");
  const [discountWhole, discountDecimals = ""] = discountMatch[1].split(".");
  const priceScale = 10n ** BigInt(priceDecimals.length);
  const discountScale = 10n ** BigInt(discountDecimals.length);
  const current = BigInt(priceWhole + priceDecimals);
  const discount = BigInt(discountWhole + discountDecimals);
  if (current <= 0n || discount <= 0n || discount >= 100n * discountScale) return "";
  // Decimal integers keep an exact tenth from rounding up because of floating point noise.
  const denominator = priceScale * (100n * discountScale - discount);
  const numerator = current * discountScale * 1000n;
  const tenths = (numerator + denominator - 1n) / denominator;
  if (tenths >= 10n ** 22n) return "";
  const fraction = tenths % 10n;
  return `$${tenths / 10n}${fraction ? `.${fraction}` : ""}`;
}

export function pickerPromotionEndDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
}

export function pickerTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  const thousands = Math.round(count / 1000);
  const label = thousands >= 1000
    ? `${Math.round(count / 100000) / 10}M`
    : thousands > 0 ? `${thousands}K` : `${count}`;
  return `${label} tokens`;
}

function costRows(summary, sub = false) {
  return String(summary || "").split("\u00b7").map((part) => {
    const match = /^(.+?)\s*\/\s*(?:MTok|1M)\s+(Sidekick )?(In|Input|Out|Output|Cache Read|Cached input|Cache Write)$/i.exec(part.trim());
    if (!match || !!match[2] !== sub) return null;
    const labels = {
      in: "Input", input: "Input", out: "Output", output: "Output",
      "cache read": "Cache Read", "cached input": "Cache Read", "cache write": "Cache Write"
    };
    return { label: labels[match[3].toLowerCase()], value: match[1].trim() };
  }).filter(Boolean).sort((a, b) => ROW_ORDER.indexOf(a.label) - ROW_ORDER.indexOf(b.label));
}

function rates(record, sub = false) {
  return {
    defaultRows: costRows(record?.costSummary, sub),
    longRows: costRows(record?.longContextCostSummary, sub)
  };
}

function hasRates(record, sub) {
  const value = rates(record, sub);
  return value.defaultRows.length || value.longRows.length;
}

function modelMetadata(family, effort, speed) {
  const variants = family?.variants || [];
  const matches = (variant, wantedSpeed) => {
    const identity = modelIdentity(variant.value);
    return (!identity.effort || identity.effort === effort) && identity.speed === wantedSpeed;
  };
  const exact = variants.find((variant) => matches(variant, speed));
  const standard = variants.find((variant) => matches(variant, "standard"));
  const base = variants.find((variant) => variant.value === family.default);
  const sources = [exact, standard, base].filter(Boolean);
  const tierSource = sources.find((variant) => variant.costTier);
  const contextRows = [
    ["Max context", "maxContextTokens"],
    ["Max output", "maxOutputTokens"]
  ].map(([label, key]) => {
    const source = sources.find((variant) => Number(variant[key]) > 0);
    return [label, pickerTokenCount(source?.[key])];
  }).filter(([, value]) => value);
  // An exact Fast variant without its own promotion never inherits the
  // standard variant's offer or expiry. Standard or base metadata only
  // supplies them when no exact variant exists.
  const promotionSource = exact || standard || base;
  const promotion = String(promotionSource?.promotion || "").trim();
  const promotionEndDate = promotion && typeof promotionSource?.promotionEndDate === "string"
    ? promotionSource.promotionEndDate.trim()
    : "";
  return {
    exact,
    promotion,
    promotionEndDate,
    costTier: tierSource?.costTier || "",
    tierTitle: speed === "fast" && !exact?.costTier
      ? "Model cost tier. Fast rates are shown below when provided by the catalog."
      : tierSource?.costTier || "",
    contextRows
  };
}

export function singleModelPricing(family, effort, speed) {
  const metadata = modelMetadata(family, effort, speed);
  return {
    promotion: metadata.promotion,
    promotionEndDate: metadata.promotionEndDate,
    costTier: metadata.costTier,
    tierTitle: metadata.tierTitle,
    contextRows: metadata.contextRows,
    ...rates(metadata.exact)
  };
}

function commonRateSource(records, sub) {
  const available = records.filter((record) => hasRates(record, sub));
  if (!available.length) return undefined;
  const signature = JSON.stringify(rates(available[0], sub));
  return available.every((record) => JSON.stringify(rates(record, sub)) === signature)
    ? available[0]
    : undefined;
}

// ACP controls Lead speed separately from the representative pair UID.
// A role's rates therefore match that role's own effort and speed. Prefer
// its exact pair, and only share rates across other pairings when all
// matching catalog records agree. Never substitute standard rates for Fast.
export function fusionRolePricing(families, pairs, selection, role) {
  const sub = role === "sub";
  const id = sub ? selection.subModel : selection.lead;
  const effort = sub ? selection.subEffort : selection.effort;
  const speed = sub ? selection.subSpeed : selection.speed;
  const family = families.find((candidate) =>
    candidate.id !== "fusion" && candidate.variants.some((variant) => modelIdentity(variant.value).id === id)
  );
  const metadata = modelMetadata(family, effort, speed);
  const matching = pairs.filter((pair) => {
    const identity = fusionIdentity(pair.value);
    return sub
      ? identity.subModel === id && identity.subEffort === effort && identity.subSpeed === speed
      : identity.lead === id && identity.effort === effort && identity.speed === speed;
  });
  const samePair = matching.filter((pair) => {
    const identity = fusionIdentity(pair.value);
    return identity.lead === selection.lead && identity.subModel === selection.subModel
      && identity.effort === selection.effort && identity.subEffort === selection.subEffort;
  });
  const exact = samePair.find((pair) => {
    const identity = fusionIdentity(pair.value);
    return identity.speed === selection.speed && identity.subSpeed === selection.subSpeed && hasRates(pair, sub);
  });
  const source = exact || commonRateSource(samePair, sub) || commonRateSource(matching, sub);
  return {
    promotion: metadata.promotion,
    promotionEndDate: metadata.promotionEndDate,
    costTier: metadata.costTier,
    tierTitle: metadata.tierTitle,
    contextRows: metadata.contextRows,
    ...rates(source, sub)
  };
}
