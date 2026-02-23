import { looksLikeQuestion, alreadySeen, getThreadContext, truncate } from "./slack-helpers.js";
import { formatAnswer, formatPartialAnswer, formatEscalation } from "./formatters.js";
import {
  getAllKnowledgeAreas,
  getKnowledgeAreaById,
  isTeamMemberForAnyArea,
  isTeamMemberForArea,
  addTeamMember,
  getLeads,
  getMember,
  touchMemberActivity,
  updateMemberDescription,
} from "./knowledge-areas.js";
import {
  classifyQuestion,
  askClaude,
  selectKbPages,
  analyzeThreadReply,
  selectRelevantLeads,
  evolveExpertiseDescription,
} from "./llm.js";
import {
  trackEscalation,
  recordOwnerResponse,
  getActiveEscalationByThread,
} from "./escalation-tracker.js";
import {
  trackFaqAnswer,
  getActiveFaqAnswerByThread,
  recordCorrectionResponse,
} from "./answer-tracker.js";

const GENERAL_FAQ_AREA_ID = "general-faq";

/**
 * Maybe evolve a team member's expertise description based on a new response.
 * Throttled to once per throttle period per person per area.
 */
async function maybeEvolveDescription(userId, areaId, responseText, ctx) {
  const { anthropic, config } = ctx;
  const logger = ctx.logger;

  try {
    const member = getMember(areaId, userId);
    if (!member) return;

    const lastActive = member.lastActiveAt ? new Date(member.lastActiveAt).getTime() : 0;
    const now = Date.now();

    await touchMemberActivity(areaId, userId, logger);

    if (now - lastActive < config.descriptionUpdateThrottleMs) {
      return;
    }

    const area = getKnowledgeAreaById(areaId);
    if (!area) return;

    logger.info(`[Discovery] Evolving expertise description for <@${userId}> in "${area.name}"`);
    const result = await evolveExpertiseDescription(anthropic, config.claudeSmartModel, member.description || "", responseText, area.name);

    if (result.changed && result.updated_description) {
      await updateMemberDescription(areaId, userId, result.updated_description, logger);
      logger.info(`[Discovery] Updated expertise for <@${userId}>: "${result.updated_description}"`);
    }
  } catch (err) {
    if (logger) logger.error(`[Discovery] Error evolving description: ${err?.message ?? err}`);
  }
}

/**
 * Handle auto-discovery of new team members from thread replies.
 */
async function handleAutoDiscovery(event, threadAreaId, text, client, ctx) {
  const { anthropic, config } = ctx;
  const logger = ctx.logger;
  const userId = event.user;

  if (isTeamMemberForAnyArea(userId)) {
    logger.debug(`[Discovery] <@${userId}> is already a team member, skipping`);
    return;
  }

  const knowledgeAreas = getAllKnowledgeAreas();
  logger.info(`[Discovery] Analyzing reply from <@${userId}> for potential auto-discovery`);

  const analysis = await analyzeThreadReply(anthropic, config.claudeSmartModel, text, knowledgeAreas);
  logger.info(`[Discovery] Analysis: substantive=${analysis.is_substantive_expert_response}, self_id=${analysis.is_self_identified_owner}, area=${analysis.matched_knowledge_area_id}`);

  if (!analysis.is_substantive_expert_response && !analysis.is_self_identified_owner) {
    logger.debug(`[Discovery] Reply not substantive or self-identified, skipping`);
    return;
  }

  const targetAreaId = analysis.matched_knowledge_area_id || threadAreaId;
  const targetArea = getKnowledgeAreaById(targetAreaId);
  if (!targetArea) {
    logger.warn(`[Discovery] Target area ${targetAreaId} not found, skipping`);
    return;
  }

  if (isTeamMemberForArea(userId, targetAreaId)) {
    logger.debug(`[Discovery] <@${userId}> is already a member of "${targetArea.name}", skipping`);
    return;
  }

  const addedBy = analysis.is_self_identified_owner ? "self-identified" : "auto-detected";
  const description = analysis.expertise_description || "";

  logger.info(`[Discovery] Adding <@${userId}> as team member for "${targetArea.name}" (by: ${addedBy})`);
  await addTeamMember(targetAreaId, userId, description, addedBy, logger);

  const thread_ts = event.thread_ts ?? event.ts;
  try {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts,
      text: `Got it — I've added <@${userId}> to the *${targetArea.name}* team. ${description ? `_(${description})_` : ""}`,
      mrkdwn: true,
    });
  } catch (err) {
    logger.warn(`[Discovery] Failed to post confirmation: ${err?.message ?? err}`);
  }
}

