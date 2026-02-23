import { Client } from "@notionhq/client";

let notion = null;

export function initNotion(apiKey) {
  notion = new Client({ auth: apiKey });
}

/**
 * Extract page ID from a Notion URL or return as-is if already an ID
 * Supports formats:
 * - https://www.notion.so/workspace/Page-Title-abc123def456...
 * - https://notion.so/Page-Title-abc123def456...
 * - abc123def456... (raw ID)
 */
export function extractPageId(urlOrId) {
  if (!urlOrId) return null;

  const str = urlOrId.trim();

  // If it looks like a raw ID (32 hex chars, possibly with dashes)
  const rawIdMatch = str.match(/^([a-f0-9]{32})$/i);
  if (rawIdMatch) return rawIdMatch[1];

  // If it has dashes (UUID format)
  const uuidMatch = str.match(/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, "");

  // Extract from URL - the ID is the last 32 hex chars before any query params
  const urlMatch = str.match(/([a-f0-9]{32})(?:\?|$)/i);
  if (urlMatch) return urlMatch[1];

  // Try extracting from URL with dashes
  const urlUuidMatch = str.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (urlUuidMatch) return urlUuidMatch[1].replace(/-/g, "");

  // Last resort: take the last segment after the last dash in the URL path
  const lastSegmentMatch = str.match(/-([a-f0-9]{32})(?:\?|$)/i);
  if (lastSegmentMatch) return lastSegmentMatch[1];

  return null;
}

/**
 * Fetch the hierarchy of sub-pages under a root KB page.
 * Returns a flat array of { pageId, title, depth, parentTitle }.
 */
export async function fetchKbHierarchy(rootPageUrl, logger = null, maxDepth = 3) {
  if (!notion) throw new Error("Notion client not initialized");

  const rootId = extractPageId(rootPageUrl);
  if (!rootId) throw new Error(`Invalid KB root page URL: ${rootPageUrl}`);

  if (logger) logger.info(`[Notion] Fetching KB hierarchy from root ${rootId.slice(0, 8)}...`);

  const results = [];

  async function crawl(parentId, parentTitle, depth) {
    if (depth > maxDepth) return;

    let cursor;
    try {
      do {
        const response = await notion.blocks.children.list({
          block_id: parentId,
          start_cursor: cursor,
          page_size: 100,
        });

        for (const block of response.results) {
          if (block.type === "child_page") {
            const title = block.child_page?.title || "Untitled";
            const pageId = block.id.replace(/-/g, "");
            results.push({ pageId, title, depth, parentTitle });
            // Recurse into sub-pages
            await crawl(block.id, title, depth + 1);
          }
        }

        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);
    } catch (err) {
      if (logger) {
        logger.error(`[Notion] Error crawling children of ${parentId.slice(0, 8)}: ${err?.message ?? err}`);
      }
    }
  }

  await crawl(rootId, null, 1);

  if (logger) logger.info(`[Notion] KB hierarchy: found ${results.length} sub-page(s)`);
  return results;
}

/**
 * Convert Notion block to markdown-like text
 */
function blockToText(block) {
  const type = block.type;
  const content = block[type];

  if (!content) return "";

  // Extract rich text
  const richText = content.rich_text || content.text || [];
  const text = richText.map((t) => t.plain_text || "").join("");

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "toggle":
      return `> ${text}`;
    case "callout":
      const emoji = content.icon?.emoji || "";
      return `${emoji} ${text}`;
    default:
      return text;
  }
}

/**
 * Fetch all blocks from a Notion page and convert to markdown text
 */
