const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const { marked } = require("marked");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// --- Security helpers (CORS + rate limit + basic sanitization) ---
const RATE_STATE = new Map(); // key -> { resetAt:number, count:number }
const LOCAL_CACHE = new Map(); // fallback cache when KV is not configured

function getRequestIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
  return req.socket?.remoteAddress || "unknown";
}

function kvConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    "";
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    "";
  if (!url || !token) return null;
  return { url, token };
}

async function kvCommand(cmd) {
  const cfg = kvConfig();
  if (!cfg) return { ok: false, result: null };

  try {
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(cmd),
    });

    if (!resp.ok) return { ok: false, result: null };
    const json = await resp.json();
    return { ok: true, result: json?.result ?? null };
  } catch (_) {
    return { ok: false, result: null };
  }
}

function nowMs() {
  return Date.now();
}

function localCacheGet(key) {
  const e = LOCAL_CACHE.get(key);
  if (!e) return null;
  if (e.expiresAt && nowMs() > e.expiresAt) {
    LOCAL_CACHE.delete(key);
    return null;
  }
  return e.value;
}

function localCacheSet(key, value, ttlSeconds) {
  const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) * 1000 : 0;
  LOCAL_CACHE.set(key, { value, expiresAt: ttl ? nowMs() + ttl : 0 });
}

async function cacheGetJson(key) {
  // Prefer KV when configured, otherwise use local memory cache.
  const cfg = kvConfig();
  if (!cfg) return localCacheGet(key);

  const r = await kvCommand(["GET", key]);
  if (!r.ok || !r.result) return null;
  try {
    return JSON.parse(r.result);
  } catch (_) {
    return null;
  }
}

async function cacheSetJson(key, obj, ttlSeconds) {
  const cfg = kvConfig();
  const value = JSON.stringify(obj);
  if (!cfg) {
    localCacheSet(key, obj, ttlSeconds);
    return true;
  }

  const ttl = Number(ttlSeconds) > 0 ? String(Math.floor(Number(ttlSeconds))) : null;
  const cmd = ttl ? ["SET", key, value, "EX", ttl] : ["SET", key, value];
  const r = await kvCommand(cmd);
  return r.ok;
}

function rateLimitCheck(key, limit, windowMs) {
  const now = Date.now();
  const cur = RATE_STATE.get(key);
  if (!cur || now >= cur.resetAt) {
    const next = { resetAt: now + windowMs, count: 1 };
    RATE_STATE.set(key, next);
    return { ok: true, remaining: limit - 1, resetAt: next.resetAt };
  }
  if (cur.count >= limit) {
    return { ok: false, remaining: 0, resetAt: cur.resetAt };
  }
  cur.count += 1;
  return { ok: true, remaining: Math.max(0, limit - cur.count), resetAt: cur.resetAt };
}

function parseCorsAllowlist() {
  const raw = process.env.CORS_ALLOWLIST || process.env.CORS_ALLOWED_ORIGINS || "";
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  return parts;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowlist = parseCorsAllowlist();

  // Always set methods for preflight compatibility.
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  // Do NOT default to wildcard in production; require explicit allowlist.
  if (!origin) return;
  if (allowlist.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return;
  }
  if (allowlist.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return;
  }

  // Dev convenience: allow localhost automatically if not configured.
  const isDev = String(process.env.NODE_ENV || "").toLowerCase() !== "production";
  if (isDev && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHttpUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  // allow http(s) and mailto; allow data:image for markdown images (optional)
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("mailto:")) return u;
  if (u.startsWith("data:image/")) return u;
  return "";
}

