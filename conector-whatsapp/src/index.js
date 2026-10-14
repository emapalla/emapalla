// Conector WhatsApp → Bitácora de Perforación
//
// 1. Se vincula a un número de WhatsApp como dispositivo (igual que WhatsApp Web, con un QR).
// 2. Guarda los mensajes de los grupos elegidos (texto, captions y fotos) en /data.
// 3. Los expone como conector MCP para Claude en /mcp/<TOKEN>.
// 4. Página de administración en /admin?token=<TOKEN>: QR, estado y selección de grupos.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import { z } from "zod";
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion,
  downloadMediaMessage, normalizeMessageContent, getContentType, isJidGroup,
} from "baileys";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Configuración opcional en un archivo conector.env (CLAVE=VALOR por línea) junto al programa.
// Lo usa la instalación en Windows, donde no hay variables de entorno de un servicio.
for (const f of [process.env.CONFIG_FILE, path.join(process.cwd(), "conector.env")].filter(Boolean)) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
  break;
}

const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || (process.platform === "win32" ? path.join(process.cwd(), "datos") : "/data");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const TZ = process.env.TZ_REPORTE || "America/Argentina/Buenos_Aires";
const MAX_IMG = 6 * 1024 * 1024;

if (!TOKEN || TOKEN.length < 16) {
  console.error("Falta la variable TOKEN (mínimo 16 caracteres). Generá una con: openssl rand -hex 24");
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || "warn" });
const AUTH_DIR = path.join(DATA, "auth");
const MEDIA_DIR = path.join(DATA, "media");
const MSGS_FILE = path.join(DATA, "mensajes.jsonl");
const CFG_FILE = path.join(DATA, "config.json");
for (const d of [DATA, AUTH_DIR, MEDIA_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- Almacenamiento ----------
const cfg = readJson(CFG_FILE, { grupos: [] });   // jids vigilados
const mensajes = [];                               // { n, wid, gid, grupo, ts, fecha, hora, autor, texto, imagen }
const vistos = new Set();
if (fs.existsSync(MSGS_FILE)) {
  for (const line of fs.readFileSync(MSGS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); mensajes.push(m); vistos.add(m.wid); } catch {}
  }
}
let seq = mensajes.length ? mensajes[mensajes.length - 1].n : 0;

function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } }
function saveCfg() { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); }

const fmtF = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtH = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

// ---------- WhatsApp ----------
const estado = { conectado: false, qr: null, numero: null, nombre: null, error: null, desde: null };
const grupos = new Map();   // jid -> { nombre, participantes }
let sock = null;

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  sock = makeWASocket({
    auth: state, logger: log, version,
    browser: Browsers.ubuntu("Bitacora Perforacion"),
    syncFullHistory: false, markOnlineOnConnect: false,
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) { estado.qr = u.qr; estado.conectado = false; }
    if (u.connection === "open") {
      Object.assign(estado, { conectado: true, qr: null, error: null, desde: new Date().toISOString(),
        numero: sock.user?.id?.split(":")[0]?.split("@")[0] || null, nombre: sock.user?.name || null });
      console.log("WhatsApp conectado:", estado.numero);
      await refrescarGrupos();
    }
    if (u.connection === "close") {
      estado.conectado = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        estado.error = "Se cerró la sesión desde el teléfono. Volvé a escanear el QR.";
        fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true });
      } else {
        estado.error = "Conexión perdida, reconectando…";
      }
      setTimeout(() => conectar().catch(e => console.error(e)), 3000);
    }
  });

  sock.ev.on("groups.update", () => refrescarGrupos());
  sock.ev.on("group-participants.update", () => refrescarGrupos());
  sock.ev.on("messages.upsert", ({ messages }) => { for (const m of messages) guardar(m); });
  sock.ev.on("messaging-history.set", ({ messages }) => { for (const m of messages || []) guardar(m); });
}