export async function fetchPageContent(pageId, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  const normalizedId = extractPageId(pageId);
  if (!normalizedId) throw new Error(`Invalid page ID: ${pageId}`);

  if (logger) logger.info(`[Notion] Fetching page content for page ID: ${normalizedId.slice(0, 8)}...`);

  const blocks = [];
  let cursor;
  let fetchCount = 0;

  try {
    do {
      const response = await notion.blocks.children.list({
        block_id: normalizedId,
        start_cursor: cursor,
        page_size: 100,
      });

      blocks.push(...response.results);
      fetchCount++;
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    if (logger) {
      logger.info(`[Notion] Fetched ${blocks.length} blocks from page (${fetchCount} API calls)`);
    }
  } catch (err) {
    if (logger) {
      logger.error(`[Notion] Error fetching page content: ${err?.message ?? err}`);
    }
    throw err;
  }

  // Convert blocks to text
  const lines = [];
  for (const block of blocks) {
    const text = blockToText(block);
    if (text) lines.push(text);

    // Handle nested blocks (children)
    if (block.has_children) {
      try {
        const childContent = await fetchPageContent(block.id, logger);
        if (childContent) {
          // Indent child content
          const indented = childContent
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n");
          lines.push(indented);
        }
      } catch {
        // Skip if we can't fetch children
      }
    }
  }

  const content = lines.join("\n\n");
  if (logger) {
    logger.info(`[Notion] Converted page to text: ${content.length} characters`);
  }

  return content;
}

/**
 * Analyze the overall structure of a Notion FAQ page so we can match its format
 * when appending new entries (e.g., toggle list vs flat heading list).
 *
 * Returns a lightweight description of the existing style:
 * {
 *   layout: "toggle" | "flat",
 *   questionBlockType: "heading_2" | "heading_3" | "toggle",
 *   answerBlockType: "paragraph" | "toggle_child",
 *   questionPrefix: string, // usually "Q: "
 *   answerPrefix: string,   // usually "A: "
 * }
 */
export async function analyzePageStructure(pageId, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  const normalizedId = extractPageId(pageId);
  if (!normalizedId) throw new Error(`Invalid page ID: ${pageId}`);

  if (logger) {
    logger.info(`[Notion] Analyzing FAQ page structure for ${normalizedId.slice(0, 8)}...`);
  }

  const blocks = [];
  let cursor;

  try {
    do {
      const response = await notion.blocks.children.list({
        block_id: normalizedId,
        start_cursor: cursor,
        page_size: 100,
      });

      blocks.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);
  } catch (err) {
    if (logger) {
      logger.error(`[Notion] Error analyzing page structure: ${err?.message ?? err}`);
    }
    // Fall back to defaults if analysis fails
    return {
      layout: "flat",
      questionBlockType: "heading_3",
      answerBlockType: "paragraph",
      questionPrefix: "Q: ",
      answerPrefix: "A: ",
    };
  }

  const defaultStyle = {
    layout: "flat",
    questionBlockType: "heading_3",
    answerBlockType: "paragraph",
    questionPrefix: "Q: ",
    answerPrefix: "A: ",
  };

  if (!blocks.length) {
    return defaultStyle;
  }

  function getTextFromBlock(block) {
    const type = block.type;
    const content = block[type];
    if (!content) return "";
    const richText = content.rich_text || content.text || [];
    return richText.map((t) => t.plain_text || "").join("").trim();
  }

  let layout = "flat";
  let questionBlockType = defaultStyle.questionBlockType;
  let answerBlockType = defaultStyle.answerBlockType;
  let questionPrefix = defaultStyle.questionPrefix;
  let answerPrefix = defaultStyle.answerPrefix;

  // Look from the bottom up to find the most recent Q&A-looking pattern
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    const text = getTextFromBlock(block);
    if (!text) continue;

    const isQuestionish = /^q[:\s]/i.test(text) || /^question[:\s]/i.test(text);

    if (block.type === "toggle" && isQuestionish) {
      layout = "toggle";
      questionBlockType = "toggle";
      answerBlockType = "toggle_child";
      // Try to preserve the prefix that appears in the toggle text
      if (/^q[:]/i.test(text)) {
        questionPrefix = text.match(/^q[:]\s*/i)?.[0] ?? questionPrefix;
      }
      break;
    }

    if (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3") {
      if (isQuestionish) {
        questionBlockType = block.type;
        // Look ahead for the next non-divider block as the answer
        for (let j = i + 1; j < blocks.length; j += 1) {
          const next = blocks[j];
          if (!next || next.type === "divider") continue;
          const nextText = getTextFromBlock(next);
          if (!nextText) continue;
          if (/^a[:\s]/i.test(nextText) || /^answer[:\s]/i.test(nextText)) {
            answerBlockType = next.type === "paragraph" ? "paragraph" : answerBlockType;
            if (/^a[:]/i.test(nextText)) {
              answerPrefix = nextText.match(/^a[:]\s*/i)?.[0] ?? answerPrefix;
            }
          }
          break;
        }
        break;
      }
    }
  }

  const style = {
    layout,
    questionBlockType,
    answerBlockType,
    questionPrefix,
    answerPrefix,
  };

  if (logger) {
    logger.info(
      `[Notion] FAQ style: layout=${style.layout}, questionBlockType=${style.questionBlockType}, answerBlockType=${style.answerBlockType}, questionPrefix="${style.questionPrefix}", answerPrefix="${style.answerPrefix}"`
    );
  }

  return style;
}

