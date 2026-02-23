import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_PATH = path.join(DATA_DIR, "pending-escalations.json");

// Default delay after first owner response before synthesizing (30 minutes)
const DEFAULT_SYNTHESIS_DELAY_MS = 30 * 60 * 1000;

let escalations = { escalations: [] };

/**
 * Generate a unique escalation ID
 */
function generateEscalationId() {
  return `esc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Load escalations from disk
 */
export async function loadEscalations() {
  try {
    const data = await fs.readFile(DATA_PATH, "utf8");
    escalations = JSON.parse(data);
    if (!Array.isArray(escalations.escalations)) {
      escalations.escalations = [];
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      escalations = { escalations: [] };
      await saveEscalations();
    } else {
      throw err;
    }
  }
  return escalations;
}

/**
 * Save escalations to disk
 */
export async function saveEscalations() {
  // Ensure data directory exists
  const dataDir = path.dirname(DATA_PATH);
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  await fs.writeFile(DATA_PATH, JSON.stringify(escalations, null, 2), "utf8");
}

/**
 * Track a new escalation
 */
export async function trackEscalation(
  {
    channel,
    threadTs,
    messageTs,
    productAreaId,
    originalQuestion,
    ownerUserIds,
  },
  logger = null
) {
  const escalation = {
    id: generateEscalationId(),
    channel,
    threadTs,
    messageTs,
    productAreaId,
    originalQuestion,
    ownerUserIds: ownerUserIds || [],
    escalatedAt: new Date().toISOString(),
    status: "awaiting_response", // waiting for owner to respond
  };

  escalations.escalations.push(escalation);
  await saveEscalations();

  if (logger) {
    logger.info(`[Escalation] Tracked new escalation: ${escalation.id}`);
    logger.info(`[Escalation]   Product Area: ${productAreaId}`);
    logger.info(`[Escalation]   Channel: ${channel}, Thread: ${threadTs}`);
    logger.info(`[Escalation]   Owners: ${ownerUserIds.length} user(s)`);
    logger.info(`[Escalation]   Question: ${originalQuestion.substring(0, 100)}${originalQuestion.length > 100 ? "..." : ""}`);
  }

  return escalation;
}

/**
 * Record that an owner has responded - starts the synthesis timer
 */
export async function recordOwnerResponse(id, synthesisDelayMs = DEFAULT_SYNTHESIS_DELAY_MS, logger = null) {
  const escalation = getEscalationById(id);
  if (!escalation) {
    if (logger) {
      logger.warn(`[Escalation] Attempted to record response for escalation ${id} but not found`);
    }
    return false;
  }

  // Only transition from awaiting_response to ready_to_synthesize
  if (escalation.status !== "awaiting_response") {
    if (logger) {
      logger.debug(`[Escalation] Escalation ${id} is in status "${escalation.status}", not awaiting response`);
    }
    return false;
  }

  escalation.status = "ready_to_synthesize";
  escalation.firstResponseAt = new Date().toISOString();
  escalation.synthesizeAfter = new Date(Date.now() + synthesisDelayMs).toISOString();

  await saveEscalations();

  if (logger) {
    const delayMinutes = Math.round(synthesisDelayMs / 60000);
    logger.info(`[Escalation] Owner responded to escalation ${id}`);
    logger.info(`[Escalation]   Synthesis scheduled for ${new Date(escalation.synthesizeAfter).toISOString()} (${delayMinutes} minutes)`);
  }

  return true;
}

/**
 * Get escalations that are ready to synthesize (owner responded and delay has passed)
 */
export function getEscalationsReadyToSynthesize() {
  const now = new Date();
  return escalations.escalations.filter(
    (e) => e.status === "ready_to_synthesize" && new Date(e.synthesizeAfter) <= now
  );
}

/**
 * Get all escalations awaiting owner response
 */
export function getEscalationsAwaitingResponse() {
  return escalations.escalations.filter((e) => e.status === "awaiting_response");
}

/**
 * Get all active escalations (not completed/skipped)
 */
export function getAllActiveEscalations() {
  return escalations.escalations.filter(
    (e) => e.status === "awaiting_response" || e.status === "ready_to_synthesize"
  );
}

/**
 * Get escalation by ID
 */
export function getEscalationById(id) {
  return escalations.escalations.find((e) => e.id === id) || null;
}

/**
 * Get escalation by thread (only active ones awaiting response)
 */
export function getEscalationByThread(channel, threadTs) {
  return escalations.escalations.find(
    (e) => e.channel === channel && e.threadTs === threadTs && e.status === "awaiting_response"
  ) || null;
}

/**
 * Get any active escalation by thread (awaiting_response or ready_to_synthesize)
 */
export function getActiveEscalationByThread(channel, threadTs) {
  return escalations.escalations.find(
    (e) =>
      e.channel === channel &&
      e.threadTs === threadTs &&
      (e.status === "awaiting_response" || e.status === "ready_to_synthesize")
  ) || null;
}

/**
 * Mark an escalation as complete
 */
export async function markEscalationComplete(id, faqUrl = null) {
  const escalation = getEscalationById(id);
  if (!escalation) {
    return false;
  }

  escalation.status = "completed";
  escalation.completedAt = new Date().toISOString();
  if (faqUrl) {
    escalation.faqUrl = faqUrl;
  }

  await saveEscalations();
  return true;
}

/**
 * Mark an escalation as skipped (no owner response)
 */
export async function markEscalationSkipped(id, reason = "no_response") {
  const escalation = getEscalationById(id);
  if (!escalation) {
    return false;
  }

  escalation.status = "skipped";
  escalation.skippedAt = new Date().toISOString();
  escalation.skipReason = reason;

  await saveEscalations();
  return true;
}

/**
 * Cleanup old completed/skipped escalations (older than 30 days)
 */
export async function cleanupOldEscalations(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const before = escalations.escalations.length;
  escalations.escalations = escalations.escalations.filter((e) => {
    if (e.status === "pending") return true;
    const completedAt = e.completedAt || e.skippedAt || e.escalatedAt;
    return new Date(completedAt) > cutoff;
  });

  if (escalations.escalations.length !== before) {
    await saveEscalations();
  }

  return before - escalations.escalations.length;
}