async function refrescarGrupos() {
  try {
    const all = await sock.groupFetchAllParticipating();
    grupos.clear();
    for (const [jid, g] of Object.entries(all)) grupos.set(jid, { nombre: g.subject || jid, participantes: g.participants?.length || 0 });
  } catch (e) { log.warn(e, "no se pudieron leer los grupos"); }
}

function textoDe(content) {
  if (!content) return { texto: "", tipo: "" };
  const tipo = getContentType(content);
  const c = content[tipo] || {};
  switch (tipo) {
    case "conversation": return { texto: content.conversation || "", tipo };
    case "extendedTextMessage": return { texto: c.text || "", tipo };
    case "imageMessage": return { texto: c.caption || "", tipo };
    case "videoMessage": return { texto: (c.caption ? c.caption + " " : "") + "[video]", tipo };
    case "documentMessage": return { texto: [c.caption, c.fileName && `[documento: ${c.fileName}]`].filter(Boolean).join(" "), tipo };
    case "audioMessage": return { texto: "[audio]", tipo };
    case "locationMessage": return { texto: `[ubicación ${c.degreesLatitude},${c.degreesLongitude}] ${c.name || ""}`.trim(), tipo };
    case "pollCreationMessage": case "pollCreationMessageV3":
      return { texto: `[encuesta] ${c.name || ""}: ${(c.options || []).map(o => o.optionName).join(" / ")}`, tipo };
    default: return { texto: "", tipo };
  }
}

async function guardar(m) {
  try {
    const gid = m.key?.remoteJid;
    if (!gid || !isJidGroup(gid) || !cfg.grupos.includes(gid)) return;
    const wid = gid + "|" + m.key.id;
    if (vistos.has(wid)) return;
    const content = normalizeMessageContent(m.message);
    if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage && Object.keys(content).length === 1) return;
    const { texto, tipo } = textoDe(content);
    let imagen = false;
    if (tipo === "imageMessage" && (content.imageMessage?.fileLength ?? 0) <= MAX_IMG) {
      try {
        const buf = await downloadMediaMessage(m, "buffer", {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
        fs.writeFileSync(path.join(MEDIA_DIR, crypto.createHash("sha1").update(wid).digest("hex") + ".jpg"), buf);
        imagen = true;
      } catch (e) { log.warn(e, "no se pudo descargar la imagen"); }
    }
    if (!texto.trim() && !imagen) return;
    const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? Date.now() / 1000);
    const d = new Date(tsSec * 1000);
    const rec = {
      n: ++seq, wid, gid, grupo: grupos.get(gid)?.nombre || gid,
      ts: d.toISOString(), fecha: fmtF.format(d), hora: fmtH.format(d),
      autor: m.key.fromMe ? (estado.nombre || "Yo") : (m.pushName || String(m.key.participant || "").split("@")[0] || ""),
      texto: texto.trim(), imagen,
    };
    vistos.add(wid); mensajes.push(rec);
    fs.appendFileSync(MSGS_FILE, JSON.stringify(rec) + "\n");
  } catch (e) { log.error(e, "error guardando mensaje"); }
}

