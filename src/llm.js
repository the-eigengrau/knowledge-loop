import Anthropic from "@anthropic-ai/sdk";

// ─── JSON Schemas ───────────────────────────────────────────────────────────

export const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    is_question: {
      type: "boolean",
      description: "True if the message is asking a question that needs an answer.",
    },
    product_area_id: {
      type: ["string", "null"],
      description: "The ID of the knowledge area this question belongs to, or null if it doesn't match any.",
    },
    confidence: {
      type: "number",
      description: "Confidence score 0-1 for the classification.",
    },
  },
  required: ["is_question", "product_area_id", "confidence"],
  additionalProperties: false,
};

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer_found_in_faq: {
      type: "boolean",
      description: "True if the FAQ contains relevant, helpful information about the topic being asked. False only if the FAQ has NO relevant information.",
    },
    answer: {
      type: "string",
      description: "Slack mrkdwn answer. Be concise and direct. If answer_found_in_faq is false, return an empty string.",
    },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: "1-3 short verbatim snippets copied from the FAQ (<=25 words each) that justify the answer. If answer_found_in_faq is false, return [].",
    },
    follow_up_questions: {
      type: "array",
      items: { type: "string" },
      description: "Up to 2 clarifying questions if needed. If none, return []. If answer_found_in_faq is false, include questions that would help a human respond.",
    },
    faq_topics: {
      type: "array",
      items: { type: "string" },
      description: "Optional topic labels. If unknown, return [].",
    },
    needs_escalation: {
      type: "boolean",
      description: "True if the answer has significant gaps the FAQ doesn't cover and a knowledge area owner should weigh in. False if the FAQ fully addresses the question.",
    },
  },
  required: ["answer_found_in_faq", "answer", "evidence", "follow_up_questions", "faq_topics", "needs_escalation"],
  additionalProperties: false,
};

export const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "A clear, concise question that captures what was being asked.",
    },
    answer: {
      type: "string",
      description: "A comprehensive answer synthesized from the owner responses.",
    },
    should_add_to_faq: {
      type: "boolean",
      description: "True if this Q&A is valuable enough to add to the FAQ (not too specific, generally useful).",
    },
  },
  required: ["question", "answer", "should_add_to_faq"],
  additionalProperties: false,
};

export const SUBSTANTIVE_CHECK_SCHEMA = {
  type: "object",
  properties: {
    has_substantive_answer: {
      type: "boolean",
      description:
        "True if at least one owner response provides a clear, reusable answer that would make sense to capture in the FAQ.",
    },
    rationale: {
      type: "string",
      description: "Short explanation of why the responses are or are not substantive enough.",
    },
  },
  required: ["has_substantive_answer", "rationale"],
  additionalProperties: false,
};

export const CORRECTION_CHECK_SCHEMA = {
  type: "object",
  properties: {
    is_correction: {
      type: "boolean",
      description:
        "True if the owner's reply is correcting, disagreeing with, or updating the bot's answer. False if they are just adding context, asking follow-up questions, or confirming the answer.",
    },
    corrected_content: {
      type: "string",
      description:
        "If is_correction is true, describe which part of the bot's answer (or the underlying FAQ content) appears to be wrong or outdated. If is_correction is false, return an empty string.",
    },
    suggested_update: {
      type: "string",
      description:
        "If is_correction is true, provide a suggested replacement text for the FAQ entry based on the owner's correction. Write it as a complete, standalone FAQ answer. If is_correction is false, return an empty string.",
    },
    rationale: {
      type: "string",
      description: "Brief explanation of why this is or is not considered a correction.",
    },
  },
  required: ["is_correction", "corrected_content", "suggested_update", "rationale"],
  additionalProperties: false,
};

