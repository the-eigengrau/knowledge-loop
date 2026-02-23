import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Seed config: git-tracked, defines area structure (name, description, notion, keywords, seedLeadUserIds)
const CONFIG_PATH = path.join(__dirname, "config", "knowledge-areas.json");
const LEGACY_CONFIG_PATH = path.join(__dirname, "config", "product-areas.json");

// Runtime roster: gitignored, stores learned leads/teamMembers with descriptions
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ROSTER_PATH = path.join(DATA_DIR, "team-roster.json");

// In-memory merged state — what the rest of the app sees
let knowledgeAreas = { areas: [] };

// Raw stores for separate persistence
let seedConfig = { areas: [] };
let roster = {}; // { [areaId]: { leads: [...], teamMembers: [...] } }

function generateId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${slug}-${suffix}`;
}

/**
 * Recompute the derived ownerUserIds field from leads + teamMembers.
 */
function recomputeOwnerUserIds(area) {
  const ids = new Set();
  for (const m of area.leads ?? []) ids.add(m.userId);
  for (const m of area.teamMembers ?? []) ids.add(m.userId);
  area.ownerUserIds = [...ids];
}

/**
 * Bootstrap a roster entry from seed lead user IDs.
 */
function bootstrapRosterEntry(seedLeadUserIds, createdAt) {
  const now = createdAt ?? new Date().toISOString();
  return {
    leads: (seedLeadUserIds || []).map((userId) => ({
      userId,
      description: "",
      addedAt: now,
      lastActiveAt: now,
    })),
    teamMembers: [],
  };
}

/**
 * Merge seed config + roster into a single in-memory knowledgeAreas object.
 * Only areas present in seed config appear in the merged result.
 */
function mergeConfigAndRoster(logger = null) {
  const merged = [];

  for (const seed of seedConfig.areas) {
    const rosterEntry = roster[seed.id];

    const area = {
      id: seed.id,
      name: seed.name,
      description: seed.description || "",
      notionPageId: seed.notionPageId,
      keywords: seed.keywords || [],
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt,
    };

    if (rosterEntry) {
      area.leads = rosterEntry.leads || [];
      area.teamMembers = rosterEntry.teamMembers || [];
    } else {
      const entry = bootstrapRosterEntry(seed.seedLeadUserIds, seed.createdAt);
      area.leads = entry.leads;
      area.teamMembers = entry.teamMembers;
      roster[seed.id] = entry;
      if (logger) {
        logger.info(`[Config] Bootstrapped roster for "${seed.name}" from ${(seed.seedLeadUserIds || []).length} seed lead(s)`);
      }
    }

    recomputeOwnerUserIds(area);
    merged.push(area);
  }

  // Warn about orphaned roster entries (area removed from seed but roster data remains)
  for (const areaId of Object.keys(roster)) {
    if (!seedConfig.areas.some((s) => s.id === areaId)) {
      if (logger) {
        logger.warn(`[Config] Orphaned roster entry for area ID "${areaId}" (not in seed config)`);
      }
    }
  }

  knowledgeAreas = { areas: merged };
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function ensureDataDir() {
  const dir = path.dirname(ROSTER_PATH);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Save the roster file (data/team-roster.json).
 * Called by all team-mutating operations.
 */
async function saveRoster(logger = null) {
  // Sync in-memory area state back to the roster object
  for (const area of knowledgeAreas.areas) {
    roster[area.id] = {
      leads: area.leads || [],
      teamMembers: area.teamMembers || [],
    };
    recomputeOwnerUserIds(area);
  }

  await ensureDataDir();
  await fs.writeFile(ROSTER_PATH, JSON.stringify(roster, null, 2), "utf8");
  if (logger) {
    logger.info(`[Roster] Saved roster for ${Object.keys(roster).length} area(s) to ${ROSTER_PATH}`);
  }
}

/**
 * Save the seed config file (src/config/knowledge-areas.json).
 * Called by structural CRUD ops (add/remove/update area properties).
 */
async function saveConfig(logger = null) {
  // Sync in-memory area state back to seed config (only seed-level fields)
  seedConfig.areas = knowledgeAreas.areas.map((area) => ({
    id: area.id,
    name: area.name,
    description: area.description || "",
    notionPageId: area.notionPageId,
    seedLeadUserIds: (area.leads || []).map((m) => m.userId),
    keywords: area.keywords || [],
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
  }));

  await fs.writeFile(CONFIG_PATH, JSON.stringify(seedConfig, null, 2), "utf8");
  if (logger) {
    logger.info(`[Config] Saved ${seedConfig.areas.length} knowledge area(s) to ${CONFIG_PATH}`);
  }
}

/**
 * Legacy save — writes both config and roster. Used during migration.
 */
export async function saveKnowledgeAreas(logger = null) {
  await saveConfig(logger);
  await saveRoster(logger);
}

// ─── Loading & Migration ────────────────────────────────────────────────────

/**
 * Detect and perform first-run migration:
 * If the config file has leads/teamMembers data (from the pre-split format),
 * extract that into the roster and strip the config back to seed-only.
 */
async function migrateIfNeeded(logger = null) {
  let needsMigration = false;

  for (const seed of seedConfig.areas) {
    // If the config still has the old leads/teamMembers/ownerUserIds fields, migrate them
    if (Array.isArray(seed.leads) || Array.isArray(seed.teamMembers) || Array.isArray(seed.ownerUserIds)) {
      needsMigration = true;
      break;
    }
  }

  if (!needsMigration) return false;

  if (logger) {
    logger.info(`[Migration] Detected pre-split config format, migrating leads/teamMembers to roster...`);
  }

  for (const seed of seedConfig.areas) {
    // Build roster entry from existing data
    let leads = [];
    let teamMembers = [];

    if (Array.isArray(seed.leads)) {
      leads = seed.leads;
    } else if (Array.isArray(seed.ownerUserIds)) {
      // Very old format: flat ownerUserIds
      const now = new Date().toISOString();
      leads = seed.ownerUserIds.map((userId) => ({
        userId,
        description: "",
        addedAt: seed.createdAt ?? now,
        lastActiveAt: now,
      }));
    }

    if (Array.isArray(seed.teamMembers)) {
      teamMembers = seed.teamMembers;
    }

    // Only write to roster if there's actual data to preserve
    if (leads.length > 0 || teamMembers.length > 0) {
      roster[seed.id] = { leads, teamMembers };
      if (logger) {
        logger.info(`[Migration] Migrated "${seed.name}": ${leads.length} lead(s), ${teamMembers.length} team member(s)`);
      }
    }

    // Derive seedLeadUserIds from the leads
    seed.seedLeadUserIds = leads.map((m) => m.userId);

    // Strip runtime fields from the seed
    delete seed.leads;
    delete seed.teamMembers;
    delete seed.ownerUserIds;
  }

  // Persist both files
  await fs.writeFile(CONFIG_PATH, JSON.stringify(seedConfig, null, 2), "utf8");
  await ensureDataDir();
  await fs.writeFile(ROSTER_PATH, JSON.stringify(roster, null, 2), "utf8");

  if (logger) {
    logger.info(`[Migration] Migration complete. Seed config and roster files written.`);
  }

  return true;
}

/**
 * Load knowledge areas from disk (seed config + roster), merge into memory.
 * Migration fallback: if knowledge-areas.json doesn't exist but product-areas.json does, copy it.
 */
export async function loadKnowledgeAreas(logger = null) {
  // 1. Load seed config, with fallback to legacy product-areas.json
  let configLoaded = false;

  try {
    const data = await fs.readFile(CONFIG_PATH, "utf8");
    seedConfig = JSON.parse(data);
    if (!Array.isArray(seedConfig.areas)) {
      seedConfig.areas = [];
    }
    configLoaded = true;
    if (logger) {
      logger.info(`[Config] Loaded ${seedConfig.areas.length} knowledge area(s) from seed config`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      // knowledge-areas.json doesn't exist — try migrating from product-areas.json
      try {
        const legacyData = await fs.readFile(LEGACY_CONFIG_PATH, "utf8");
        seedConfig = JSON.parse(legacyData);
        if (!Array.isArray(seedConfig.areas)) {
          seedConfig.areas = [];
        }
        // Write it as the new knowledge-areas.json
        await fs.writeFile(CONFIG_PATH, JSON.stringify(seedConfig, null, 2), "utf8");
        configLoaded = true;
        if (logger) {
          logger.info(`[Migration] Migrated ${seedConfig.areas.length} area(s) from product-areas.json → knowledge-areas.json`);
        }
      } catch (legacyErr) {
        if (legacyErr.code === "ENOENT") {
          // Neither file exists — fresh install
          seedConfig = { areas: [] };
          await fs.writeFile(CONFIG_PATH, JSON.stringify(seedConfig, null, 2), "utf8");
          configLoaded = true;
          if (logger) {
            logger.info(`[Config] Created new seed config at ${CONFIG_PATH}`);
          }
        } else {
          if (logger) logger.error(`[Config] Error loading legacy config: ${legacyErr?.message ?? legacyErr}`);
          throw legacyErr;
        }
      }
    } else {
      if (logger) logger.error(`[Config] Error loading seed config: ${err?.message ?? err}`);
      throw err;
    }
  }

  // 2. Run migration if the config still has old-format leads/teamMembers
  await migrateIfNeeded(logger);

  // 3. Load roster
  try {
    const data = await fs.readFile(ROSTER_PATH, "utf8");
    roster = JSON.parse(data);
    if (typeof roster !== "object" || Array.isArray(roster)) {
      roster = {};
    }
    if (logger) {
      logger.info(`[Roster] Loaded roster with ${Object.keys(roster).length} area(s) from ${ROSTER_PATH}`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      roster = {};
      if (logger) {
        logger.info(`[Roster] No roster file found, will bootstrap from seed config`);
      }
    } else {
      if (logger) logger.error(`[Roster] Error loading roster: ${err?.message ?? err}`);
      throw err;
    }
  }

  // 4. Merge
  mergeConfigAndRoster(logger);

  // 5. Save roster if we bootstrapped any new entries
  await saveRoster(logger);

  if (logger) {
    logger.info(`[Config] Merged ${knowledgeAreas.areas.length} knowledge area(s) into memory`);
  }

  return knowledgeAreas;
}

// ─── Read helpers ───────────────────────────────────────────────────────────

export function getAllKnowledgeAreas() {
  return [...knowledgeAreas.areas];
}

export function getKnowledgeAreaById(id) {
  return knowledgeAreas.areas.find((a) => a.id === id) || null;
}

export function getKnowledgeAreaByName(name) {
  const lower = name.toLowerCase();
  return knowledgeAreas.areas.find((a) => a.name.toLowerCase() === lower) || null;
}

// ─── Lead / Team Member helpers ─────────────────────────────────────────────

export function getLeadUserIds(areaId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return [];
  return (area.leads ?? []).map((m) => m.userId);
}

export function getAllMemberUserIds(areaId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return [];
  return [...(area.leads ?? []).map((m) => m.userId), ...(area.teamMembers ?? []).map((m) => m.userId)];
}

export function getLeads(areaId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return [];
  return [...(area.leads ?? [])];
}

export function getTeamMembers(areaId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return [];
  return [...(area.teamMembers ?? [])];
}

export function isLeadForAnyArea(userId) {
  for (const area of knowledgeAreas.areas) {
    if ((area.leads ?? []).some((m) => m.userId === userId)) return area;
  }
  return null;
}

export function isTeamMemberForAnyArea(userId) {
  for (const area of knowledgeAreas.areas) {
    if ((area.leads ?? []).some((m) => m.userId === userId)) return area;
    if ((area.teamMembers ?? []).some((m) => m.userId === userId)) return area;
  }
  return null;
}

export function isTeamMemberForArea(userId, areaId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return false;
  return (
    (area.leads ?? []).some((m) => m.userId === userId) ||
    (area.teamMembers ?? []).some((m) => m.userId === userId)
  );
}

export function getMember(areaId, userId) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return null;
  return (
    (area.leads ?? []).find((m) => m.userId === userId) ||
    (area.teamMembers ?? []).find((m) => m.userId === userId) ||
    null
  );
}

// ─── Team-mutating operations (write to roster only) ────────────────────────

export async function addLead(areaId, userId, description = "", logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  if (!Array.isArray(area.leads)) area.leads = [];
  if (!Array.isArray(area.teamMembers)) area.teamMembers = [];

  if (area.leads.some((m) => m.userId === userId)) {
    if (logger) logger.info(`[Roster] User ${userId} is already a lead for "${area.name}"`);
    return area;
  }

  area.teamMembers = area.teamMembers.filter((m) => m.userId !== userId);

  const now = new Date().toISOString();
  area.leads.push({
    userId,
    description: (description || "").trim(),
    addedAt: now,
    lastActiveAt: now,
  });

  area.updatedAt = now;
  await saveRoster(logger);

  if (logger) {
    logger.info(`[Roster] Added lead ${userId} to "${area.name}" (description: "${description || "(none)"}")`);
  }
  return area;
}

export async function addTeamMember(areaId, userId, description = "", addedBy = "auto", logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  if (!Array.isArray(area.leads)) area.leads = [];
  if (!Array.isArray(area.teamMembers)) area.teamMembers = [];

  if (area.leads.some((m) => m.userId === userId)) {
    if (logger) logger.info(`[Roster] User ${userId} is already a lead for "${area.name}", not adding as team member`);
    return area;
  }
  if (area.teamMembers.some((m) => m.userId === userId)) {
    if (logger) logger.info(`[Roster] User ${userId} is already a team member for "${area.name}"`);
    return area;
  }

  const now = new Date().toISOString();
  area.teamMembers.push({
    userId,
    description: (description || "").trim(),
    addedBy,
    addedAt: now,
    lastActiveAt: now,
  });

  area.updatedAt = now;
  await saveRoster(logger);

  if (logger) {
    logger.info(`[Roster] Added team member ${userId} to "${area.name}" (by: ${addedBy}, description: "${description || "(none)"}")`);
  }
  return area;
}

export async function removeMember(areaId, userId, logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  const leadsBefore = (area.leads ?? []).length;
  const teamBefore = (area.teamMembers ?? []).length;

  area.leads = (area.leads ?? []).filter((m) => m.userId !== userId);
  area.teamMembers = (area.teamMembers ?? []).filter((m) => m.userId !== userId);

  const removed = (leadsBefore - area.leads.length) + (teamBefore - area.teamMembers.length);
  if (removed > 0) {
    area.updatedAt = new Date().toISOString();
    await saveRoster(logger);
    if (logger) logger.info(`[Roster] Removed member ${userId} from "${area.name}"`);
  }
  return removed > 0;
}

export async function promoteToLead(areaId, userId, logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  if ((area.leads ?? []).some((m) => m.userId === userId)) {
    if (logger) logger.info(`[Roster] User ${userId} is already a lead for "${area.name}"`);
    return area;
  }

  const existing = (area.teamMembers ?? []).find((m) => m.userId === userId);
  if (!existing) {
    throw new Error(`User ${userId} is not a team member for "${area.name}"`);
  }

  area.teamMembers = area.teamMembers.filter((m) => m.userId !== userId);
  if (!Array.isArray(area.leads)) area.leads = [];
  area.leads.push({
    userId: existing.userId,
    description: existing.description || "",
    addedAt: existing.addedAt,
    lastActiveAt: new Date().toISOString(),
  });

  area.updatedAt = new Date().toISOString();
  await saveRoster(logger);
  if (logger) logger.info(`[Roster] Promoted ${userId} from team member to lead for "${area.name}"`);
  return area;
}

export async function demoteToTeamMember(areaId, userId, logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  const existing = (area.leads ?? []).find((m) => m.userId === userId);
  if (!existing) {
    throw new Error(`User ${userId} is not a lead for "${area.name}"`);
  }

  area.leads = area.leads.filter((m) => m.userId !== userId);
  if (!Array.isArray(area.teamMembers)) area.teamMembers = [];
  area.teamMembers.push({
    userId: existing.userId,
    description: existing.description || "",
    addedBy: "demoted",
    addedAt: existing.addedAt,
    lastActiveAt: new Date().toISOString(),
  });

  area.updatedAt = new Date().toISOString();
  await saveRoster(logger);
  if (logger) logger.info(`[Roster] Demoted ${userId} from lead to team member for "${area.name}"`);
  return area;
}

export async function updateMemberDescription(areaId, userId, description, logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) throw new Error(`Knowledge area with ID "${areaId}" not found`);

  let member = (area.leads ?? []).find((m) => m.userId === userId);
  if (!member) member = (area.teamMembers ?? []).find((m) => m.userId === userId);
  if (!member) throw new Error(`User ${userId} is not a member of "${area.name}"`);

  const oldDesc = member.description;
  member.description = (description || "").trim();
  member.lastActiveAt = new Date().toISOString();

  area.updatedAt = new Date().toISOString();
  await saveRoster(logger);

  if (logger) {
    logger.info(`[Roster] Updated description for ${userId} in "${area.name}"`);
    logger.info(`[Roster]   Old: "${oldDesc || "(none)"}"`);
    logger.info(`[Roster]   New: "${member.description || "(none)"}"`);
  }
  return member;
}

export async function touchMemberActivity(areaId, userId, logger = null) {
  const area = getKnowledgeAreaById(areaId);
  if (!area) return;

  let member = (area.leads ?? []).find((m) => m.userId === userId);
  if (!member) member = (area.teamMembers ?? []).find((m) => m.userId === userId);
  if (!member) return;

  member.lastActiveAt = new Date().toISOString();
  await saveRoster(logger);
}

// ─── Knowledge area CRUD (write to seed config + roster) ────────────────────

export async function addKnowledgeArea({ name, description = "", notionPageId, ownerUserIds = [], keywords = [] }, logger = null) {
  if (!name || !notionPageId) {
    throw new Error("Name and notionPageId are required");
  }

  if (getKnowledgeAreaByName(name)) {
    throw new Error(`Knowledge area "${name}" already exists`);
  }

  const now = new Date().toISOString();
  const leadIds = Array.isArray(ownerUserIds) ? ownerUserIds : [];

  const area = {
    id: generateId(name),
    name: name.trim(),
    description: (description || "").trim(),
    notionPageId: notionPageId.trim(),
    leads: leadIds.map((userId) => ({
      userId,
      description: "",
      addedAt: now,
      lastActiveAt: now,
    })),
    teamMembers: [],
    ownerUserIds: leadIds,
    keywords: Array.isArray(keywords) ? keywords.map((k) => k.trim().toLowerCase()) : [],
    createdAt: now,
  };

  knowledgeAreas.areas.push(area);
  await saveConfig(logger);
  await saveRoster(logger);

  if (logger) {
    logger.info(`[Config] Added knowledge area: "${area.name}" (ID: ${area.id})`);
    logger.info(`[Config]   Description: ${area.description || "(none)"}`);
    logger.info(`[Config]   Notion Page: ${area.notionPageId.slice(0, 30)}...`);
    logger.info(`[Config]   Leads: ${area.leads.length} user(s)`);
    logger.info(`[Config]   Keywords: ${area.keywords.join(", ") || "none"}`);
  }

  return area;
}

export async function removeKnowledgeArea(id, logger = null) {
  const index = knowledgeAreas.areas.findIndex((a) => a.id === id);
  if (index === -1) {
    if (logger) logger.warn(`[Config] Attempted to remove knowledge area with ID "${id}" but not found`);
    return false;
  }

  const area = knowledgeAreas.areas[index];
  knowledgeAreas.areas.splice(index, 1);
  delete roster[id];

  await saveConfig(logger);
  await saveRoster(logger);

  if (logger) logger.info(`[Config] Removed knowledge area: "${area.name}" (ID: ${area.id})`);
  return true;
}

export async function updateKnowledgeArea(id, updates, logger = null) {
  const area = getKnowledgeAreaById(id);
  if (!area) {
    throw new Error(`Knowledge area with ID "${id}" not found`);
  }

  if (updates.name && updates.name.toLowerCase() !== area.name.toLowerCase()) {
    if (getKnowledgeAreaByName(updates.name)) {
      throw new Error(`Knowledge area "${updates.name}" already exists`);
    }
  }

  const oldValues = {
    name: area.name,
    description: area.description || "",
    notionPageId: area.notionPageId,
    ownerUserIds: [...(area.ownerUserIds || [])],
    keywords: [...(area.keywords || [])],
  };

  let configChanged = false;
  let rosterChanged = false;

  if (updates.name !== undefined) { area.name = updates.name.trim(); configChanged = true; }
  if (updates.description !== undefined) { area.description = (updates.description || "").trim(); configChanged = true; }
  if (updates.notionPageId !== undefined) { area.notionPageId = updates.notionPageId.trim(); configChanged = true; }
  if (updates.keywords !== undefined) {
    area.keywords = Array.isArray(updates.keywords)
      ? updates.keywords.map((k) => k.trim().toLowerCase())
      : [];
    configChanged = true;
  }

  // Updating leads via ownerUserIds (from App Home UI or set-leads command)
  if (updates.ownerUserIds !== undefined) {
    const now = new Date().toISOString();
    const newIds = new Set(updates.ownerUserIds);
    const existingLeadMap = new Map((area.leads ?? []).map((m) => [m.userId, m]));

    area.leads = updates.ownerUserIds.map((userId) => {
      const existing = existingLeadMap.get(userId);
      if (existing) return existing;
      return { userId, description: "", addedAt: now, lastActiveAt: now };
    });

    area.teamMembers = (area.teamMembers ?? []).filter((m) => !newIds.has(m.userId));
    rosterChanged = true;
    configChanged = true; // seedLeadUserIds needs updating too
  }

  area.updatedAt = new Date().toISOString();

  if (configChanged) await saveConfig(logger);
  if (rosterChanged) await saveRoster(logger);
  // If only config changed but not roster, still recompute ownerUserIds
  if (configChanged && !rosterChanged) recomputeOwnerUserIds(area);

  if (logger) {
    logger.info(`[Config] Updated knowledge area: "${area.name}" (ID: ${area.id})`);
    if (updates.name && updates.name !== oldValues.name) {
      logger.info(`[Config]   Name: "${oldValues.name}" -> "${area.name}"`);
    }
    if (updates.description !== undefined && updates.description !== oldValues.description) {
      logger.info(`[Config]   Description updated`);
    }
    if (updates.notionPageId && updates.notionPageId !== oldValues.notionPageId) {
      logger.info(`[Config]   Notion Page updated`);
    }
    if (updates.ownerUserIds) {
      logger.info(`[Config]   Leads: ${oldValues.ownerUserIds.length} -> ${area.leads.length}`);
    }
    if (updates.keywords) {
      logger.info(`[Config]   Keywords: ${oldValues.keywords.length} -> ${area.keywords.length}`);
    }
  }

  return area;
}
