// plugins/cinesubz2.js
// CineSubz — Movies + TV Series full support
// API: mr-thinuzz-api-build.vercel.app

const { cmd } = require("../command");
const axios = require("axios");
const sharp = require("sharp");
const config = require("../config");
const { getSettings } = require("../lib/settings");
const { getContentType } = require("@whiskeysockets/baileys");

const API_BASE  = "https://mr-thinuzz-api-build.vercel.app/api/cinesubz";
const API_KEY   = "key_faa62e4037a95cda";
const CHANNEL   = "https://whatsapp.com/channel/0029VbCvEPYF6smqypvOM042";
const BANNER    = "https://files.catbox.moe/04jdju.jpg";
const TIMEOUT   = 5 * 60 * 1000;
const sleep     = ms => new Promise(r => setTimeout(r, ms));

// ── Logging ───────────────────────────────────────────────────────────────────
function log(...a) { console.log(`[cs2] [${new Date().toISOString()}]`, ...a); }

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retry(fn, tries = 3, delay = 2000, label = "") {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      log(`❌ ${label} attempt ${i}/${tries}:`, e.message);
      if (i === tries) throw e;
      await sleep(delay * i);
    }
  }
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function apiSearch(query) {
  const { data } = await axios.get(`${API_BASE}/search`, {
    params: { query, apiKey: API_KEY }, timeout: 30000
  });
  if (!data.status) throw new Error("Search API error");
  return data.data?.all || [];
}

async function apiMovie(url) {
  const { data } = await axios.get(`${API_BASE}/movie`, {
    params: { url, apiKey: API_KEY }, timeout: 30000
  });
  if (!data.status) throw new Error("Movie API error");
  return data.data;
}

async function apiTvShow(url) {
  const { data } = await axios.get(`${API_BASE}/tvshow`, {
    params: { url, apiKey: API_KEY }, timeout: 30000
  });
  if (!data.status) throw new Error("TVShow API error");
  return data.data;
}

async function apiEpisode(url) {
  const { data } = await axios.get(`${API_BASE}/episode`, {
    params: { url, apiKey: API_KEY }, timeout: 30000
  });
  if (!data.status) throw new Error("Episode API error");
  return data.data;
}

async function apiDownload(url) {
  const { data } = await axios.get(`${API_BASE}/download`, {
    params: { url, apiKey: API_KEY }, timeout: 60000
  });
  if (!data.status) throw new Error("Download API error");
  return data.data?.downloadUrls || [];
}

// ── Best download link ────────────────────────────────────────────────────────
function bestLink(links) {
  if (!links?.length) return null;
  // Prefer direct HTTP (non-telegram)
  const direct = links.find(l => l.url && l.url.startsWith("http") && !l.url.includes("t.me"));
  return (direct || links[0])?.url || null;
}