/**
 * Append a new Q&A entry to a Notion page
 * Returns the URL to the newly created block
 */
export async function appendFaqEntry(pageId, question, answer, formatStyle = null, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  const normalizedId = extractPageId(pageId);
  if (!normalizedId) throw new Error(`Invalid page ID: ${pageId}`);

  if (logger) {
    logger.info(`[Notion] Appending FAQ entry to page ${normalizedId.slice(0, 8)}...`);
    logger.info(`[Notion] Question: ${question.substring(0, 100)}${question.length > 100 ? "..." : ""}`);
    logger.info(`[Notion] Answer length: ${answer.length} characters`);
  }

  const style = {
    layout: formatStyle?.layout || "flat",
    questionBlockType: formatStyle?.questionBlockType || "heading_3",
    answerBlockType: formatStyle?.answerBlockType || "paragraph",
    questionPrefix: typeof formatStyle?.questionPrefix === "string" ? formatStyle.questionPrefix : "Q: ",
    answerPrefix: typeof formatStyle?.answerPrefix === "string" ? formatStyle.answerPrefix : "A: ",
  };

  // Create blocks for the Q&A
  const blocks = [];

  // Always add a divider before new entries to avoid disturbing existing content
  blocks.push({
    object: "block",
    type: "divider",
    divider: {},
  });

  if (style.layout === "toggle") {
    // Question as a toggle, answer lives inside the toggle children
    blocks.push({
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: [
          {
            type: "text",
            text: { content: `${style.questionPrefix}${question}` },
          },
        ],
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: { content: `${style.answerPrefix}${answer}` },
                },
              ],
            },
          },
        ],
      },
    });
  } else {
    // Flat layout: heading + paragraph
    const headingType =
      style.questionBlockType === "heading_1" ||
      style.questionBlockType === "heading_2" ||
      style.questionBlockType === "heading_3"
        ? style.questionBlockType
        : "heading_3";

    blocks.push({
      object: "block",
      type: headingType,
      [headingType]: {
        rich_text: [
          {
            type: "text",
            text: { content: `${style.questionPrefix}${question}` },
          },
        ],
      },
    });

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: `${style.answerPrefix}${answer}` },
          },
        ],
      },
    });
  }

  try {
    const response = await notion.blocks.children.append({
      block_id: normalizedId,
      children: blocks,
    });

    // Get the heading block ID for the link
    const headingBlock = response.results.find((b) => b.type === "heading_3");
    const blockId = headingBlock?.id || response.results[0]?.id;

    // Construct the URL to the block
    // Format: https://notion.so/page-id#block-id
    const blockIdForUrl = blockId?.replace(/-/g, "");
    const pageIdForUrl = normalizedId.replace(/-/g, "");

    const faqUrl = `https://notion.so/${pageIdForUrl}#${blockIdForUrl}`;

    if (logger) {
      logger.info(`[Notion] Successfully appended FAQ entry. URL: ${faqUrl}`);
    }

    return faqUrl;
  } catch (err) {
    if (logger) {
      logger.error(`[Notion] Error appending FAQ entry: ${err?.message ?? err}`);
    }
    throw err;
  }
}

/**
 * Get page title for display purposes
 */
export async function getPageTitle(pageId, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  const normalizedId = extractPageId(pageId);
  if (!normalizedId) throw new Error(`Invalid page ID: ${pageId}`);

  try {
    if (logger) logger.info(`[Notion] Fetching page title for ${normalizedId.slice(0, 8)}...`);
    const page = await notion.pages.retrieve({ page_id: normalizedId });

    // Title can be in different property types
    const titleProp =
      page.properties?.title ||
      page.properties?.Name ||
      Object.values(page.properties || {}).find((p) => p.type === "title");

    if (titleProp?.title?.[0]?.plain_text) {
      return titleProp.title[0].plain_text;
    }

    return "Untitled";
  } catch {
    return "Unknown Page";
  }
}

/**
 * Extract text content from a block
 */