// ---------- Conector MCP ----------
const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj });
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function listaGrupos() {
  return [...grupos.entries()].map(([id, g]) => ({ id, nombre: g.nombre, participantes: g.participantes, vigilado: cfg.grupos.includes(id) }))
    .sort((a, b) => Number(b.vigilado) - Number(a.vigilado) || a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
}
function resolverGrupos(lista) {
  const out = [];
  for (const x of lista || []) {
    if (grupos.has(x)) { out.push(x); continue; }
    const q = norm(x);
    for (const [id, g] of grupos) if (norm(g.nombre).includes(q)) out.push(id);
  }
  return [...new Set(out)];
}

function crearServidorMcp() {
  const server = new McpServer({ name: "bitacora-whatsapp", version: "1.0.0" });

  server.registerTool("estado", {
    description: "Estado del conector de WhatsApp: si está vinculado, qué número, qué grupos se están guardando y cuántos mensajes hay.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json({
    conectado: estado.conectado, numero: estado.numero, aviso: estado.error,
    necesita_qr: !estado.conectado && !!estado.qr,
    grupos_vigilados: cfg.grupos.map(id => ({ id, nombre: grupos.get(id)?.nombre || id })),
    mensajes_guardados: mensajes.length, ultimo_n: seq,
    ultimo_mensaje: mensajes.length ? mensajes[mensajes.length - 1].ts : null,
  }));

  server.registerTool("listar_grupos", {
    description: "Lista todos los grupos de WhatsApp en los que está el número vinculado, indicando cuáles se están guardando (vigilado).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json({ grupos: listaGrupos() }));

  server.registerTool("vigilar_grupos", {
    description: "Elige qué grupos se guardan. 'agregar' y 'quitar' aceptan ids o parte del nombre del grupo (p. ej. 'Eq 205'). Solo se guardan mensajes nuevos desde que el grupo se agrega.",
    inputSchema: { agregar: z.array(z.string()).optional(), quitar: z.array(z.string()).optional() },
  }, async ({ agregar, quitar }) => {
    const add = resolverGrupos(agregar), rem = new Set(resolverGrupos(quitar));
    cfg.grupos = [...new Set([...cfg.grupos, ...add])].filter(id => !rem.has(id));
    saveCfg();
    return json({ grupos_vigilados: cfg.grupos.map(id => ({ id, nombre: grupos.get(id)?.nombre || id })),
      no_encontrados: (agregar || []).filter(x => !resolverGrupos([x]).length) });
  });

  server.registerTool("leer_mensajes", {
    description: "Lee los mensajes guardados de los grupos de los rigs, en orden. Para traer solo lo nuevo pasá 'desde' = el último 'n' que ya tenés. También filtra por fechas (YYYY-MM-DD, hora de Argentina), grupo (parte del nombre) o texto. Devuelve hasta 'limite' mensajes (máx. 2000) y 'hay_mas' si quedan.",
    inputSchema: {
      desde: z.number().int().optional().describe("devolver mensajes con n mayor a este"),
      desde_fecha: z.string().optional(), hasta_fecha: z.string().optional(),
      grupo: z.string().optional(), texto: z.string().optional(),
      limite: z.number().int().min(1).max(2000).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const lim = a.limite || 500, g = norm(a.grupo), t = norm(a.texto);
    const res = []; let hay_mas = false;
    for (const m of mensajes) {
      if (a.desde != null && m.n <= a.desde) continue;
      if (a.desde_fecha && m.fecha < a.desde_fecha) continue;
      if (a.hasta_fecha && m.fecha > a.hasta_fecha) continue;
      if (g && !norm(m.grupo).includes(g)) continue;
      if (t && !norm(m.texto).includes(t)) continue;
      if (res.length >= lim) { hay_mas = true; break; }
      res.push({ n: m.n, grupo: m.grupo, fecha: m.fecha, hora: m.hora, autor: m.autor, texto: m.texto, imagen: m.imagen });
    }
    return json({ mensajes: res, ultimo: res.length ? res[res.length - 1].n : (a.desde ?? seq), hay_mas, conectado: estado.conectado });
  });

  server.registerTool("obtener_imagen", {
    description: "Devuelve la foto de un mensaje (por su n), por ejemplo un parte diario fotografiado.",
    inputSchema: { n: z.number().int() },
    annotations: { readOnlyHint: true },
  }, async ({ n }) => {
    const m = mensajes.find(x => x.n === n);
    if (!m || !m.imagen) return { content: [{ type: "text", text: "Ese mensaje no tiene imagen guardada." }], isError: true };
    const f = path.join(MEDIA_DIR, crypto.createHash("sha1").update(m.wid).digest("hex") + ".jpg");
    if (!fs.existsSync(f)) return { content: [{ type: "text", text: "La imagen ya no está disponible." }], isError: true };
    return { content: [{ type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: "image/jpeg" },
      { type: "text", text: `${m.grupo} · ${m.fecha} ${m.hora} · ${m.autor}: ${m.texto}` }] };
  });

  return server;
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

const okToken = (t) => typeof t === "string" && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

app.get("/", (_req, res) => res.type("text").send("Conector WhatsApp de la Bitácora de Perforación. Administración en /admin?token=…"));
app.get("/salud", (_req, res) => res.json({ ok: true, conectado: estado.conectado }));

app.all("/mcp/:token", async (req, res) => {
  if (!okToken(req.params.token)) return res.status(404).end();
  if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
  const server = crearServidorMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (e) { log.error(e); if (!res.headersSent) res.status(500).json({ error: "error interno" }); }
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
app.get("/admin", async (req, res) => {
  if (!okToken(req.query.token)) return res.status(404).end();
  const qr = !estado.conectado && estado.qr ? await QRCode.toDataURL(estado.qr, { margin: 1, width: 320 }) : null;
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conector WhatsApp · Bitácora</title>
<style>body{font:15px system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#172029;background:#EDEFF1}
.card{background:#fff;border:1px solid #D3D9DF;border-radius:6px;padding:16px;margin:12px 0}h1{font-size:1.3rem}
.ok{color:#2E7D4F;font-weight:600}.bad{color:#C62828;font-weight:600}code{background:#E3E7EB;padding:2px 6px;border-radius:4px;word-break:break-all}
label{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #eee}button{padding:8px 16px;border-radius:6px;border:0;background:#0F6177;color:#fff;font-weight:600}</style>
<h1>Conector WhatsApp · Bitácora de Perforación</h1>
<div class="card">${estado.conectado
    ? `<p class="ok">Vinculado al número ${esc(estado.numero)}</p><p>${mensajes.length} mensajes guardados de ${cfg.grupos.length} grupos.</p>`
    : qr ? `<p class="bad">Falta vincular.</p><p>En el teléfono: WhatsApp → ⋮ → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> y escaneá este código. Si vence, recargá la página.</p><img src="${qr}" alt="Código QR" width="320" height="320">`
    : `<p>Conectando… recargá en unos segundos.</p>`}
${estado.error ? `<p class="bad">${esc(estado.error)}</p>` : ""}</div>
<div class="card"><h2 style="font-size:1.05rem">Grupos a guardar</h2>
${grupos.size ? `<form method="post" action="/admin/grupos?token=${esc(req.query.token)}">${listaGrupos().map(g => `<label><input type="checkbox" name="g" value="${esc(g.id)}" ${g.vigilado ? "checked" : ""}> ${esc(g.nombre)} <small style="color:#5B6672">(${g.participantes})</small></label>`).join("")}
<p><button>Guardar selección</button></p></form>` : `<p>Los grupos aparecen cuando el número esté vinculado.</p>`}</div>
<div class="card"><h2 style="font-size:1.05rem">Dirección para Claude</h2>
<p>En claude.ai → Configuración → Conectores → <b>Agregar conector personalizado</b>. Nombre: <code>Bitacora WhatsApp</code>. URL:</p>
<p><code>${esc(base)}/mcp/${esc(req.query.token)}</code></p><p style="color:#5B6672">No compartas esta dirección: da acceso a los mensajes.</p></div>`);
});
app.post("/admin/grupos", (req, res) => {
  if (!okToken(req.query.token)) return res.status(404).end();
  const sel = [].concat(req.body.g || []).filter(id => grupos.has(id));
  cfg.grupos = sel; saveCfg();
  res.redirect(303, "/admin?token=" + encodeURIComponent(req.query.token));
});

// HOST=127.0.0.1 en Windows: solo escucha en la PC (el túnel de Tailscale llega por ahí) y no dispara el aviso del firewall.
app.listen(PORT, process.env.HOST || "0.0.0.0", () => console.log(`Conector escuchando en ${process.env.HOST || "0.0.0.0"}:${PORT}`));
if (process.env.SIN_WHATSAPP !== "1") conectar().catch(e => { console.error(e); estado.error = String(e.message || e); });
