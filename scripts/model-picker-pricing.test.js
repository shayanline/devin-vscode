const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../webview/modelPickerPricing.js")],
  bundle: true, write: false, platform: "node", format: "cjs"
}).outputFiles[0].text;
const pricingModule = { exports: {} };
new Function("module", "exports", bundle)(pricingModule, pricingModule.exports);
const {
  estimatedOriginalPrice, pickerPromotionEndDate, pickerTokenCount, singleModelPricing, fusionRolePricing
} = pricingModule.exports;

test("original price estimates round upward to at most one decimal", () => {
  for (const [current, promotion, original] of [
    ["$0.5", "83% off", "$3"],
    ["$3", "83% off", "$17.7"],
    ["$0.05", "83% off", "$0.3"],
    ["$0.75", "25% off", "$1"],
    ["$0.08", "25% off", "$0.2"],
    ["$2", "83.5% off", "$12.2"],
    ["$1.00", " 20 % OFF ", "$1.3"],
    ["$2.619", "10% off", "$3"],
    ["$2.601", "10% off", "$2.9"],
    ["$2.1", "25% off", "$2.8"],
    ["$9.075", "25% off", "$12.1"]
  ]) {
    assert.equal(estimatedOriginalPrice(current, promotion), original, `${current} with ${promotion}`);
  }
});

test("price estimates stay absent when the label or USD rate cannot be reversed reliably", () => {
  for (const promotion of [
    "", null, undefined, "PROMO", "Half off", "Up to 83% off", "83% off selected tokens",
    "25% to 83% off", "-25% off", "0% off", "100% off", "101% off"
  ]) assert.equal(estimatedOriginalPrice("$1", promotion), "", String(promotion));
  for (const current of [
    "", null, undefined, "$0", "$-1", "Free", "Not provided", "EUR 1", "$1 to $2", "$NaN",
    "$1e3", `$${"9".repeat(310)}`, "$1000000000000000000000"
  ]) assert.equal(estimatedOriginalPrice(current, "83% off"), "", String(current));
});

test("upward rounding preserves positive low rates without trailing zeroes", () => {
  assert.equal(estimatedOriginalPrice("$0.03", "25% off"), "$0.1");
  assert.equal(estimatedOriginalPrice("$0.1", "25% off"), "$0.2");
  assert.equal(estimatedOriginalPrice("$1", "1% off"), "$1.1");
});

test("promotion dates accept the catalogue's nanosecond timestamp and always use UTC", () => {
  assert.equal(pickerPromotionEndDate("2027-01-01T07:59:59.999999999Z"), "1 Jan 2027");
  assert.equal(pickerPromotionEndDate("2026-11-18T18:00:00Z"), "18 Nov 2026");
  assert.equal(pickerPromotionEndDate("2027-01-01T00:30:00+01:00"), "31 Dec 2026");
  for (const value of [
    "", null, undefined, 0, "not a date", "2027-01-01", "2027-01-01T00:30:00", "2027-13-01T00:00:00Z"
  ]) assert.equal(pickerPromotionEndDate(value), "", String(value));
});

const lead = {
  id: "claude-opus-5-5", default: "claude-opus-5-5-high",
  variants: [{
    value: "claude-opus-5-5-high", costTier: "High cost",
    maxContextTokens: 1000000, maxOutputTokens: 128000
  }]
};
const sub = {
  id: "gpt-5-6-sol", default: "gpt-5-6-sol-high",
  variants: [{
    value: "gpt-5-6-sol-high", costTier: "High cost",
    maxContextTokens: 1000000, maxOutputTokens: 128000,
    costSummary: "$4/MTok In \u00b7 $0.4/MTok Cache Read \u00b7 $20/MTok Out"
  }]
};
const standardPair = {
  value: "fusion-claude-opus-5-5-high-sidekick-gpt-5-6-sol-high",
  costSummary: "$4/MTok In \u00b7 $20/MTok Out \u00b7 $0.2/MTok Cache Read \u00b7 $4/MTok Sidekick In \u00b7 $20/MTok Sidekick Out \u00b7 $0.4/MTok Sidekick Cache Read"
};
const fastPair = {
  value: "fusion-claude-opus-5-5-high-fast-sidekick-gpt-5-6-sol-high-priority",
  costSummary: "$8/MTok In \u00b7 $40/MTok Out \u00b7 $0.4/MTok Cache Read \u00b7 $8/MTok Sidekick In \u00b7 $40/MTok Sidekick Out \u00b7 $0.8/MTok Sidekick Cache Read"
};
const selection = {
  lead: "claude-opus-5-5", effort: "high", speed: "standard",
  subModel: "gpt-5-6-sol", subEffort: "high", subSpeed: "standard"
};