// marked: block raw HTML output (escape it) and harden links/images.
const SAFE_RENDERER = new marked.Renderer();
function sanitizeRawHtml(html) {
  let s = String(html || "");
  if (!s) return "";

  // Drop obviously dangerous tags entirely.
  s = s.replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, "");
  s = s.replace(/<\s*object\b[^>]*>[\s\S]*?<\s*\/\s*object\s*>/gi, "");
  s = s.replace(/<\s*embed\b[^>]*>[\s\S]*?<\s*\/\s*embed\s*>/gi, "");

  // Remove inline event handlers (onload=, onclick=, ...).
  s = s.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");

  // Block javascript: in href/src.
  s = s.replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, "");

  return s;
}
SAFE_RENDERER.html = (html) => sanitizeRawHtml(html);
SAFE_RENDERER.link = (href, title, text) => {
  const safeHref = sanitizeHttpUrl(href);
  if (!safeHref) return escapeHtml(text || "");
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${safeTitle} rel="noopener noreferrer" target="_blank">${text || ""}</a>`;
};
SAFE_RENDERER.image = (href, title, text) => {
  const safeHref = sanitizeHttpUrl(href);
  if (!safeHref) return "";
  const alt = escapeHtml(text || "");
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeHref)}" alt="${alt}" loading="lazy" decoding="async"${safeTitle} />`;
};
marked.use({ renderer: SAFE_RENDERER });

async function getAllBlockChildren(blockId) {
  const results = [];
  let start_cursor = undefined;

  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor,
    });

    if (resp?.results?.length) results.push(...resp.results);
    if (!resp?.has_more) break;
    start_cursor = resp.next_cursor || undefined;
    if (!start_cursor) break;
  }

  return results;
}

async function queryDatabaseAll({ database_id, filter, sorts, page_size = 100, maxItems = 1000 }) {
  const results = [];
  let start_cursor = undefined;

  while (true) {
    const resp = await notion.databases.query({
      database_id,
      filter,
      sorts,
      page_size: Math.min(100, page_size || 100),
      start_cursor,
    });

    if (resp?.results?.length) results.push(...resp.results);
    if (!resp?.has_more) break;
    start_cursor = resp.next_cursor || undefined;
    if (!start_cursor) break;
    if (results.length >= maxItems) break;
  }

  return results.slice(0, maxItems);
}

// Notion Columns (column_list / column) support:
// notion-to-md flattens these by default; we rehydrate them into HTML wrappers
// so the frontend can render them side-by-side with CSS.
n2m.setCustomTransformer("column_list", async (block) => {
  const columnBlocks = await getAllBlockChildren(block.id);
  const columns = columnBlocks.filter((b) => b && b.type === "column");

  if (!columns.length) return "";

  const columnHtml = await Promise.all(
    columns.map(async (col) => {
      const childBlocks = await getAllBlockChildren(col.id);
      const mdBlocks = await n2m.blocksToMarkdown(childBlocks);
      const mdObj = n2m.toMarkdownString(mdBlocks);
      const mdText = (mdObj && mdObj.parent) ? mdObj.parent : "";
      const html = mdText ? marked.parse(mdText) : "";
      return `<div class="notion-column">${html}</div>`;
    })
  );

  return `<div class="notion-columns">${columnHtml.join("")}</div>`;
});

n2m.setCustomTransformer("callout", async (block) => {
  const callout = block.callout || {};
  const color = String(callout.color || "").toLowerCase();

  // DM Yorumu Filtresi: Callout'un text rengi kırmızıysa hiç renderlama (sunucudan oyunculara yüklenmez)
  if (color === "red") {
    return "";
  }

  let variant = "default";
  if (color.startsWith("pink")) variant = "pink";
  else if (color.startsWith("red")) variant = "red";

  // Icon (emoji only; ignore file/external for now)
  let iconHtml = "";
  try {
    if (callout.icon && callout.icon.type === "emoji" && callout.icon.emoji) {
      iconHtml = `<span class="notion-callout__icon" aria-hidden="true">${escapeHtml(callout.icon.emoji)}</span>`;
    }
  } catch (_) { /* noop */ }

  // Text content (simple inline formatting; marked will handle if it includes markdown)
  const text = Array.isArray(callout.rich_text)
    ? callout.rich_text.map(t => t?.plain_text || "").join("")
    : "";
  const textMd = text ? escapeHtml(text) : "";

  // Children blocks (so user can place images, lists, etc. inside the callout)
  let childrenHtml = "";
  try {
    const childBlocks = await getAllBlockChildren(block.id);
    if (childBlocks && childBlocks.length) {
      const mdBlocks = await n2m.blocksToMarkdown(childBlocks);
      const mdObj = n2m.toMarkdownString(mdBlocks);
      const mdText = (mdObj && mdObj.parent) ? mdObj.parent : "";
      childrenHtml = mdText ? marked.parse(mdText) : "";
    }
  } catch (_) { /* noop */ }

  // Use HTML wrapper (will be sanitized in frontend by DOMPurify)
  const header = (iconHtml || textMd)
    ? `<div class="notion-callout__header">${iconHtml}<div class="notion-callout__text">${textMd}</div></div>`
    : "";

  return `<div class="notion-callout notion-callout--${variant}">${header}${childrenHtml}</div>`;
});

