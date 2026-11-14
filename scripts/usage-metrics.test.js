const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/acp/usage.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error"
});
const compiled = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(compiled, compiled.exports);
const { contextReportFromUpdate, mergeContextReports, sessionAcuUsage, accountAcuUsage, acuText } = compiled.exports;

const context = { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144 };
const dimension = (uid, value, type = "cumulativeMetric") => ({ uid, kind: { type, value } });
const request = (requestId, value) => ({ requestId, responseDimensions: [dimension("acu", value)] });

test("usage metrics accept individual ACP context reports and scope the Fusion sidekick", () => {
  const sub = contextReportFromUpdate({ _meta: {
    "cognition.ai/contextUsage": context,
    "cognition.ai/subagent_context": { parentAgentId: "sidekick" }
  } });
  const lead = contextReportFromUpdate({ _meta: { "cognition.ai/contextUsage": context } });
  assert.deepEqual(sub, { ...context, role: "sub" });
  assert.deepEqual(lead, { ...context, role: "lead" });
  assert.equal(mergeContextReports([sub], [lead]).length, 2, "equal model IDs retain their separate role windows");
  assert.deepEqual(mergeContextReports([sub], [{ ...sub, totalTokens: 0 }]), [{ ...context, role: "sub", totalTokens: 0 }]);
  assert.deepEqual(contextReportFromUpdate({ _meta: { "cognition.ai/contextUsage": [context] } }), [context]);
  assert.equal(contextReportFromUpdate({ _meta: {
    "cognition.ai/contextUsage": context,
    "cognition.ai/subagent_context": { parentAgentId: "unrelated-worker" }
  } }), undefined);
});

test("usage metrics distinguish empty snapshots from missing or unrelated context reports", () => {
  const meta = { "cognition.ai/contextUsage": [] };
  assert.deepEqual(contextReportFromUpdate({ _meta: meta }), []);
  assert.equal(contextReportFromUpdate({}), undefined);
  assert.equal(contextReportFromUpdate({ _meta: {
    ...meta, "cognition.ai/subagent_context": { parentAgentId: "unrelated-worker" }
  } }), undefined);
  assert.deepEqual(contextReportFromUpdate({ _meta: { "cognition.ai/contextUsage": context } }), { ...context, role: "lead" });
});

test("session ACUs sum reported request dimensions once and include both Fusion roles", () => {
  const first = request("lead-request", 1.25);
  const latest = request("lead-request", 1.5);
  const sub = request("sub-request", 0.5);
  sub.responseDimensions.push(dimension("tokenCostUsd", 400), dimension("input_tokens", 50000));
  assert.equal(sessionAcuUsage({ requests: [first, sub, latest] }), 2);
  assert.equal(sessionAcuUsage({ requests: [latest, sub] }), 2, "repeated snapshots do not accumulate a second time");
  assert.equal(sessionAcuUsage({ requests: [request("free", 0)] }), 0);
  assert.equal(sessionAcuUsage({ requests: [] }), 0);
});

test("missing or malformed billing dimensions do not become zero or partial ACU totals", () => {
  assert.equal(sessionAcuUsage(undefined), undefined);
  assert.equal(sessionAcuUsage({ requests: [{ responseDimensions: [] }] }), undefined);
  assert.equal(sessionAcuUsage({ requests: [{ requestId: "credits", responseDimensions: [dimension("credit", 3)] }] }), undefined);
  for (const value of [-1, NaN, Infinity, "4"]) {
    assert.equal(sessionAcuUsage({ requests: [request("valid", 2), request("invalid", value)] }), undefined);
  }
  assert.equal(sessionAcuUsage({ requests: [{ requestId: "wrong-kind", responseDimensions: [dimension("acu", 2, "metric")] }] }), undefined);
  assert.equal(sessionAcuUsage({ requests: [{ requestId: "duplicate-dimension", responseDimensions: [dimension("acu", 1), dimension("acu", 2)] }] }), undefined);
});

test("account remaining ACUs use the unrounded reported amount and expose overage", () => {
  assert.deepEqual(accountAcuUsage(139.5, 3000), { used: 139.5, limit: 3000, remaining: 2860.5, overage: 0 });
  assert.equal(accountAcuUsage(0.004, 1000).remaining, 999.996);
  assert.equal(accountAcuUsage(3000.25, 3000).remaining, 0);
  assert.equal(accountAcuUsage(3000.25, 3000).overage, 0.25);
  assert.deepEqual(accountAcuUsage(0, 0), { used: 0, limit: 0, remaining: 0, overage: 0 });
  assert.deepEqual(accountAcuUsage(2), { used: 2 });
  assert.equal(accountAcuUsage(-1, 3000), undefined);
  assert.equal(accountAcuUsage(NaN, 3000), undefined);
});

test("ACU displays distinguish missing data and small billable amounts from zero", () => {
  assert.equal(acuText(0), "0.0000");
  assert.equal(acuText(1.9281), "1.9281");
  assert.equal(acuText(139.5, 2), "139.50");
  assert.equal(acuText(0.00001), "<0.0001");
  assert.equal(acuText(undefined), "Not reported");
});