export const THREAD_REPLY_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    is_substantive_expert_response: {
      type: "boolean",
      description:
        "True if the reply demonstrates deep, technical, expert-level knowledge about the knowledge area — not just a casual opinion, simple acknowledgment, or follow-up question.",
    },
    is_self_identified_owner: {
      type: "boolean",
      description:
        "True if the person explicitly claims to be an owner, lead, or expert for a knowledge area (e.g. 'I'm an engineer working on billing').",
    },
    matched_knowledge_area_id: {
      type: ["string", "null"],
      description:
        "The ID of the knowledge area this person's expertise maps to, using fuzzy matching. Null if no match.",
    },
    expertise_description: {
      type: "string",
      description:
        "A short (1-2 sentence) description of this person's apparent expertise based on their reply. Empty string if not substantive.",
    },
  },
  required: [
    "is_substantive_expert_response",
    "is_self_identified_owner",
    "matched_knowledge_area_id",
    "expertise_description",
  ],
  additionalProperties: false,
};

export const LEAD_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selected_user_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "Array of 1-3 lead user IDs most relevant to this question. If unsure, return all lead IDs.",
    },
    rationale: {
      type: "string",
      description: "Brief explanation of why these leads were selected.",
    },
  },
  required: ["selected_user_ids", "rationale"],
  additionalProperties: false,
};

export const DESCRIPTION_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    updated_description: {
      type: "string",
      description:
        "A concise (1-3 sentence) updated description of this person's expertise, merging their previous description with evidence from their latest response. Keep it factual and specific to what they work on.",
    },
    changed: {
      type: "boolean",
      description:
        "True if the description meaningfully changed from the previous one. False if the new response doesn't add new information about their expertise.",
    },
  },
  required: ["updated_description", "changed"],
  additionalProperties: false,
};

export const DM_INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["view_roster", "modify_roster", "add_knowledge_area", "self_registration", "general"],
      description:
        "The primary intent of the message. view_roster = wants to see the team roster. modify_roster = wants to add/remove/promote/demote a team member. add_knowledge_area = wants to create a new knowledge area. self_registration = telling the bot about themselves. general = other chat, questions, or help.",
    },
    matched_knowledge_area_id: {
      type: "string",
      description:
        "The ID of the knowledge area this message is about. Use fuzzy matching. Empty string if no area is relevant or identifiable.",
    },
    action: {
      type: "string",
      enum: ["add_member", "remove_member", "promote", "demote", "update_description", ""],
      description:
        "For modify_roster intent: the specific action requested. Empty string for other intents.",
    },
    target_user_mentions: {
      type: "array",
      items: { type: "string" },
      description:
        'Slack user IDs extracted from <@U...> mentions in the message. E.g. if they said "<@U12345>", include "U12345". Empty if no mentions.',
    },
    target_user_names: {
      type: "array",
      items: { type: "string" },
      description:
        'Plain-text names of people mentioned without @ mentions, e.g. "Add John to Engineering" -> ["John"]. Empty if names are mentioned via @.',
    },
    member_description: {
      type: "string",
      description:
        'For add_member or update_description actions: the description/expertise of the target person. E.g. "she works on call routing" -> "Call routing". Empty string if not provided.',
    },
    expertise_description: {
      type: "string",
      description:
        "For self_registration: a concise description of the sender's own expertise. Empty for other intents.",
    },
    role: {
      type: "string",
      description:
        "For self_registration: the sender's stated role/title. Empty for other intents.",
    },
    matched_self_reg_area_ids: {
      type: "array",
      items: { type: "string" },
      description:
        "For self_registration: knowledge area IDs the sender's expertise maps to. Empty for other intents.",
    },
    new_area_name: {
      type: "string",
      description: "For add_knowledge_area: the name of the new knowledge area. Empty for other intents.",
    },
    new_area_description: {
      type: "string",
      description: "For add_knowledge_area: the description of the new area. Empty if not provided.",
    },
    new_area_notion_url: {
      type: "string",
      description: "For add_knowledge_area: the Notion page URL/ID. Empty if not provided.",
    },
    new_area_keywords: {
      type: "array",
      items: { type: "string" },
      description: "For add_knowledge_area: keywords for the new area. Empty if not provided.",
    },
    new_area_lead_mentions: {
      type: "array",
      items: { type: "string" },
      description: "For add_knowledge_area: Slack user IDs of leads for the new area (from <@U...> mentions). Empty if not provided.",
    },
    new_area_lead_names: {
      type: "array",
      items: { type: "string" },
      description: "For add_knowledge_area: plain-text names of leads for the new area. Empty if not provided.",
    },
    response_message: {
      type: "string",
      description:
        "A friendly, natural response to send back. For successful actions, confirm what was done. For view_roster, just say something brief like 'Here's the roster'. For general, be helpful. Always write like a teammate, not a robot.",
    },
  },
  required: [
    "intent",
    "matched_knowledge_area_id",
    "action",
    "target_user_mentions",
    "target_user_names",
    "member_description",
    "expertise_description",
    "role",
    "matched_self_reg_area_ids",
    "new_area_name",
    "new_area_description",
    "new_area_notion_url",
    "new_area_keywords",
    "new_area_lead_mentions",
    "new_area_lead_names",
    "response_message",
  ],
  additionalProperties: false,
};