export default async function handler(req, res) {
  applyCors(req, res);

  // Vercel Edge caching - Makes requests nearly instantaneous
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { slug, list, limit, parent_id, id, search } = req.query;

  // Rate limiting (best-effort, per-instance)
  const ip = getRequestIp(req);
  const windowMs = 60 * 1000;
  const base = rateLimitCheck(`ip:${ip}:base`, 120, windowMs);
  if (!base.ok) {
    res.setHeader("Retry-After", String(Math.ceil((base.resetAt - Date.now()) / 1000)));
    return res.status(429).json({ error: "Çok fazla istek. Lütfen biraz bekleyip tekrar deneyin." });
  }
  if (search) {
    const s = rateLimitCheck(`ip:${ip}:search`, 30, windowMs);
    if (!s.ok) {
      res.setHeader("Retry-After", String(Math.ceil((s.resetAt - Date.now()) / 1000)));
      return res.status(429).json({ error: "Arama limiti aşıldı. Lütfen biraz bekleyin." });
    }
  }

  try {
    if (search) {
      if (String(search).trim().length < 2) {
        return res.status(400).json({ error: "Arama terimi çok kısa." });
      }
      const response = await notion.search({
        query: search,
        filter: { value: 'page', property: 'object' },
        page_size: 100
      });
      // Arama bütün Workspace'i taradığı için sadece "Kamu" olan ve bu veritabanına ait olan sayfaları ayıkla
      const validPages = response.results.filter(p => {
        if (p.parent && p.parent.database_id && p.parent.database_id.replace(/-/g,'') === DATABASE_ID.replace(/-/g,'')) {
           const status = p.properties.Status?.status?.name;
           return status === 'Kamu';
        }
        return false;
      });
      const mapped = validPages.map(mapNotionPage);
      return res.status(200).json({ data: mapped });
    }

    if (list) {
      const lim = limit ? parseInt(limit) : null;
      const maxItems = Number.isFinite(lim) && lim > 0 ? lim : 2000;
      const listCacheKey = Number.isFinite(lim) && lim > 0
        ? `wiki:v1:list:public:max:${lim}`
        : `wiki:v1:list:public:all`;
      const cached = await cacheGetJson(listCacheKey);
      if (cached && Array.isArray(cached.data)) {
        res.setHeader("x-wiki-cache", "hit");
        return res.status(200).json({ data: cached.data });
      }

      const pagesRaw = await queryDatabaseAll({
        database_id: DATABASE_ID,
        filter: {
          property: "Status", status: { equals: "Kamu" }
        },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        maxItems,
      });

      const pages = pagesRaw.map(page => mapNotionPage(page));
      // Cache list briefly; can be large, so keep TTL short.
      await cacheSetJson(listCacheKey, { data: pages }, 60);
      res.setHeader("x-wiki-cache", "miss");
      return res.status(200).json({ data: pages });
    }

    if (parent_id) {
      const parentCacheKey = `wiki:v1:children:public:parent:${parent_id}`;
      const cached = await cacheGetJson(parentCacheKey);
      if (cached && Array.isArray(cached.data)) {
        res.setHeader("x-wiki-cache", "hit");
        return res.status(200).json({ data: cached.data });
      }

      const pagesRaw = await queryDatabaseAll({
        database_id: DATABASE_ID,
        filter: {
          and: [
            { property: "Status", status: { equals: "Kamu" } },
            { property: "Parent", relation: { contains: parent_id } }
          ]
        },
        maxItems: 1000,
      });

      const pages = pagesRaw.map(page => mapNotionPage(page));
      await cacheSetJson(parentCacheKey, { data: pages }, 60);
      res.setHeader("x-wiki-cache", "miss");
      return res.status(200).json({ data: pages });
    }
    
    // For breadcrumbs: fetch by ID
    if (id) {
        const idCacheKey = `wiki:v1:page_meta:${id}`;
        const cached = await cacheGetJson(idCacheKey);
        if (cached && cached.data) {
          res.setHeader("x-wiki-cache", "hit");
          return res.status(200).json({ data: cached.data });
        }
        const response = await notion.pages.retrieve({ page_id: id });
        const mapped = mapNotionPage(response);
        await cacheSetJson(idCacheKey, { data: mapped }, 60 * 10);
        res.setHeader("x-wiki-cache", "miss");
        return res.status(200).json({ data: mapped });
    }

    if (slug) {
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        filter: {
          and: [
            { property: "Status", status: { equals: "Kamu" } },
            { property: "Slug", rich_text: { equals: slug } }
          ]
        }
      });

      if (!response.results.length) {
        return res.status(404).json({ error: "Sayfa bulunamadı veya gizli." });
      }

      const page = response.results[0];
      const mapped = mapNotionPage(page);

      // Render cache (KV) + invalidation by last_edited_time
      const pageCacheKey = `wiki:v1:page_html:${page.id}`;
      const cached = await cacheGetJson(pageCacheKey);
      if (cached && cached.updated_at && cached.updated_at === page.last_edited_time && typeof cached.html === "string") {
        mapped.content = cached.html;
        res.setHeader("x-wiki-cache", "hit");
        return res.status(200).json({ data: mapped });
      }

      // Extract markdown blocks and convert to HTML
      const mdblocks = await n2m.pageToMarkdown(page.id);
      const mdString = n2m.toMarkdownString(mdblocks);
      const htmlContent = marked.parse(mdString.parent || mdString);

      mapped.content = htmlContent;
      await cacheSetJson(pageCacheKey, { updated_at: page.last_edited_time, html: htmlContent }, 60 * 60 * 24);
      res.setHeader("x-wiki-cache", "miss");
      return res.status(200).json({ data: mapped });
    }

    return res.status(400).json({ error: "Geçersiz istek parametreleri." });
  } catch (error) {
    console.error("Notion API Error:", error);
    return res.status(500).json({ error: "Sunucu hatası: " + error.message });
  }
}

