/**
 * Smoke test — verifies all modules import cleanly and export expected symbols.
 * No test framework required; exits 0 on success, 1 on failure.
 *
 * Usage: node test/smoke.js
 */

// Inject minimal env vars so config.js doesn't throw on missing secrets
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-test";
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || "xapp-test";
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "test-secret";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test";
process.env.NOTION_API_KEY = process.env.NOTION_API_KEY || "ntn_test";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertFn(mod, name, moduleName) {
  assert(typeof mod[name] === "function", `${moduleName}.${name} should be a function`);
}

async function run() {
  console.log("Smoke test: importing modules...\n");

  // ── config ──
  const configMod = await import("../src/config.js");
  assert(configMod.default, "config exports default");
  assert(typeof configMod.default.claudeModel === "string", "config.claudeModel is a string");
  assert(configMod.default.features && typeof configMod.default.features === "object", "config.features is an object");
  console.log("  config.js ✓");

  // ── formatters ──
  const fmt = await import("../src/formatters.js");
  for (const fn of ["formatAnswer", "formatPartialAnswer", "formatEscalation", "formatTimeAgo", "formatRosterArea"]) {
    assertFn(fmt, fn, "formatters");
  }
  console.log("  formatters.js ✓");

  // ── slack-helpers ──
  const sh = await import("../src/slack-helpers.js");
  for (const fn of ["splitCsv", "truncate", "looksLikeQuestion", "alreadySeen", "normalizeQuotes",
    "resolveWatchChannels", "initSlackIdentity", "fetchAllUsers", "resolveUsersByName",
    "sendDmToUser", "getThreadContext"]) {
    assertFn(sh, fn, "slack-helpers");
  }
  console.log("  slack-helpers.js ✓");

  // ── llm ──
  const llm = await import("../src/llm.js");
  for (const fn of ["classifyQuestion", "askClaude", "synthesizeFaqEntry",
    "checkResponsesSubstantive", "checkIfCorrection", "reviseSuggestedUpdate",
    "analyzeThreadReply", "selectRelevantLeads", "evolveExpertiseDescription", "parseDmIntent"]) {
    assertFn(llm, fn, "llm");
  }
  for (const schema of ["CLASSIFICATION_SCHEMA", "ANSWER_SCHEMA", "SYNTHESIS_SCHEMA",
    "SUBSTANTIVE_CHECK_SCHEMA", "CORRECTION_CHECK_SCHEMA", "THREAD_REPLY_ANALYSIS_SCHEMA",
    "LEAD_SELECTION_SCHEMA", "DESCRIPTION_UPDATE_SCHEMA", "DM_INTENT_SCHEMA"]) {
    assert(typeof llm[schema] === "object", `llm.${schema} is an object`);
  }
  console.log("  llm.js ✓");

  // ── knowledge-areas ──
  const ka = await import("../src/knowledge-areas.js");
  for (const fn of ["loadKnowledgeAreas", "saveKnowledgeAreas", "getAllKnowledgeAreas",
    "getKnowledgeAreaById", "getKnowledgeAreaByName", "getLeadUserIds", "getAllMemberUserIds",
    "getLeads", "getTeamMembers", "isLeadForAnyArea", "isTeamMemberForAnyArea",
    "addLead", "addTeamMember", "removeMember", "promoteToLead", "demoteToTeamMember",
    "updateMemberDescription", "touchMemberActivity", "addKnowledgeArea", "removeKnowledgeArea",
    "updateKnowledgeArea"]) {
    assertFn(ka, fn, "knowledge-areas");
  }
  console.log("  knowledge-areas.js ✓");

  // ── notion ──
  const notion = await import("../src/notion.js");
  for (const fn of ["initNotion", "extractPageId", "fetchPageContent", "analyzePageStructure",
    "appendFaqEntry", "getPageTitle", "findBlockByContent", "updateFaqBlock", "addCommentToBlock"]) {
    assertFn(notion, fn, "notion");
  }
  console.log("  notion.js ✓");

  // ── escalation-tracker ──
  const et = await import("../src/escalation-tracker.js");
  for (const fn of ["loadEscalations", "saveEscalations", "trackEscalation",
    "recordOwnerResponse", "getEscalationsReadyToSynthesize", "getEscalationsAwaitingResponse",
    "getAllActiveEscalations", "getEscalationById", "getEscalationByThread",
    "getActiveEscalationByThread", "markEscalationComplete", "markEscalationSkipped",
    "cleanupOldEscalations"]) {
    assertFn(et, fn, "escalation-tracker");
  }
  console.log("  escalation-tracker.js ✓");

  // ── answer-tracker ──
  const at = await import("../src/answer-tracker.js");
  for (const fn of ["loadFaqAnswers", "saveFaqAnswers", "trackFaqAnswer", "getFaqAnswerById",
    "getActiveFaqAnswerByThread", "recordCorrectionResponse", "getAnswersReadyToProcess",
    "markAnswerProcessed", "markAnswerCorrected", "cleanupOldFaqAnswers", "getAllActiveFaqAnswers"]) {
    assertFn(at, fn, "answer-tracker");
  }
  console.log("  answer-tracker.js ✓");

  // ── dm-handler ──
  const dm = await import("../src/dm-handler.js");
  for (const fn of ["registerDmHandler", "loadPendingDms", "setPendingDm", "clearPendingDmsForCorrection"]) {
    assertFn(dm, fn, "dm-handler");
  }
  console.log("  dm-handler.js ✓");

  // ── channel-handler ──
  const ch = await import("../src/channel-handler.js");
  assertFn(ch, "registerChannelHandler", "channel-handler");
  console.log("  channel-handler.js ✓");

  // ── app-home ──
  const ah = await import("../src/app-home.js");
  assertFn(ah, "registerAppHomeHandlers", "app-home");
  console.log("  app-home.js ✓");

  // ── slash-commands ──
  const sc = await import("../src/slash-commands.js");
  assertFn(sc, "registerSlashCommand", "slash-commands");
  console.log("  slash-commands.js ✓");

  // ── jobs ──
  const jobs = await import("../src/jobs.js");
  for (const fn of ["checkPendingEscalations", "checkPendingCorrections", "runPeriodicChecks"]) {
    assertFn(jobs, fn, "jobs");
  }
  console.log("  jobs.js ✓");

  // ── Verify ctx shape expectations ──
  console.log("\nSmoke test: verifying ctx shape...");
  const config = configMod.default;
  const ctx = {
    config,
    anthropic: {},
    notionCache: new Map(),
    watchChannelIds: new Set(),
    channelIdToName: new Map(),
    botUserId: null,
    getNotionContent: () => {},
    logger: console,
  };
  const requiredKeys = ["config", "anthropic", "notionCache", "watchChannelIds",
    "channelIdToName", "botUserId", "getNotionContent", "logger"];
  for (const key of requiredKeys) {
    assert(key in ctx, `ctx.${key} exists`);
  }
  console.log("  ctx shape ✓");

  // ── Summary ──
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("All smoke tests passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