export const KB_PAGE_SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selected_pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "The page ID of the selected sub-page." },
          relevance: { type: "string", description: "Brief note on why this page is relevant." },
        },
        required: ["page_id", "relevance"],
        additionalProperties: false,
      },
      description: "1-3 most relevant KB sub-pages for the question. Empty array if no page matches.",
    },
    rationale: {
      type: "string",
      description: "Brief explanation of the selection reasoning.",
    },
  },
  required: ["selected_pages", "rationale"],
  additionalProperties: false,
};

// ─── LLM Functions ──────────────────────────────────────────────────────────

export async function classifyQuestion(anthropic, model, text, knowledgeAreas, channelName = null) {
  const areasDescription = knowledgeAreas
    .map((a) => {
      let desc = `- ID: "${a.id}"\n  Name: "${a.name}"`;
      if (a.description) {
        desc += `\n  Description: ${a.description}`;
      }
      if (a.keywords.length > 0) {
        desc += `\n  Keywords: ${a.keywords.join(", ")}`;
      }
      return desc;
    })
    .join("\n\n");

  const channelContext = channelName
    ? `
Channel context: This message was posted in "#${channelName}"

IMPORTANT: When a channel name contains or relates to a knowledge area name (e.g., "sales-questions" relates to "Sales", "engineering-help" relates to "Engineering"), this is a strong signal about topic relevance. Weight classification toward that knowledge area unless the question is CLEARLY and UNAMBIGUOUSLY about a different area.

For example, if a message in "#sales-questions" asks about pricing tiers, it's almost certainly about the Sales knowledge area, not Engineering, even if keywords overlap.
`
    : "";

  const system = `
You are a question classifier for an internal Slack bot that answers domain questions. Your job is to:
1. Determine if a message is a GENUINE question seeking information about one of the knowledge areas
2. If it is, classify which knowledge area it belongs to
3. If it IS a genuine substantive question but doesn't match any specific knowledge area, classify it as "general"

Available knowledge areas:
${areasDescription}
${channelContext}
CRITICAL: Only set is_question=true if ALL of these conditions are met:
1. The message is genuinely seeking information or help about the SUBSTANCE of the domain or a knowledge area
2. The question is about how things work, features, integrations, troubleshooting, etc.
3. The message would make sense to answer with documentation/FAQ content

Set is_question=false for:
- Meta-conversations (asking someone to ask questions, testing bots, requesting demos)
- Casual mentions of topic names without actually asking about them
- Messages that merely CONTAIN a keyword but aren't seeking information
- Social/conversational messages ("can you help me test this?", "ask some Qs about X")
- Questions about the bot itself rather than the knowledge domains
- Requests for someone else to do something (even if a topic is mentioned)
- Operational support requests asking someone to PERFORM an action on a specific account (toggle features, change settings, enable/disable functionality, investigate issues)
- Requests to intervene, modify, or take backend action for a customer
- Access or permission requests asking to be granted access to a tool, dashboard, or feature
- Bug reports or incident reports
- Troubleshooting requests for a specific customer's issue (these need engineering support, not FAQ answers)
- IMPORTANT: "How do I do X?" is a PROCESS question (is_question=true), NOT an action request. Only reject when someone is asking you to DO the action for them.

Additional rules:
- Carefully read each knowledge area's description to understand what topics it covers
- Match only if the question SUBSTANTIVELY relates to the knowledge area's domain
- If the question IS a genuine substantive question but doesn't fit any specific knowledge area, set product_area_id="general" (NOT null)
- If the question is NOT a genuine question at all (fails the is_question criteria), set product_area_id=null
- Set confidence based on how clearly the message is seeking genuine information
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 200,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: text }],
    output_format: {
      type: "json_schema",
      schema: CLASSIFICATION_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function selectKbPages(anthropic, model, questionText, hierarchy) {
  const indent = (depth) => "  ".repeat(depth - 1);
  const pageList = hierarchy
    .map((p) => `${indent(p.depth)}- [${p.pageId}] ${p.title}`)
    .join("\n");

  const system = `
You are a page-routing assistant for an internal knowledge base.
Given a user question and a list of KB sub-pages (with IDs and titles), select 1-3 pages whose content is most likely to answer the question.
If no page is relevant, return an empty selected_pages array.
Only use the page IDs provided — do not invent IDs.
`.trim();

  const user = `
QUESTION:
${questionText}

KB PAGES:
${pageList}
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 300,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: user }],
    output_format: {
      type: "json_schema",
      schema: KB_PAGE_SELECTION_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  const result = JSON.parse(raw);

  // Validate page IDs against the hierarchy
  const validIds = new Set(hierarchy.map((p) => p.pageId));
  result.selected_pages = (result.selected_pages || []).filter((p) => validIds.has(p.page_id));

  return result;
}