function mapNotionPage(page) {
  const props = page.properties || {};
  
  const title = getTitle(props.Name || props.Title);
  const slug = getRichText(props.Slug);
  const tags = getMultiSelect(props.Tags);
  const imageUrl = getFiles(props.Image || props.Cover || props["Kapak Resmi"] || props.Görsel || props.Resim);
  const sidebarInfo = getRichTextWithLinks(props.Sidebar_Info || props.SidebarInfo);
  const parentId = getRichText(props.ParentId) || getRelation(props.Parent) || null;

  return {
    id: page.id,
    title,
    slug,
    tags,
    image_url: imageUrl,
    sidebar_info: sidebarInfo,
    updated_at: page.last_edited_time,
    parent_id: parentId
  };
}

function getTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return prop.title.map(t => t.plain_text).join("");
}
function getRichText(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text.map(t => t.plain_text).join("");
}
function getRichTextWithLinks(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text.map(t => {
    let text = escapeHtml(t.plain_text);
    // Kalın veya Eğik etiketlerini koru
    if (t.annotations && t.annotations.bold) text = `<strong>${text}</strong>`;
    if (t.annotations && t.annotations.italic) text = `<em>${text}</em>`;
    // Eğer Notion'da text'e link gömülmüşse:
    if (t.href) {
      const safeHref = sanitizeHttpUrl(t.href);
      if (safeHref) {
        text = `<a href="${escapeHtml(safeHref)}" rel="noopener noreferrer" target="_blank">${text}</a>`;
      }
    }
    return text;
  }).join("");
}
function getMultiSelect(prop) {
  if (!prop || prop.type !== "multi_select") return [];
  return prop.multi_select.map(s => s.name);
}
function getFiles(prop) {
  if (!prop || prop.type !== "files" || prop.files.length === 0) return null;
  return prop.files[0].type === "external" ? prop.files[0].external.url : prop.files[0].file.url;
}
function getRelation(prop) {
    if (!prop || prop.type !== "relation" || prop.relation.length === 0) return null;
    return prop.relation[0].id;
}