export function registerChannelHandler(app, ctx) {
  const { config, anthropic } = ctx;

  app.event("message", async ({ event, client, logger }) => {
    try {
      if (event.channel_type === "im") return;
      if (event.subtype) return;
      if (event.bot_id) return;
      if (ctx.botUserId && event.user === ctx.botUserId) return;

      const handlerCtx = { ...ctx, logger };

      if (!ctx.watchChannelIds.has(event.channel)) return;

      const text = (event.text ?? "").trim();
      if (!text) return;

      const isBotMention = ctx.botUserId && text.includes(`<@${ctx.botUserId}>`);
      const cleanText = isBotMention
        ? text.replace(new RegExp(`<@${ctx.botUserId}>`, "g"), "").replace(/\s{2,}/g, " ").trim()
        : text;
      if (isBotMention && !cleanText) return; // bare "@Bot" with nothing else

      if (isBotMention) {
        logger.info(`[Message] Bot @-mentioned by <@${event.user}> — cleanText: "${cleanText.substring(0, 100)}"`);
      }

      // Check if this is a reply in a bot-handled thread (escalation or FAQ answer)
      if (event.thread_ts) {
        const escalation = getActiveEscalationByThread(event.channel, event.thread_ts);
        const trackedAnswer = getActiveFaqAnswerByThread(event.channel, event.thread_ts);

        let threadAreaId = escalation?.productAreaId ?? trackedAnswer?.productAreaId ?? null;
        const isInHandledThread = !!(escalation || trackedAnswer);

        // ── Known team member / owner responding in escalated thread ──
        if (escalation && escalation.ownerUserIds.includes(event.user)) {
          logger.info(`[Message] Owner <@${event.user}> responded in escalated thread ${event.thread_ts}`);
          const wasRecorded = await recordOwnerResponse(escalation.id, config.synthesisDelayMs, logger);
          if (wasRecorded) {
            logger.info(`[Message] Synthesis timer started for escalation ${escalation.id}`);
          }

          if (threadAreaId && threadAreaId !== GENERAL_FAQ_AREA_ID) {
            await maybeEvolveDescription(event.user, threadAreaId, text, handlerCtx);
          }

          return;
        }

        // ── Known team member / owner responding in FAQ-answered thread ──
        if (trackedAnswer) {
          let correctionOwnerIds;
          if (trackedAnswer.productAreaId === GENERAL_FAQ_AREA_ID) {
            correctionOwnerIds = config.generalFaq.adminUserIds;
          } else {
            const area = getKnowledgeAreaById(trackedAnswer.productAreaId);
            if (!area) {
              logger.warn(`[Correction] Knowledge area ${trackedAnswer.productAreaId} not found for tracked answer`);
              return;
            }
            correctionOwnerIds = area.ownerUserIds;
          }

          if (correctionOwnerIds.includes(event.user)) {
            const correctionDedupeKey = `correction:${event.channel}:${event.ts}`;
            if (alreadySeen(correctionDedupeKey)) {
              logger.debug(`[Correction] Duplicate message detected, skipping: ${correctionDedupeKey}`);
              return;
            }

            logger.info(`[Correction] Owner/engineer <@${event.user}> replied in FAQ-answered thread ${event.thread_ts}`);

            const wasRecorded = await recordCorrectionResponse(
              trackedAnswer.id,
              event.user,
              config.correctionCheckDelayMs,
              logger
            );

            if (wasRecorded) {
              const delaySeconds = Math.round(config.correctionCheckDelayMs / 1000);
              logger.info(`[Correction] Response recorded. Will check for corrections after ${delaySeconds}s delay.`);
            }

            if (threadAreaId && threadAreaId !== GENERAL_FAQ_AREA_ID) {
              await maybeEvolveDescription(event.user, threadAreaId, text, handlerCtx);
            }

            return;
          }
        }

        // ── Non-team-member replying in a bot-handled thread: auto-discovery ──
        if (config.features.autoDiscovery && isInHandledThread && threadAreaId && threadAreaId !== GENERAL_FAQ_AREA_ID) {
          const discoveryDedupeKey = `discovery:${event.channel}:${event.ts}`;
          if (!alreadySeen(discoveryDedupeKey)) {
            handleAutoDiscovery(event, threadAreaId, text, client, handlerCtx).catch((err) => {
              logger.error(`[Discovery] Error in auto-discovery: ${err?.message ?? err}`);
            });
          }
        }
      }

      // Detect if this is a follow-up in a thread the bot is already handling
      let isFollowUpInHandledThread = false;

      if (event.thread_ts) {
        const existingThreadEscalation = getActiveEscalationByThread(event.channel, event.thread_ts);
        const existingThreadAnswer = getActiveFaqAnswerByThread(event.channel, event.thread_ts);

        if (existingThreadEscalation || existingThreadAnswer) {
          isFollowUpInHandledThread = true;
          logger.info(`[Message] Follow-up detected in already-handled thread ${event.thread_ts}`);
        }
      }

      if (!looksLikeQuestion(cleanText) && !isBotMention) return;

      const dedupeKey = `${event.channel}:${event.ts}`;
      if (alreadySeen(dedupeKey)) return;

      const knowledgeAreas = getAllKnowledgeAreas();
      if (knowledgeAreas.length === 0) return;

      const channelName = ctx.channelIdToName.get(event.channel) || null;
      logger.info(`[Message] Classifying question from <@${event.user}> in channel ${event.channel} (${channelName || "unknown"})`);
      const classification = await classifyQuestion(anthropic, config.claudeModel, cleanText, knowledgeAreas, channelName);
      logger.info(`[Message] Classification result: is_question=${classification.is_question}, product_area_id=${classification.product_area_id}, confidence=${classification.confidence}`);

      if (!classification.is_question && !isBotMention) return;
      if (!classification.product_area_id && !isBotMention) return;

      // Bot was @-mentioned but classification failed — route to general KB
      if (isBotMention && (!classification.is_question || !classification.product_area_id)) {
        logger.info(`[Message] Bot @-mentioned but classification missed (is_question=${classification.is_question}, area=${classification.product_area_id}), routing to general KB`);
        classification.product_area_id = "general";
      }

      const thread_ts = event.thread_ts ?? event.ts;

      // ── General FAQ path ──
      if (classification.product_area_id === "general") {
        if (!config.generalFaq.enabled || (!config.generalFaq.kbRootPageUrl && !config.generalFaq.notionPageUrl)) {
          logger.info(`[Message] General FAQ not configured, skipping`);
          return;
        }

        logger.info(`[Message] General question detected, checking Product Knowledge Base`);

        let generalFaqContent = null;
        let kbSourcePageIds = [];

        // Try KB hierarchy flow first
        if (config.generalFaq.kbRootPageUrl) {
          try {
            const hierarchy = await ctx.getKbHierarchy();

            if (hierarchy.length > 0) {
              logger.info(`[Message] KB hierarchy has ${hierarchy.length} page(s), selecting relevant ones`);
              const selection = await selectKbPages(anthropic, config.claudeModel, cleanText, hierarchy);
              logger.info(`[Message] KB page selection: ${selection.selected_pages.length} page(s) selected — ${selection.rationale}`);

              if (selection.selected_pages.length > 0) {
                const sections = [];
                const selectedPageIds = [];
                let totalLength = 0;
                const MAX_CONTENT_LENGTH = 15000;

                for (const page of selection.selected_pages) {
                  if (totalLength >= MAX_CONTENT_LENGTH) break;
                  try {
                    const content = await ctx.getNotionContent(page.page_id);
                    if (content) {
                      const pageTitle = hierarchy.find((p) => p.pageId === page.page_id)?.title || "Unknown";
                      const section = `--- ${pageTitle} ---\n${content}`;
                      sections.push(section);
                      selectedPageIds.push(page.page_id);
                      totalLength += section.length;
                    }
                  } catch (err) {
                    logger.warn(`[Message] Failed to fetch KB page ${page.page_id}: ${err?.message ?? err}`);
                  }
                }

                if (sections.length > 0) {
                  generalFaqContent = sections.join("\n\n").slice(0, MAX_CONTENT_LENGTH);
                  kbSourcePageIds = selectedPageIds;
                  logger.info(`[Message] KB source pages for correction tracking: ${kbSourcePageIds.length} page(s) — ${kbSourcePageIds.map(id => id.slice(0, 8)).join(", ")}`);
                }
              }
            }
          } catch (err) {
            logger.warn(`[Message] KB hierarchy flow failed: ${err?.message ?? err}`);
          }
        }

        // Fallback: fetch root KB page content or legacy notionPageUrl
        if (!generalFaqContent) {
          const fallbackUrl = config.generalFaq.kbRootPageUrl || config.generalFaq.notionPageUrl;
          if (fallbackUrl) {
            logger.info(`[Message] Falling back to root page content`);
            generalFaqContent = await ctx.getNotionContent(fallbackUrl);
          }
        }

        if (!generalFaqContent) {
          logger.warn(`[Message] No General FAQ content available`);
        }

        if (generalFaqContent) {
          const threadContext = await getThreadContext(client, event, logger);

          const result = await askClaude(anthropic, config.claudeModel, {
            questionText: cleanText,
            threadContext,
            faqContent: generalFaqContent,
            areaName: "General",
          });

          if (result.answer_found_in_faq) {
            const answerMsg = await client.chat.postMessage({
              channel: event.channel,
              thread_ts,
              text: formatAnswer(result, "General", config.showEvidence),
              mrkdwn: true,
            });

            await trackFaqAnswer(
              {
                channel: event.channel,
                threadTs: thread_ts,
                messageTs: answerMsg.ts,
                productAreaId: GENERAL_FAQ_AREA_ID,
                originalQuestion: cleanText,
                botAnswer: result.answer,
                evidence: result.evidence || [],
                ownerUserIds: [...config.generalFaq.adminUserIds],
                kbSourcePageIds,
              },
              logger
            );
            return;
          }
        }

        // No answer found — silently watch the thread
        logger.info(`[Message] No General FAQ answer found, silently watching thread`);
        await trackEscalation(
          {
            channel: event.channel,
            threadTs: thread_ts,
            messageTs: event.ts,
            productAreaId: GENERAL_FAQ_AREA_ID,
            originalQuestion: cleanText,
            ownerUserIds: [...config.generalFaq.adminUserIds],
          },
          logger
        );
        return;
      }

      // ── Specific knowledge area path ──
      const area = getKnowledgeAreaById(classification.product_area_id);
      if (!area) {
        logger.warn(`[Message] Knowledge area ${classification.product_area_id} not found`);
        return;
      }

      if (!isBotMention && isTeamMemberForArea(event.user, area.id)) {
        logger.info(`[Message] <@${event.user}> is a team member/lead for "${area.name}", skipping answer`);
        return;
      }

      logger.info(`[Message] Processing question for knowledge area: "${area.name}"`);

      const faqContent = await ctx.getNotionContent(area.notionPageId);
      if (!faqContent) {
        logger.warn(`[Message] No FAQ content for knowledge area ${area.name}`);
        return;
      }

      const threadContext = await getThreadContext(client, event, logger);

      const result = await askClaude(anthropic, config.claudeModel, {
        questionText: cleanText,
        threadContext,
        faqContent,
        areaName: area.name,
      });

      logger.info(`[Message] Claude result: answer_found_in_faq=${result.answer_found_in_faq}, needs_escalation=${result.needs_escalation}`);

      if (result.answer_found_in_faq && result.needs_escalation) {
        const leads = getLeads(area.id);
        let escalationUserIds;

        if (leads.length > 0) {
          try {
            escalationUserIds = await selectRelevantLeads(anthropic, config.claudeSmartModel, cleanText, leads, area.name);
          } catch (err) {
            logger.warn(`[Message] Smart lead selection failed: ${err?.message ?? err}`);
            escalationUserIds = leads.map((l) => l.userId);
          }
        } else {
          escalationUserIds = area.ownerUserIds;
        }

        const answerMsg = await client.chat.postMessage({
          channel: event.channel,
          thread_ts,
          text: formatPartialAnswer(result, area.name, escalationUserIds, area.notionPageId, config.showEvidence),
          mrkdwn: true,
        });

        await trackFaqAnswer(
          {
            channel: event.channel,
            threadTs: thread_ts,
            messageTs: answerMsg.ts,
            productAreaId: area.id,
            originalQuestion: cleanText,
            botAnswer: result.answer,
            evidence: result.evidence || [],
            ownerUserIds: area.ownerUserIds,
          },
          logger
        );

        await trackEscalation(
          {
            channel: event.channel,
            threadTs: thread_ts,
            messageTs: answerMsg.ts,
            productAreaId: area.id,
            originalQuestion: cleanText,
            ownerUserIds: area.ownerUserIds,
          },
          logger
        );
      } else if (result.answer_found_in_faq) {
        const answerMsg = await client.chat.postMessage({
          channel: event.channel,
          thread_ts,
          text: formatAnswer(result, area.name, config.showEvidence),
          mrkdwn: true,
        });

        await trackFaqAnswer(
          {
            channel: event.channel,
            threadTs: thread_ts,
            messageTs: answerMsg.ts,
            productAreaId: area.id,
            originalQuestion: cleanText,
            botAnswer: result.answer,
            evidence: result.evidence || [],
            ownerUserIds: area.ownerUserIds,
          },
          logger
        );
      } else if (isFollowUpInHandledThread) {
        logger.info(`[Message] Follow-up FAQ miss in already-handled thread, staying silent`);
        return;
      } else {
        const leads = getLeads(area.id);
        let escalationUserIds;

        if (leads.length > 0) {
          try {
            escalationUserIds = await selectRelevantLeads(anthropic, config.claudeSmartModel, cleanText, leads, area.name);
          } catch (err) {
            logger.warn(`[Message] Smart lead selection failed: ${err?.message ?? err}`);
            escalationUserIds = leads.map((l) => l.userId);
          }
        } else {
          escalationUserIds = area.ownerUserIds;
        }

        const escalationMsg = await client.chat.postMessage({
          channel: event.channel,
          thread_ts,
          text: formatEscalation({
            questionText: cleanText,
            followUps: result.follow_up_questions ?? [],
            ownerUserIds: escalationUserIds,
            areaName: area.name,
            notionFaqUrl: area.notionPageId,
          }),
          mrkdwn: true,
        });

        await trackEscalation(
          {
            channel: event.channel,
            threadTs: thread_ts,
            messageTs: escalationMsg.ts,
            productAreaId: area.id,
            originalQuestion: cleanText,
            ownerUserIds: area.ownerUserIds,
          },
          logger
        );
      }
    } catch (e) {
      logger.error(e);
    }
  });
}