export async function askClaude(anthropic, model, { questionText, threadContext, faqContent, areaName }) {
  const system = `
You are FAQ Helper, an internal Slack bot for the "${areaName}" knowledge area.

You MUST follow these rules:
- Use ONLY the FAQ content provided in the user message. Do not use outside knowledge.
- Set answer_found_in_faq=true if the FAQ contains information that is RELEVANT and HELPFUL to the question, even if:
  - The wording is different
  - The FAQ explains the process rather than providing step-by-step instructions
  - The FAQ points to where to find more details
  - The FAQ covers a general category and the question asks about a specific item within it — share the general info and note what isn't explicitly confirmed
- Only set answer_found_in_faq=false if the FAQ truly has NO relevant information about the topic.
- If answer_found_in_faq=true, provide 1-3 evidence snippets from the FAQ that support your answer.
- Set needs_escalation=true when the FAQ covers PART of the question but has significant gaps that an owner should fill in.
- Set needs_escalation=false when the FAQ fully addresses the question.

Write answers in concise Slack mrkdwn. Bullets are welcome. Keep it practical.
`.trim();

  const user = `
SLACK QUESTION:
${questionText}

THREAD CONTEXT (may be empty):
${threadContext || "(none)"}

FAQ (source of truth):
${faqContent}
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 900,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: user }],
    output_format: {
      type: "json_schema",
      schema: ANSWER_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(raw);

  parsed.evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  parsed.follow_up_questions = Array.isArray(parsed.follow_up_questions) ? parsed.follow_up_questions : [];
  parsed.faq_topics = Array.isArray(parsed.faq_topics) ? parsed.faq_topics : [];
  parsed.answer = typeof parsed.answer === "string" ? parsed.answer : "";
  parsed.needs_escalation = parsed.needs_escalation === true;

  return parsed;
}

export async function synthesizeFaqEntry(anthropic, model, originalQuestion, ownerResponses, formatStyle) {
  const system = `
You are an FAQ writer. Given an original question and responses from knowledge area owners, synthesize a clear Q&A entry suitable for an FAQ document.

Rules:
- The question should be generalized (not specific to one person's situation)
- The answer should be comprehensive but concise
- Only set should_add_to_faq=true if this is generally useful knowledge (not a one-off edge case)
${formatStyle?.layout === "toggle"
    ? "\nThe existing FAQ mostly uses TOGGLE-style questions, where each question is a single line and the answer lives inside the toggle body. Write a concise, single-line question and an answer that will read naturally as the body of a toggle (no extra headings or repeated 'Q:'/'A:' prefixes)."
    : "\nThe existing FAQ mostly uses flat question headings with a following answer paragraph. Write a concise, single-line question suitable for a heading and an answer that will read naturally as the following paragraph (no repeated 'Q:'/'A:' prefixes)."}
`.trim();

  const user = `
ORIGINAL QUESTION:
${originalQuestion}

OWNER RESPONSES:
${ownerResponses.map((r, i) => `Response ${i + 1}: ${r}`).join("\n\n")}
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 600,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: user }],
    output_format: {
      type: "json_schema",
      schema: SYNTHESIS_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function checkResponsesSubstantive(anthropic, model, originalQuestion, ownerResponses) {
  const system = `
You are helping decide whether to update an internal FAQ based on a Slack thread.

Given the original question and the owners' responses, determine if there is at least ONE substantive answer that should be considered for the FAQ.

Definition of a NON-SUBSTANTIVE response (these do NOT justify an FAQ update on their own):
- Simple acknowledgments like "Got it", "Looking into this", "Thanks", emoji reactions, etc.
- Pure clarifying questions that only ask for more information but do not answer anything yet.
- Deflections like "Not sure", "Ask X", "We haven't decided yet", or similar non-answers.
- Responses that talk around the topic but never actually answer the original question.

Definition of a SUBSTANTIVE response:
- Provides a clear explanation, policy, behavior, limitation, or set of steps that directly addresses the original question.
- Contains information that would likely still be useful to someone else asking a similar question in the future.

Be strict: only mark has_substantive_answer=true when there is a clear, reusable answer.
`.trim();

  const user = `
ORIGINAL QUESTION:
${originalQuestion}

OWNER RESPONSES:
${ownerResponses.map((r, i) => `Response ${i + 1}: ${r}`).join("\n\n")}
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 300,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: user }],
    output_format: {
      type: "json_schema",
      schema: SUBSTANTIVE_CHECK_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function checkIfCorrection(anthropic, model, { originalQuestion, botAnswer, evidence, ownerReplies }) {
  const system = `
You are helping detect when knowledge area owners are correcting an FAQ-based answer from a bot.

The bot answered a question using content from the FAQ. One or more owners have replied in the thread.

Your job is to:
1. Analyze ALL the owner replies together (they may be having a conversation)
2. Determine if ANY owner is CORRECTING or DISAGREEING with the bot's answer
3. If there's a correction, synthesize the correct information from all owner responses

A reply IS a correction if:
- Any owner says the bot's answer is wrong, outdated, or incomplete
- Any owner provides different information that contradicts what the bot said
- Owners say "actually...", "that's not quite right...", "we changed this...", etc.
- Owners provide updated policies, processes, or facts that differ from the FAQ

A reply is NOT a correction if:
- Owners are only asking follow-up questions
- Owners are confirming/agreeing with the bot's answer
- Owners are adding supplementary context without contradicting anything
- Owners are thanking or acknowledging
- Owners are discussing among themselves without correcting the bot

If you determine there IS a correction:
1. Identify which part of the FAQ/answer appears to be wrong
2. Synthesize a suggested updated FAQ entry that incorporates ALL relevant corrections
3. If owners disagree with each other, note the disagreement but use the most recent/authoritative response
`.trim();

  const ownerRepliesFormatted = ownerReplies
    .map((r, i) => `Owner ${i + 1} (<@${r.userId}>): ${r.text}`)
    .join("\n\n");

  const user = `
ORIGINAL QUESTION:
${originalQuestion}

BOT'S ANSWER (based on FAQ):
${botAnswer}

FAQ EVIDENCE USED:
${evidence?.length ? evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none)"}

OWNER REPLIES (in chronological order):
${ownerRepliesFormatted || "(none)"}
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 800,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: user }],
    output_format: {
      type: "json_schema",
      schema: CORRECTION_CHECK_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function reviseSuggestedUpdate(anthropic, model, { originalQuestion, currentSuggestion, feedback }) {
  const system = `
You are revising a suggested FAQ update based on owner feedback.
The owner has reviewed a proposed FAQ change and requested modifications.
Incorporate their feedback precisely and return only the revised FAQ answer text.
Keep the same tone, level of detail, and format as the original suggestion.
Do not add commentary — return just the updated FAQ answer.
`.trim();

  const user = `
ORIGINAL QUESTION (for context):
${originalQuestion}

CURRENT SUGGESTED FAQ UPDATE:
${currentSuggestion}

OWNER FEEDBACK / REQUESTED CHANGES:
${feedback}
`.trim();

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: user }],
  });

  return (resp?.content?.[0]?.text ?? "").trim();
}

