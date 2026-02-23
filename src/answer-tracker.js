import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_PATH = path.join(DATA_DIR, "faq-answers.json");

let faqAnswers = { answers: [] };

/**
 * Generate a unique answer ID
 */
function generateAnswerId() {
  return `ans_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Load FAQ answers from disk
 */
export async function loadFaqAnswers(logger = null) {
  try {
    const data = await fs.readFile(DATA_PATH, "utf8");
    faqAnswers = JSON.parse(data);
    if (!Array.isArray(faqAnswers.answers)) {
      faqAnswers.answers = [];
    }
    if (logger) {
      logger.info(`[AnswerTracker] Loaded ${faqAnswers.answers.length} tracked FAQ answer(s)`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      faqAnswers = { answers: [] };
      await saveFaqAnswers();
      if (logger) {
        logger.info(`[AnswerTracker] Created new FAQ answers tracking file`);
      }
    } else {
      throw err;
    }
  }
  return faqAnswers;
}

/**
 * Save FAQ answers to disk
 */
export async function saveFaqAnswers(logger = null) {
  // Ensure data directory exists
  const dataDir = path.dirname(DATA_PATH);
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
  await fs.writeFile(DATA_PATH, JSON.stringify(faqAnswers, null, 2), "utf8");
  if (logger) {
    logger.debug(`[AnswerTracker] Saved ${faqAnswers.answers.length} FAQ answer(s)`);
  }
}

/**
 * Track a new FAQ-based answer
 */
export async function trackFaqAnswer(
  {
    channel,
    threadTs,
    messageTs,
    productAreaId,
    originalQuestion,
    botAnswer,
    evidence,
    ownerUserIds,
    kbSourcePageIds,
  },
  logger = null
) {
  const answer = {
    id: generateAnswerId(),
    channel,
    threadTs,
    messageTs,
    productAreaId,
    originalQuestion,
    botAnswer,
    evidence: evidence || [],
    ownerUserIds: ownerUserIds || [],
    kbSourcePageIds: kbSourcePageIds || [],
    answeredAt: new Date().toISOString(),
    status: "active", // active, pending_correction, corrected, processed
    // Fields for delayed correction processing
    respondingOwnerIds: [],   // owners who have replied in the thread
    firstResponseAt: null,    // when the first owner replied
    processAfter: null,       // when to check for corrections
  };

  faqAnswers.answers.push(answer);
  await saveFaqAnswers(logger);

  if (logger) {
    logger.info(`[AnswerTracker] Tracked new FAQ answer: ${answer.id}`);
    logger.info(`[AnswerTracker]   Product Area: ${productAreaId}`);
    logger.info(`[AnswerTracker]   Channel: ${channel}, Thread: ${threadTs}`);
    logger.info(`[AnswerTracker]   Evidence snippets: ${evidence?.length || 0}`);
    logger.info(`[AnswerTracker]   KB source pages: ${answer.kbSourcePageIds.length > 0 ? answer.kbSourcePageIds.map(id => id.slice(0, 8)).join(", ") : "none"}`);
  }

  return answer;
}

/**
 * Get FAQ answer by ID
 */
export function getFaqAnswerById(id) {
  return faqAnswers.answers.find((a) => a.id === id) || null;
}

/**
 * Get active FAQ answer by thread (active or pending_correction)
 */
export function getActiveFaqAnswerByThread(channel, threadTs) {
  return faqAnswers.answers.find(
    (a) => a.channel === channel && a.threadTs === threadTs && 
           (a.status === "active" || a.status === "pending_correction")
  ) || null;
}

/**
 * Record that an owner has responded in an FAQ-answered thread.
 * Starts the correction check timer if this is the first response.
 * 
 * @param {string} id - The FAQ answer ID
 * @param {string} userId - The owner user ID who responded
 * @param {number} delayMs - How long to wait before processing corrections
 * @param {object} logger - Optional logger
 * @returns {Promise<boolean>} - True if response was recorded, false if already processed or not found
 */
export async function recordCorrectionResponse(id, userId, delayMs, logger = null) {
  const answer = getFaqAnswerById(id);
  if (!answer) {
    if (logger) {
      logger.warn(`[AnswerTracker] Attempted to record response for answer ${id} but not found`);
    }
    return false;
  }

  // Don't record responses for already processed/corrected answers
  if (answer.status === "corrected" || answer.status === "processed") {
    if (logger) {
      logger.debug(`[AnswerTracker] Answer ${id} already ${answer.status}, ignoring response`);
    }
    return false;
  }

  // Track this owner as having responded (if not already)
  if (!answer.respondingOwnerIds) {
    answer.respondingOwnerIds = [];
  }
  if (!answer.respondingOwnerIds.includes(userId)) {
    answer.respondingOwnerIds.push(userId);
    if (logger) {
      logger.info(`[AnswerTracker] Recorded owner <@${userId}> response for answer ${id}`);
      logger.info(`[AnswerTracker]   Total responding owners: ${answer.respondingOwnerIds.length}`);
    }
  } else {
    if (logger) {
      logger.debug(`[AnswerTracker] Owner <@${userId}> already recorded for answer ${id}`);
    }
  }

  // Start the timer if this is the first response
  if (answer.status === "active") {
    answer.status = "pending_correction";
    answer.firstResponseAt = new Date().toISOString();
    answer.processAfter = new Date(Date.now() + delayMs).toISOString();

    if (logger) {
      const delaySeconds = Math.round(delayMs / 1000);
      logger.info(`[AnswerTracker] Started correction timer for answer ${id}`);
      logger.info(`[AnswerTracker]   Will process after: ${answer.processAfter} (${delaySeconds}s delay)`);
    }
  } else if (logger) {
    logger.debug(`[AnswerTracker] Timer already running for answer ${id}, processAfter: ${answer.processAfter}`);
  }

  await saveFaqAnswers(logger);
  return true;
}

/**
 * Get answers that are ready to have their corrections processed.
 * These are answers in "pending_correction" status where the delay has passed.
 */
export function getAnswersReadyToProcess() {
  const now = new Date();
  return faqAnswers.answers.filter(
    (a) => a.status === "pending_correction" && 
           a.processAfter && 
           new Date(a.processAfter) <= now
  );
}

/**
 * Mark an FAQ answer as processed (no correction detected or correction handled)
 */
export async function markAnswerProcessed(id, processInfo = {}, logger = null) {
  const answer = getFaqAnswerById(id);
  if (!answer) {
    if (logger) {
      logger.warn(`[AnswerTracker] Attempted to mark answer ${id} as processed but not found`);
    }
    return false;
  }

  answer.status = "processed";
  answer.processedAt = new Date().toISOString();
  answer.processInfo = processInfo;

  await saveFaqAnswers(logger);

  if (logger) {
    logger.info(`[AnswerTracker] Marked answer ${id} as processed`);
  }

  return true;
}

/**
 * Mark an FAQ answer as corrected
 */
export async function markAnswerCorrected(id, correctionInfo = {}, logger = null) {
  const answer = getFaqAnswerById(id);
  if (!answer) {
    if (logger) {
      logger.warn(`[AnswerTracker] Attempted to mark answer ${id} as corrected but not found`);
    }
    return false;
  }

  answer.status = "corrected";
  answer.correctedAt = new Date().toISOString();
  answer.correctionInfo = correctionInfo;

  await saveFaqAnswers(logger);

  if (logger) {
    logger.info(`[AnswerTracker] Marked answer ${id} as corrected`);
  }

  return true;
}

/**
 * Cleanup old FAQ answers (older than specified days)
 */
export async function cleanupOldFaqAnswers(maxAgeDays = 30, logger = null) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  const before = faqAnswers.answers.length;
  faqAnswers.answers = faqAnswers.answers.filter((a) => {
    // Keep active and pending_correction answers
    if (a.status === "active" || a.status === "pending_correction") return true;
    // For corrected/processed answers, check if they're old enough to remove
    const timestamp = a.correctedAt || a.processedAt || a.answeredAt;
    return new Date(timestamp) > cutoff;
  });

  if (faqAnswers.answers.length !== before) {
    await saveFaqAnswers(logger);
    if (logger) {
      logger.info(`[AnswerTracker] Cleaned up ${before - faqAnswers.answers.length} old FAQ answer(s)`);
    }
  }

  return before - faqAnswers.answers.length;
}

/**
 * Get all active FAQ answers (active or pending_correction)
 */
export function getAllActiveFaqAnswers() {
  return faqAnswers.answers.filter((a) => a.status === "active" || a.status === "pending_correction");
}
