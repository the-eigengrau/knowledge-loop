/**
 * Utility functions for Slack operations and text processing.
 */

// Simple in-memory dedupe so you don't double-reply
const seen = new Map(); // key -> ms timestamp

export function splitCsv(v) {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function truncate(s, max = 900) {
  const t = s ?? "";
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export function looksLikeQuestion(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;

  if (t.includes("?")) return true;

  const starters = [
    "how",
    "how do",
    "how to",
    "what",
    "when",
    "where",
    "who",
    "why",
    "can ",
    "could ",
    "would ",
    "does ",
    "do ",
    "is ",
    "are ",
    "should ",
    "anyone know",
    "any idea",
    "do we",
    "does it",
    "is it",
  ];

  return starters.some((s) => t.startsWith(s));
}

export function alreadySeen(key, ttlMs = 5 * 60 * 1000) {
  const now = Date.now();

  for (const [k, ts] of seen.entries()) {
    if (now - ts > ttlMs) seen.delete(k);
  }

  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/**
 * Normalize smart/curly quotes to regular ASCII quotes.
 * Slack often auto-converts quotes when users type commands.
 */
export function normalizeQuotes(text) {
  return (text ?? "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

export async function resolveWatchChannels(client, watchChannelNames, logger = null) {
  const wanted = new Set(watchChannelNames.map((n) => n.replace(/^#/, "")));
  const found = new Map(); // name -> id
  const reverse = new Map(); // id -> name

  let cursor;
  do {
    const res = await client.conversations.list({
      limit: 500,
      cursor,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });

    for (const ch of res.channels ?? []) {
      if (!ch?.name || !ch?.id) continue;
      if (wanted.has(ch.name)) {
        found.set(ch.name, ch.id);
        reverse.set(ch.id, ch.name);
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const missing = [...wanted].filter((n) => !found.has(n));
  if (missing.length && logger) {
    logger.warn(
      `Could not resolve these channel names (make sure bot has channels:read/groups:read and is in the channel): ${missing.join(", ")}`
    );
  }

  return { channelIds: new Set([...found.values()]), idToName: reverse };
}

export async function initSlackIdentity(client) {
  const auth = await client.auth.test();
  return auth.user_id ?? null;
}

export async function fetchAllUsers(client) {
  const users = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    for (const u of res.members ?? []) {
      users.push(u);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return users;
}

export async function resolveUsersByName(client, names, logger = null) {
  const ids = [];

  let allUsers;
  try {
    allUsers = await fetchAllUsers(client);
    if (logger) logger.info(`[Users] Fetched ${allUsers.length} users from Slack`);
  } catch (err) {
    if (logger) logger.error(`[Users] Failed to fetch users: ${err?.message ?? err}`);
    return ids;
  }

  for (const name of names) {
    const wanted = name.toLowerCase().trim();
    if (!wanted) continue;

    if (/^U[A-Z0-9]+$/i.test(name.trim())) {
      ids.push(name.trim().toUpperCase());
      if (logger) logger.info(`[Users] "${name}" is already a user ID`);
      continue;
    }

    if (wanted.includes("@")) {
      try {
        const r = await client.users.lookupByEmail({ email: wanted });
        if (r?.user?.id) {
          ids.push(r.user.id);
          if (logger) logger.info(`[Users] Resolved "${name}" by email to ${r.user.id}`);
          continue;
        }
      } catch (err) {
        if (logger) logger.warn(`[Users] Email lookup failed for "${name}": ${err?.message ?? err}`);
      }
    }

    const candidates = allUsers
      .filter((u) => !u.deleted && !u.is_bot && u.id)
      .map((u) => ({
        id: u.id,
        real: (u.real_name ?? "").toLowerCase(),
        display: (u.profile?.display_name ?? "").toLowerCase(),
        name: (u.name ?? "").toLowerCase(),
      }));

    if (logger) logger.info(`[Users] Searching ${candidates.length} candidates for "${wanted}"`);

    const exact =
      candidates.find((u) => u.real === wanted) ||
      candidates.find((u) => u.display === wanted) ||
      candidates.find((u) => u.name === wanted);

    const partial =
      candidates.find((u) => u.real.includes(wanted)) ||
      candidates.find((u) => u.display.includes(wanted)) ||
      candidates.find((u) => u.name.includes(wanted));

    const match = exact ?? partial;
    if (match?.id) {
      ids.push(match.id);
      if (logger) logger.info(`[Users] Resolved "${name}" to ${match.id}`);
    } else {
      if (logger) {
        logger.warn(`[Users] Could not resolve user "${name}"`);
      }
    }
  }

  return [...new Set(ids)];
}

/**
 * Send a DM to a user
 */
export async function sendDmToUser(client, userId, message, logger = null) {
  try {
    const dmResult = await client.conversations.open({ users: userId });
    const dmChannelId = dmResult.channel?.id;

    if (!dmChannelId) {
      if (logger) logger.warn(`[DM] Failed to open DM channel with user ${userId}`);
      return false;
    }

    await client.chat.postMessage({
      channel: dmChannelId,
      text: message,
      mrkdwn: true,
    });

    if (logger) logger.info(`[DM] Sent DM to user ${userId}`);
    return true;
  } catch (err) {
    if (logger) logger.error(`[DM] Error sending DM to user ${userId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Fetch thread context for a message reply.
 */
export async function getThreadContext(client, event, logger = null) {
  if (!event.thread_ts || event.thread_ts === event.ts) return "";

  try {
    const res = await client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: 6,
      inclusive: true,
    });

    const msgs = (res.messages ?? [])
      .filter((m) => m && typeof m.text === "string" && m.text.trim())
      .slice(-6)
      .map((m) => {
        const who = m.user ? `<@${m.user}>` : m.bot_id ? "(bot)" : "(unknown)";
        return `${who}: ${truncate(m.text, 500)}`;
      });

    return msgs.join("\n");
  } catch (e) {
    if (logger) logger.warn(`Failed to fetch thread context: ${e?.message ?? e}`);
    return "";
  }
}