export async function analyzeThreadReply(anthropic, model, replyText, knowledgeAreas) {
  const areasDescription = knowledgeAreas
    .map((a) => {
      let desc = `- ID: "${a.id}"\n  Name: "${a.name}"`;
      if (a.description) desc += `\n  Description: ${a.description}`;
      if (a.keywords?.length) desc += `\n  Keywords: ${a.keywords.join(", ")}`;
      return desc;
    })
    .join("\n\n");

  const system = `
You are analyzing a Slack thread reply to determine if the person is a domain expert for one of our knowledge areas.

Available knowledge areas:
${areasDescription}

Your job:
1. Determine if this reply demonstrates deep, expert-level technical knowledge about a knowledge area (not just a casual opinion or simple acknowledgment).
2. Determine if the person explicitly self-identifies as an owner, lead, engineer, or expert for a knowledge area.
3. If either is true, fuzzy-match their expertise to the most relevant knowledge area ID.
4. Generate a short expertise description based on what they demonstrated knowledge of.

Examples of SUBSTANTIVE expert responses:
- Detailed technical explanations with specific implementation knowledge
- References to internal systems, pipelines, or architectural decisions

Examples of SELF-IDENTIFICATION:
- "I'm an engineer working on billing"
- "I'm a lead for the onboarding team"
- "I own the analytics product"

Examples of NON-expert responses (do NOT flag these):
- "Thanks for the info!"
- "I think someone mentioned this before"
- "Can you clarify what you mean?"
- Short opinions without technical depth
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 300,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: replyText }],
    output_format: {
      type: "json_schema",
      schema: THREAD_REPLY_ANALYSIS_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function selectRelevantLeads(anthropic, model, questionText, leads, areaName) {
  if (leads.length <= 2) {
    return leads.map((l) => l.userId);
  }

  const anyDescriptions = leads.some((l) => l.description && l.description.trim());
  if (!anyDescriptions) {
    return leads.map((l) => l.userId);
  }

  const leadsDescription = leads
    .map((l) => `- User ID: "${l.userId}"\n  Expertise: ${l.description || "(no description yet)"}`)
    .join("\n\n");

  const system = `
You are selecting which knowledge area leads to tag for an escalation question about the "${areaName}" knowledge area.

Available leads:
${leadsDescription}

Rules:
- Select 1-3 leads whose expertise descriptions are most relevant to the question being asked.
- If a lead has no description, they are a generalist — include them only if no other leads match well.
- If you're unsure who to tag, include all leads (it's better to over-tag than miss the right person).
- Always return at least 1 lead.
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 200,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: questionText }],
    output_format: {
      type: "json_schema",
      schema: LEAD_SELECTION_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  const result = JSON.parse(raw);

  const leadIdSet = new Set(leads.map((l) => l.userId));
  const validIds = (result.selected_user_ids || []).filter((id) => leadIdSet.has(id));

  return validIds.length > 0 ? validIds : leads.map((l) => l.userId);
}