function getBlockText(block) {
  const type = block.type;
  const content = block[type];
  if (!content) return "";
  const richText = content.rich_text || content.text || [];
  return richText.map((t) => t.plain_text || "").join("");
}

/**
 * Normalize text for comparison (lowercase, collapse whitespace)
 */
function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find a block in a Notion page by matching its content against search text.
 * Returns the block ID and URL if found.
 * 
 * @param {string} pageId - The Notion page ID or URL
 * @param {string[]} searchTexts - Array of text snippets to search for (e.g., evidence from FAQ answer)
 * @param {object} logger - Optional logger
 * @returns {Promise<{blockId: string, blockUrl: string, matchedText: string} | null>}
 */
export async function findBlockByContent(pageId, searchTexts, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  const normalizedPageId = extractPageId(pageId);
  if (!normalizedPageId) throw new Error(`Invalid page ID: ${pageId}`);

  if (!searchTexts || searchTexts.length === 0) {
    if (logger) logger.warn(`[Notion] No search texts provided for findBlockByContent`);
    return null;
  }

  if (logger) {
    logger.info(`[Notion] Searching for blocks in page ${normalizedPageId.slice(0, 8)}...`);
    logger.info(`[Notion] Search texts: ${searchTexts.length} snippet(s)`);
  }

  // Normalize search texts for comparison
  const normalizedSearchTexts = searchTexts.map(normalizeText).filter(Boolean);
  if (normalizedSearchTexts.length === 0) {
    if (logger) logger.warn(`[Notion] All search texts were empty after normalization`);
    return null;
  }

  // Fetch all blocks from the page
  const blocks = [];
  let cursor;

  try {
    do {
      const response = await notion.blocks.children.list({
        block_id: normalizedPageId,
        start_cursor: cursor,
        page_size: 100,
      });

      blocks.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    if (logger) {
      logger.info(`[Notion] Fetched ${blocks.length} blocks to search`);
    }
  } catch (err) {
    if (logger) {
      logger.error(`[Notion] Error fetching blocks for search: ${err?.message ?? err}`);
    }
    return null;
  }

  // Search through blocks for a match
  let bestMatch = null;
  let bestMatchScore = 0;

  for (const block of blocks) {
    const blockText = getBlockText(block);
    if (!blockText) continue;

    const normalizedBlockText = normalizeText(blockText);

    for (const searchText of normalizedSearchTexts) {
      // Check if the block contains the search text
      if (normalizedBlockText.includes(searchText)) {
        // Score based on how much of the block is the search text (higher = better match)
        const score = searchText.length / normalizedBlockText.length;
        
        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestMatch = {
            blockId: block.id,
            blockType: block.type,
            matchedText: blockText,
            searchText: searchText,
          };
        }
      }
    }

    // Also check children if the block has them (for toggle blocks, etc.)
    if (block.has_children) {
      try {
        const childResult = await findBlockByContent(block.id, searchTexts, null); // Don't log recursively
        if (childResult) {
          // If we found a match in children, return the parent block instead
          // (comments work better on parent blocks)
          const childScore = 0.9; // Slightly lower priority than direct match
          if (childScore > bestMatchScore) {
            bestMatchScore = childScore;
            bestMatch = {
              blockId: block.id,
              blockType: block.type,
              matchedText: childResult.matchedText,
              searchText: childResult.searchText,
            };
          }
        }
      } catch {
        // Skip if we can't search children
      }
    }
  }

  if (!bestMatch) {
    if (logger) {
      logger.warn(`[Notion] No matching block found for any of the search texts`);
    }
    return null;
  }

  // Construct the URL to the block
  const blockIdForUrl = bestMatch.blockId.replace(/-/g, "");
  const pageIdForUrl = normalizedPageId.replace(/-/g, "");
  const blockUrl = `https://notion.so/${pageIdForUrl}#${blockIdForUrl}`;

  if (logger) {
    logger.info(`[Notion] Found matching block: ${bestMatch.blockId} (type: ${bestMatch.blockType})`);
    logger.info(`[Notion] Block URL: ${blockUrl}`);
  }

  return {
    blockId: bestMatch.blockId,
    blockUrl,
    matchedText: bestMatch.matchedText,
  };
}