test("Fusion Sub Fast keeps its model cost badge without a standalone Fast variant", () => {
  const value = fusionRolePricing([lead, sub], [standardPair, fastPair], { ...selection, subSpeed: "fast" }, "sub");
  assert.equal(value.costTier, "High cost");
  assert.match(value.tierTitle, /Model cost tier/);
  assert.deepEqual(value.defaultRows, [
    { label: "Input", value: "$8" }, { label: "Output", value: "$40" }, { label: "Cache Read", value: "$0.8" }
  ]);
  assert.deepEqual(value.contextRows, [["Max context", "1M tokens"], ["Max output", "128K tokens"]]);
});

test("Fusion role rates follow each role's speed independently of the representative pair", () => {
  const pairs = [standardPair, fastPair];
  const leadFast = { ...selection, speed: "fast" };
  assert.equal(fusionRolePricing([lead, sub], pairs, leadFast, "lead").defaultRows[0].value, "$8");
  assert.equal(fusionRolePricing([lead, sub], pairs, leadFast, "sub").defaultRows[0].value, "$4");
  const subFast = { ...selection, subSpeed: "fast" };
  assert.equal(fusionRolePricing([lead, sub], pairs, subFast, "lead").defaultRows[0].value, "$4");
  assert.equal(fusionRolePricing([lead, sub], pairs, subFast, "sub").defaultRows[0].value, "$8");
});

test("an explicit Fast tier and long context rates take precedence over base metadata", () => {
  const family = {
    ...sub,
    variants: [...sub.variants, {
      value: "gpt-5-6-sol-high-priority", costTier: "Very high cost",
      costSummary: "$8/MTok In \u00b7 $40/MTok Out",
      longContextCostSummary: "$12/MTok In \u00b7 $60/MTok Out"
    }]
  };
  const value = singleModelPricing(family, "high", "fast");
  assert.equal(value.costTier, "Very high cost");
  assert.equal(value.tierTitle, "Very high cost");
  assert.equal(value.longRows[0].value, "$12");
  assert.deepEqual(value.contextRows, [["Max context", "1M tokens"], ["Max output", "128K tokens"]]);
});

test("missing Fast rate metadata never substitutes the standard price", () => {
  const value = singleModelPricing(sub, "high", "fast");
  assert.equal(value.costTier, "High cost");
  assert.deepEqual(value.defaultRows, []);
  assert.deepEqual(value.longRows, []);
  assert.deepEqual(fusionRolePricing([lead, sub], [standardPair], { ...selection, subSpeed: "fast" }, "sub").defaultRows, []);
});

test("conflicting cross pair rates stay unknown, while an exact pair remains authoritative", () => {
  const other = {
    value: "fusion-other-high-fast-sidekick-gpt-5-6-sol-high-priority",
    costSummary: "$9/MTok Sidekick In \u00b7 $45/MTok Sidekick Out"
  };
  const noExactPair = { ...selection, lead: "missing-lead", subSpeed: "fast" };
  assert.deepEqual(fusionRolePricing([lead, sub], [fastPair, other], noExactPair, "sub").defaultRows, []);
  const exactPair = { ...selection, speed: "fast", subSpeed: "fast" };
  assert.equal(fusionRolePricing([lead, sub], [fastPair, other], exactPair, "sub").defaultRows[0].value, "$8");
});

test("each role shows its own limits and an unknown component has no invented limits", () => {
  const swe = {
    id: "swe-2", default: "swe-2-medium",
    variants: [{ value: "swe-2-medium", maxContextTokens: 262000, maxOutputTokens: 128000 }]
  };
  const value = fusionRolePricing([lead, swe], [], { ...selection, subModel: "swe-2", subEffort: "medium" }, "sub");
  assert.deepEqual(value.contextRows, [["Max context", "262K tokens"], ["Max output", "128K tokens"]]);
  assert.deepEqual(fusionRolePricing([lead], [], selection, "sub").contextRows, []);
});

test("a promotional standard variant supplies the offer only when no exact Fast variant exists", () => {
  const promoSub = { ...sub, variants: [{ ...sub.variants[0], promotion: "20% off" }] };
  assert.equal(singleModelPricing(promoSub, "high", "fast").promotion, "20% off", "a missing Fast variant falls back to the standard offer");
  const withFast = { ...promoSub, variants: [...promoSub.variants, { value: "gpt-5-6-sol-high-priority", costTier: "Very high cost" }] };
  assert.equal(singleModelPricing(withFast, "high", "fast").promotion, "", "an explicit Fast variant never inherits the standard offer");
  const fastPromo = { ...promoSub, variants: [...promoSub.variants, { value: "gpt-5-6-sol-high-priority", promotion: "Half off" }] };
  assert.equal(singleModelPricing(fastPromo, "high", "fast").promotion, "Half off");
  assert.equal(singleModelPricing(fastPromo, "high", "standard").promotion, "20% off");
});