export async function evolveExpertiseDescription(anthropic, model, currentDescription, responseText, areaName) {
  const system = `
You are updating an internal team member's expertise profile for the "${areaName}" knowledge area.

Their current expertise description:
${currentDescription || "(none — this is a new profile)"}

They just responded in a thread. Based on their response, update the expertise description to reflect what they know and work on.

Rules:
- Keep the description concise: 1-3 sentences max.
- Merge new evidence with the existing description — don't discard previous knowledge.
- Focus on specific topics, features, or sub-areas they demonstrated knowledge of.
- If the response doesn't reveal anything new about their expertise, set changed=false and return the existing description unchanged.
- Be factual, not speculative.
`.trim();

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 300,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: responseText }],
    output_format: {
      type: "json_schema",
      schema: DESCRIPTION_UPDATE_SCHEMA,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}

export async function parseDmIntent(anthropic, model, dmText, knowledgeAreas, senderIsLead) {
  const areasDescription = knowledgeAreas
    .map((a) => {
      let desc = `- ID: "${a.id}"\n  Name: "${a.name}"`;
      if (a.description) desc += `\n  Description: ${a.description}`;
      if (a.keywords?.length) desc += `\n  Keywords: ${a.keywords.join(", ")}`;
      const leadCount = (a.leads ?? []).length;
      const memberCount = (a.teamMembers ?? []).length;
      desc += `\n  Team: ${leadCount} lead(s), ${memberCount} team member(s)`;
      return desc;
    })
    .join("\n\n");

  const permissionNote = senderIsLead
    ? "This person IS a knowledge area lead, so they have permission to modify rosters and add knowledge areas."
    : "This person is NOT a lead. They can view the roster and self-register, but cannot modify rosters or add knowledge areas.";

  const intentEnum = ["view_roster", "modify_roster", "add_knowledge_area", "self_registration", "general"];

  const intentDescriptions = `
1. **view_roster** — They want to see who's on the team.
2. **modify_roster** — They want to add/remove/promote/demote someone on a team, or update someone's description.
3. **add_knowledge_area** — They want to create an entirely new knowledge area.
4. **self_registration** — They're telling you about themselves — their role, expertise, or knowledge area.
5. **general** — Anything else: questions about the bot, greetings, help requests, etc.`;

  const system = `
You are ${senderIsLead ? "Knowledge Bot" : "Knowledge Bot"}, an internal Slack bot. Someone has sent you a direct message.

${permissionNote}

Your available knowledge areas:
${areasDescription}

Classify the message into one of these intents:
${intentDescriptions}

Fuzzy-match area names and keywords.
For user mentions in Slack format like <@U12345>, extract the user ID into target_user_mentions.
For plain names like "Add John to Engineering", put "John" in target_user_names.

Write natural, friendly responses like a teammate. For actions, confirm what you understood.
${senderIsLead ? "" : "If they try to modify the roster or add a knowledge area, politely tell them only leads can do that."}
`.trim();

  // Use the schema but override the intent enum
  const schema = JSON.parse(JSON.stringify(DM_INTENT_SCHEMA));
  schema.properties.intent.enum = intentEnum;

  const resp = await anthropic.beta.messages.create({
    model,
    max_tokens: 600,
    betas: ["structured-outputs-2025-11-13"],
    system,
    messages: [{ role: "user", content: dmText }],
    output_format: {
      type: "json_schema",
      schema,
    },
  });

  const raw = resp?.content?.[0]?.text ?? "";
  return JSON.parse(raw);
}