// ── Thumbnail ─────────────────────────────────────────────────────────────────
async function thumb(url) {
  try {
    const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
    return await sharp(data).resize(320, 320, { fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
  } catch { return null; }
}

// ── Reply helpers ─────────────────────────────────────────────────────────────
function replyBody(message) {
  if (!message) return "";
  const type = getContentType(message);
  if (type === "conversation") return message.conversation || "";
  if (type === "extendedTextMessage") return message.extendedTextMessage?.text || "";
  if (type === "buttonsResponseMessage") return message.buttonsResponseMessage?.selectedButtonId || "";
  if (type === "listResponseMessage") return message.listResponseMessage?.singleSelectReply?.selectedRowId || "";
  if (type === "templateButtonReplyMessage") return message.templateButtonReplyMessage?.selectedId || "";
  if (type === "interactiveResponseMessage") {
    try {
      const n = message.interactiveResponseMessage?.nativeFlowResponseMessage;
      return n ? (JSON.parse(n.paramsJson || "{}").id || n.name || "") : message.interactiveResponseMessage?.body?.text || "";
    } catch { return message.interactiveResponseMessage?.body?.text || ""; }
  }
  return "";
}

function replyCtx(message) {
  if (!message) return null;
  return message.extendedTextMessage?.contextInfo
    || message.buttonsResponseMessage?.contextInfo
    || message.listResponseMessage?.contextInfo
    || message.templateButtonReplyMessage?.contextInfo
    || message.interactiveResponseMessage?.contextInfo
    || null;
}

function resolveIdx(body, prefix, max) {
  const n = parseInt(body, 10);
  if (!isNaN(n) && String(n) === body.trim()) { const i = n - 1; return (i >= 0 && i < max) ? i : -1; }
  const m = body.match(new RegExp(`^${prefix}_(\\d+)$`));
  if (m) { const i = parseInt(m[1]); return (i >= 0 && i < max) ? i : -1; }
  return -1;
}

// ── Listener factory ──────────────────────────────────────────────────────────
function makeListener(conn, from, msgId, prefix, max, onSelect, onTimeout) {
  const handler = async update => {
    const msg = update.messages?.[0];
    if (!msg?.message || msg.key.remoteJid !== from) return;
    const ctx = replyCtx(msg.message);
    if (!ctx || ctx.stanzaId !== msgId) return;
    const body = replyBody(msg.message);
    const idx = resolveIdx(body, prefix, max);
    if (idx === -1) return;
    conn.ev.off("messages.upsert", handler);
    clearTimeout(timer);
    await onSelect(idx, msg);
  };
  const timer = setTimeout(() => {
    conn.ev.off("messages.upsert", handler);
    onTimeout && onTimeout();
  }, TIMEOUT);
  conn.ev.on("messages.upsert", handler);
  return handler;
}

// ── Title clean ───────────────────────────────────────────────────────────────
function cleanTitle(t) {
  return (t || "")
    .replace(/ Sinhala Subtitles.*$/i, "")
    .replace(/ \| සිංහල.*$/, "")
    .replace(/ TV Series.*$/i, "")
    .replace(/ \| S\d+.*$/i, "")
    .trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═════════════════════════════════════════════════════════════════════════════
cmd({
  pattern: "cinesubz2",
  alias: ["cs2", "csz"],
  react: "🎬",
  desc: "CineSubz — Movies & TV Series download",
  category: "downloader",
  filename: __filename,
}, async (conn, mek, m, { from, q, reply, sender, sessionId }) => {
  try {
    const query = (q || "").trim();
    if (!query) return reply("🎬 *CINESUBZ*\n\nUsage: `.cinesubz2 <title>`\n\nExample: `.cs2 climax`");

    const settings = getSettings(sessionId);
    const botName = settings.botName || config.PACKNAME || "SAYURA-LK-X-MINI";

    await conn.sendMessage(from, { react: { text: "🔎", key: mek.key } });

    // ── Search ────────────────────────────────────────────────────────────────
    const results = await retry(() => apiSearch(query), 3, 2000, "search");
    if (!results.length) return reply("❎ Results not found.");

    const display = results.slice(0, 10);

    await conn.sendMessage(from, {
      image: { url: BANNER },
      caption: `🎬 *CineSubz Search*\nQuery: *${query}*`
    }, { quoted: mek });

    const searchMsg = await conn.sendButton(from, {
      header: "🎬 Select a title",
      body: display.map((r, i) => `${i + 1}. [${r.type}] ${cleanTitle(r.title)}`).join("\n"),
      footer: botName,
      buttons: display.map((r, i) => ({
        text: `${i + 1}. ${r.type === "TV" ? "📺" : "🎬"} ${cleanTitle(r.title).substring(0, 50)}`,
        id: `cs2_sel_${i}`,
      })),
    }, mek);

    // ── Selection ─────────────────────────────────────────────────────────────
    makeListener(conn, from, searchMsg.key.id, "cs2_sel", display.length, async (idx, msg) => {
      await conn.sendMessage(from, { react: { text: "⏳", key: msg.key } });
      const item = display[idx];
      const isTV = item.type === "TV";
      log("selected:", item.title, "| TV:", isTV);

      if (isTV) {
        await handleTVShow(conn, from, sender, msg, item, botName);
      } else {
        await handleMovie(conn, from, sender, msg, item, botName);
      }
    });

  } catch (e) {
    console.error("[cs2] error:", e);
    reply(`❌ Error: ${e.message}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MOVIE HANDLER
// ═════════════════════════════════════════════════════════════════════════════
async function handleMovie(conn, from, sender, quotedMsg, item, botName) {
  try {
    const movie = await retry(() => apiMovie(item.link), 3, 2000, "movie");
    if (!movie) return conn.sendMessage(from, { text: "❎ Movie details not found." });

    const title = cleanTitle(movie.maintitle || movie.title || item.title);
    const poster = movie.mainImage || item.image || BANNER;
    const cast = Array.isArray(movie.cast)
      ? movie.cast.slice(0, 4).map(c => c.actor?.name || c.name).join(", ")
      : "N/A";

    const downloads = (movie.downloadUrl || []).sort((a, b) => {
      const r = s => parseInt((s.quality || "").match(/\d+/)?.[0]) || 0;
      return r(b) - r(a);
    });

    if (!downloads.length) return conn.sendMessage(from, { text: "❎ No download links." });

    const caption =
      `╭━━━〔 🎬 *${title}* 〕━━━⬣\n\n` +
      `*▫️🕵️ Cast ➟* ${cast}\n` +
      `*▫️📅 Year ➟* ${movie.dateCreate || item.year || "N/A"}\n\n` +
      `*⬇️ Qualities:*\n` +
      downloads.map(d => `➤ ${d.quality} (${d.size || "?"})`).join("\n") +
      `\n╰━━━━━━━━━━━━━━━━━━⬣\n${CHANNEL}`;

    const tb = await thumb(poster);
    await conn.sendMessage(from, { image: { url: poster }, caption, jpegThumbnail: tb }, { quoted: quotedMsg });

    const qualityMsg = await conn.sendButton(from, {
      header: `🎬 ${title}`,
      body: "Quality select කරන්න:",
      footer: botName,
      buttons: downloads.map((d, i) => ({
        text: `${d.quality?.includes("1080") ? "🔥" : d.quality?.includes("720") ? "⚡" : "⬇️"} ${d.quality} (${d.size || "?"})`,
        id: `cs2_q_${i}`,
      })),
    }, quotedMsg);

    makeListener(conn, from, qualityMsg.key.id, "cs2_q", downloads.length, async (idx, msg) => {
      await conn.sendMessage(from, { react: { text: "⏳", key: msg.key } });
      await downloadAndSend(conn, from, msg, downloads[idx], title, poster, botName);
    });

  } catch (e) {
    console.error("[cs2] handleMovie error:", e);
    conn.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: quotedMsg });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TV SHOW HANDLER
// ═════════════════════════════════════════════════════════════════════════════
async function handleTVShow(conn, from, sender, quotedMsg, item, botName) {
  try {
    const tvData = await retry(() => apiTvShow(item.link), 3, 2000, "tvshow");
    if (!tvData) return conn.sendMessage(from, { text: "❎ TV show data not found." });

    const title = cleanTitle(tvData.maintitle || tvData.title || item.title);
    const poster = tvData.mainImage || item.image || BANNER;
    const cast = Array.isArray(tvData.cast)
      ? tvData.cast.slice(0, 4).map(c => c.actor?.name || c.name).join(", ")
      : "N/A";
    const seasons = tvData.episodesDetails || [];

    if (!seasons.length) return conn.sendMessage(from, { text: "❎ No episodes found." });

    const tb = await thumb(poster);

    // Single season — go straight to episodes
    if (seasons.length === 1) {
      await showEpisodes(conn, from, sender, quotedMsg, title, poster, tb, seasons[0], 1, botName);
      return;
    }

    // Multiple seasons — season select
    const seasonCaption =
      `╭━━━〔 📺 *${title}* 〕━━━⬣\n\n` +
      `*▫️🕵️ Cast ➟* ${cast}\n\n` +
      `*🗂 Seasons: ${seasons.length}*\n` +
      seasons.map((s, i) => `➤ Season ${s.season || i + 1} (${s.episodes?.length || 0} eps)`).join("\n") +
      `\n╰━━━━━━━━━━━━━━━━━━⬣`;

    await conn.sendMessage(from, { image: { url: poster }, caption: seasonCaption, jpegThumbnail: tb }, { quoted: quotedMsg });

    const seasonMsg = await conn.sendButton(from, {
      header: `📺 ${title}`,
      body: "Season select කරන්න:",
      footer: botName,
      buttons: seasons.map((s, i) => ({
        text: `Season ${s.season || i + 1} (${s.episodes?.length || 0} eps)`,
        id: `cs2_se_${i}`,
      })),
    }, quotedMsg);

    makeListener(conn, from, seasonMsg.key.id, "cs2_se", seasons.length, async (idx, msg) => {
      await conn.sendMessage(from, { react: { text: "⏳", key: msg.key } });
      await showEpisodes(conn, from, sender, msg, title, poster, tb, seasons[idx], seasons[idx].season || idx + 1, botName);
    });

  } catch (e) {
    console.error("[cs2] handleTVShow error:", e);
    conn.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: quotedMsg });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EPISODE LIST
// ═════════════════════════════════════════════════════════════════════════════
async function showEpisodes(conn, from, sender, quotedMsg, title, poster, tb, seasonData, seasonNum, botName) {
  try {
    const episodes = seasonData.episodes || [];
    if (!episodes.length) return conn.sendMessage(from, { text: "❎ No episodes found." }, { quoted: quotedMsg });

    // Show in pages of 10
    async function showPage(start) {
      const page = episodes.slice(start, start + 10);
      const hasMore = start + 10 < episodes.length;

      let body = `📺 *${title}* — Season ${seasonNum}\n`;
      body += `Episodes (${start + 1}–${start + page.length} of ${episodes.length}):\n\n`;
      page.forEach((ep, i) => {
        body += `${start + i + 1}. EP${ep.number} — ${ep.title || "Episode " + ep.number} (${ep.date || ""})\n`;
      });
      if (hasMore) body += `\n_"0" reply කරන්න next page_`;

      const buttons = page.map((ep, i) => ({
        text: `EP${ep.number}${ep.title ? " — " + ep.title.substring(0, 30) : ""}`,
        id: `cs2_ep_${start + i}`,
      }));
      if (hasMore) buttons.push({ text: "▶️ More episodes", id: `cs2_more_${start + 10}` });

      const epMsg = await conn.sendButton(from, {
        header: `📺 Season ${seasonNum}`,
        body,
        footer: botName,
        buttons,
      }, quotedMsg);

      // Special "more" listener
      const handler = async update => {
        const msg = update.messages?.[0];
        if (!msg?.message || msg.key.remoteJid !== from) return;
        const ctx = replyCtx(msg.message);
        if (!ctx || ctx.stanzaId !== epMsg.key.id) return;
        const body2 = replyBody(msg.message);

        // More button
        if (body2.startsWith("cs2_more_")) {
          const next = parseInt(body2.split("_")[2]);
          conn.ev.off("messages.upsert", handler);
          clearTimeout(timer);
          await conn.sendMessage(from, { react: { text: "▶️", key: msg.key } });
          await showPage(next);
          return;
        }

        const idx = resolveIdx(body2, "cs2_ep", episodes.length);
        if (idx === -1) return;
        conn.ev.off("messages.upsert", handler);
        clearTimeout(timer);
        await conn.sendMessage(from, { react: { text: "⏳", key: msg.key } });
        await handleEpisode(conn, from, sender, msg, title, poster, tb, episodes[idx], seasonNum, botName);
      };

      const timer = setTimeout(() => conn.ev.off("messages.upsert", handler), TIMEOUT);
      conn.ev.on("messages.upsert", handler);
    }

    await showPage(0);

  } catch (e) {
    console.error("[cs2] showEpisodes error:", e);
    conn.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: quotedMsg });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EPISODE DETAIL + QUALITY SELECT
// ═════════════════════════════════════════════════════════════════════════════
async function handleEpisode(conn, from, sender, quotedMsg, seriesTitle, poster, tb, ep, seasonNum, botName) {
  try {
    const epData = await retry(() => apiEpisode(ep.url), 3, 2000, "episode");
    if (!epData) return conn.sendMessage(from, { text: "❎ Episode data not found." });

    const epTitle = `${seriesTitle} — S${String(seasonNum).padStart(2,"0")}E${String(ep.number).padStart(2,"0")}`;
    const epPoster = epData.imageUrls?.[0] || poster;
    const downloads = (epData.downloadUrl || []).sort((a, b) => {
      const r = s => parseInt((s.quality || "").match(/\d+/)?.[0]) || 0;
      return r(b) - r(a);
    });

    if (!downloads.length) return conn.sendMessage(from, { text: "❎ No download links for this episode." });

    const caption =
      `╭━━━〔 📺 *${epTitle}* 〕━━━⬣\n\n` +
      `*▫️📅 Date ➟* ${ep.date || "N/A"}\n\n` +
      `*⬇️ Qualities:*\n` +
      downloads.map(d => `➤ ${d.quality} (${d.size || "?"}) [${d.language || ""}]`).join("\n") +
      `\n╰━━━━━━━━━━━━━━━━━━⬣\n${CHANNEL}`;

    const epThumb = await thumb(epPoster);
    await conn.sendMessage(from, { image: { url: epPoster }, caption, jpegThumbnail: epThumb }, { quoted: quotedMsg });

    const qualityMsg = await conn.sendButton(from, {
      header: `📺 ${epTitle}`,
      body: "Quality select කරන්න:",
      footer: botName,
      buttons: downloads.map((d, i) => ({
        text: `${d.quality?.includes("1080") ? "🔥" : d.quality?.includes("720") ? "⚡" : "⬇️"} ${d.quality} (${d.size || "?"})`,
        id: `cs2_eq_${i}`,
      })),
    }, quotedMsg);

    makeListener(conn, from, qualityMsg.key.id, "cs2_eq", downloads.length, async (idx, msg) => {
      await conn.sendMessage(from, { react: { text: "⏳", key: msg.key } });
      await downloadAndSend(conn, from, msg, downloads[idx], epTitle, epPoster, botName);
    });

  } catch (e) {
    console.error("[cs2] handleEpisode error:", e);
    conn.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: quotedMsg });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DOWNLOAD + SEND
// ═════════════════════════════════════════════════════════════════════════════
async function downloadAndSend(conn, from, quotedMsg, qualityObj, title, poster, botName) {
  try {
    const sonicUrl = qualityObj.link;
    log("resolving download for:", sonicUrl);

    await conn.sendMessage(from, {
      text: `⏳ *Resolving link...*\n📺 *${title}*\n💎 *${qualityObj.quality}* (${qualityObj.size || "?"})\n\n_Please wait..._`
    }, { quoted: quotedMsg });

    const links = await retry(() => apiDownload(sonicUrl), 3, 3000, "download");
    const url = bestLink(links);
    log("best link:", url);

    if (!url) throw new Error("No usable download link found");

    await conn.sendMessage(from, {
      text: `⏳ *Sending file...*\n📺 *${title}*\n💎 *${qualityObj.quality}*\n📦 *${qualityObj.size || "?"}*`
    }, { quoted: quotedMsg });

    const tb = await thumb(poster);
    const safeTitle = title.replace(/[^\w\s\-]/g, "").replace(/\s+/g, "_").substring(0, 50);
    const fileName = `🎬${botName}🎬${safeTitle}_(${qualityObj.quality}).mp4`;

    await conn.sendMessage(from, {
      document: { url },
      mimetype: "video/mp4",
      fileName,
      jpegThumbnail: tb,
      caption:
        `*𝗧ɪᴛʟᴇ : ${title}*\n\n` +
        `\`[${qualityObj.quality} ${qualityObj.size || "N/A"}]\`\n\n` +
        `*⏤͟͟͞͞★❮ ${botName} 〽️𝗢𝗩𝗜𝗘𝗦 ❯⏤͟͟͞͞★*`,
    }, { quoted: quotedMsg });

    await conn.sendMessage(from, { react: { text: "✅", key: quotedMsg.key } });
    log("✅ sent:", fileName);

  } catch (e) {
    console.error("[cs2] downloadAndSend error:", e);
    await conn.sendMessage(from, { text: `❌ *Download failed*\n\n${e.message}` }, { quoted: quotedMsg });
    await conn.sendMessage(from, { react: { text: "❌", key: quotedMsg.key } });
  }
}

module.exports = {};