test("each Fusion role exposes only its own model's promotion, never the pair's", () => {
  const promoSub = {
    id: "swe-2", default: "swe-2-medium",
    variants: [{ value: "swe-2-medium", costTier: "Medium cost", promotion: "Launch offer" }]
  };
  const promoPair = { ...standardPair, promotion: "PROMO" };
  const sel = { ...selection, subModel: "swe-2", subEffort: "medium" };
  assert.equal(fusionRolePricing([lead, promoSub], [promoPair], sel, "sub").promotion, "Launch offer");
  assert.equal(fusionRolePricing([lead, promoSub], [promoPair], sel, "lead").promotion, "");
});

test("the promotion end date follows the same variant source as the offer", () => {
  const endDate = "2027-01-01T07:59:59.999999999Z";
  const dated = {
    ...sub,
    variants: [{ ...sub.variants[0], promotion: "20% off", promotionEndDate: `  ${endDate}  ` }]
  };
  const standard = singleModelPricing(dated, "high", "standard");
  assert.equal(standard.promotion, "20% off");
  assert.equal(standard.promotionEndDate, endDate, "the date is trimmed with the offer source");
  const noFast = singleModelPricing(dated, "high", "fast");
  assert.equal(noFast.promotion, "20% off", "a missing Fast variant still falls back to the standard offer");
  assert.equal(noFast.promotionEndDate, endDate);
  const withFast = {
    ...dated,
    variants: [...dated.variants, { value: "gpt-5-6-sol-high-priority", costTier: "Very high cost" }]
  };
  const fast = singleModelPricing(withFast, "high", "fast");
  assert.equal(fast.promotion, "", "an explicit Fast variant never inherits the standard offer");
  assert.equal(fast.promotionEndDate, "", "nor its expiry");
  const datedFast = {
    ...withFast,
    variants: withFast.variants.map((v) => v.value === "gpt-5-6-sol-high-priority"
      ? { ...v, promotion: "10% off", promotionEndDate: "2026-12-01T00:00:00Z" } : v)
  };
  const ownFast = singleModelPricing(datedFast, "high", "fast");
  assert.equal(ownFast.promotion, "10% off");
  assert.equal(ownFast.promotionEndDate, "2026-12-01T00:00:00Z", "a Fast variant's own offer wins");
});

test("an end date without a nonblank promotion stays hidden", () => {
  for (const promotion of ["", "   ", null, undefined]) {
    const family = {
      ...sub,
      variants: [{ ...sub.variants[0], promotion, promotionEndDate: "2027-01-01T07:59:59Z" }]
    };
    const value = singleModelPricing(family, "high", "standard");
    assert.equal(value.promotionEndDate, "", JSON.stringify(promotion));
  }
});

test("each Fusion role exposes only its own model's promotion end date", () => {
  const datedSub = {
    id: "swe-2", default: "swe-2-medium",
    variants: [{
      value: "swe-2-medium", costTier: "Medium cost",
      promotion: "83% off", promotionEndDate: "2027-01-01T07:59:59.999999999Z"
    }]
  };
  const datedPair = { ...standardPair, promotion: "PROMO", promotionEndDate: "2030-01-01T00:00:00Z" };
  const sel = { ...selection, subModel: "swe-2", subEffort: "medium" };
  const subValue = fusionRolePricing([lead, datedSub], [datedPair], sel, "sub");
  assert.equal(subValue.promotion, "83% off");
  assert.equal(subValue.promotionEndDate, "2027-01-01T07:59:59.999999999Z", "the Sub keeps its own offer expiry");
  const leadValue = fusionRolePricing([lead, datedSub], [datedPair], sel, "lead");
  assert.equal(leadValue.promotion, "");
  assert.equal(leadValue.promotionEndDate, "", "neither the Lead nor the pair leaks an expiry");
});

test("token limits round binary counts without displaying long raw numbers", () => {
  for (const [count, text] of [
    [262144, "262K tokens"], [131072, "131K tokens"], [128000, "128K tokens"],
    [1000000, "1M tokens"], [1500000, "1.5M tokens"], [999999, "1M tokens"], [400, "400 tokens"]
  ]) assert.equal(pickerTokenCount(count), text);
  for (const value of [0, -1, null, undefined, NaN, ""]) assert.equal(pickerTokenCount(value), "");
});