/**
 * Update an existing FAQ block's answer content in-place.
 * For toggle blocks: replaces all children with new paragraph block(s).
 * For other blocks (paragraph, etc.): replaces the block's rich_text directly.
 *
 * @param {string} blockId - The block ID to update
 * @param {string} newText - The new answer text
 * @param {object} logger - Optional logger
 * @returns {Promise<string>} The block URL
 */
export async function updateFaqBlock(blockId, newText, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");
  if (!blockId) throw new Error("No block ID provided");

  if (logger) {
    logger.info(`[Notion] Updating FAQ block ${blockId.slice(0, 8)}...`);
    logger.info(`[Notion] New text length: ${newText.length} characters`);
  }

  const block = await notion.blocks.retrieve({ block_id: blockId });

  if (block.type === "toggle") {
    // Delete existing children, then append new ones
    const children = [];
    let cursor;
    do {
      const res = await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
      children.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    if (logger) {
      logger.info(`[Notion] Deleting ${children.length} existing child block(s) from toggle`);
    }

    for (const child of children) {
      await notion.blocks.delete({ block_id: child.id });
    }

    const paragraphs = newText.split(/\n\n+/).filter(Boolean);
    const newChildren = paragraphs.map((p) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: p } }],
      },
    }));

    await notion.blocks.children.append({
      block_id: blockId,
      children: newChildren,
    });
  } else {
    // Directly update the block's rich text (paragraph, bulleted_list_item, etc.)
    const blockType = block.type;
    await notion.blocks.update({
      block_id: blockId,
      [blockType]: {
        rich_text: [{ type: "text", text: { content: newText } }],
      },
    });
  }

  // Construct the block URL. We need the parent page ID for the full URL.
  const rawBlockId = blockId.replace(/-/g, "");
  let pageIdForUrl = "";
  if (block.parent?.type === "page_id") {
    pageIdForUrl = block.parent.page_id.replace(/-/g, "");
  } else if (block.parent?.type === "block_id") {
    // Nested block — try to get grandparent page
    try {
      const parentBlock = await notion.blocks.retrieve({ block_id: block.parent.block_id });
      if (parentBlock.parent?.type === "page_id") {
        pageIdForUrl = parentBlock.parent.page_id.replace(/-/g, "");
      }
    } catch {
      // Fall back to just the block ID
    }
  }

  const blockUrl = pageIdForUrl
    ? `https://notion.so/${pageIdForUrl}#${rawBlockId}`
    : `https://notion.so/${rawBlockId}`;

  if (logger) {
    logger.info(`[Notion] Successfully updated FAQ block. URL: ${blockUrl}`);
  }

  return blockUrl;
}

/**
 * Add a comment to a Notion block using the Comments API.
 * Note: The Notion integration must have "Insert comments" capability enabled.
 * 
 * @param {string} blockId - The block ID to comment on (can include dashes)
 * @param {string} commentText - The comment text to add
 * @param {object} logger - Optional logger
 * @returns {Promise<{commentId: string, discussionId: string} | null>}
 */
export async function addCommentToBlock(blockId, commentText, logger = null) {
  if (!notion) throw new Error("Notion client not initialized");

  if (!blockId) {
    if (logger) logger.warn(`[Notion] No block ID provided for comment`);
    return null;
  }

  if (!commentText || !commentText.trim()) {
    if (logger) logger.warn(`[Notion] No comment text provided`);
    return null;
  }

  // Normalize block ID (remove dashes if present)
  const normalizedBlockId = blockId.includes("-") ? blockId : blockId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

  if (logger) {
    logger.info(`[Notion] Adding comment to block ${blockId.slice(0, 8)}...`);
    logger.info(`[Notion] Comment preview: ${commentText.substring(0, 100)}${commentText.length > 100 ? "..." : ""}`);
  }

  try {
    const response = await notion.comments.create({
      parent: { block_id: normalizedBlockId },
      rich_text: [
        {
          type: "text",
          text: { content: commentText },
        },
      ],
    });

    if (logger) {
      logger.info(`[Notion] Successfully added comment: ${response.id}`);
    }

    return {
      commentId: response.id,
      discussionId: response.discussion_id,
    };
  } catch (err) {
    if (logger) {
      logger.error(`[Notion] Error adding comment to block: ${err?.message ?? err}`);
      // Provide helpful context for common errors
      if (err?.code === "unauthorized") {
        logger.error(`[Notion] Make sure the integration has "Insert comments" capability enabled`);
      }
    }
    throw err;
  }
}
