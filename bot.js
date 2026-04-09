/**
 * BOT — estable + autoguiados + seguimiento con autostop 10'
 * -----------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const TelegramBot = require('node-telegram-bot-api');
const { spawnSync } = require('child_process');

// --- Servidor Dummy para mantener contento a Render ---
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot de colectivos funcionando OK\n');
}).listen(port, () => {
  console.log(`Servidor web escuchando en el puerto ${port}`);
});
// ------------------------------------------------------

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) { console.error('[ERROR] Falta TELEGRAM_TOKEN en .env'); process.exit(1); }
const bot = new TelegramBot(TOKEN, { polling: true });

/* ---------------- Config seguimiento ---------------- */
const TRACK_REFRESH_MS = Number(process.env.TRACK_REFRESH_MS || 60 * 1000);    // 60s
const TRACK_MAX_MS     = Number(process.env.TRACK_MAX_MS     || 10 * 60 * 1000); // 10 min

/* ---------------- Rutas y constantes ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const FAV_DIR  = path.join(DATA_DIR, 'favs');
if (!fs.existsSync(FAV_DIR)) fs.mkdirSync(FAV_DIR, { recursive: true });
const MAX_BTNS = 10;

/* ---------------- Alias de líneas/ramales ---------------- */
const LINE_NAMES = { "329":"Ramal A", "330":"Ramal B", "331":"Ramal C", "332":"Ramal D", "333":"Ramal E" };
const lineTitle = (linea) => LINE_NAMES[linea] || `Línea ${linea}`;

/* ---------------- Utils ---------------- */
function getDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Radio de la Tierra en metros
  const rLat1 = lat1 * Math.PI/180;
  const rLat2 = lat2 * Math.PI/180;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function getCalleAproximada(lat, lon) {
  if (!lat || !lon) return null;
  let calleCercana = null;
  let minDst = Infinity;
  
  for (const l of LINES) {
    if (!l.calles) continue;
    for (const c of l.calles) {
      if (!c.intersecciones) continue;
      for (const i of c.intersecciones) {
        if (!i.paradas) continue;
        for (const p of i.paradas) {
          if (p.lat && p.lon) {
            const dst = getDistancia(lat, lon, p.lat, p.lon);
            if (dst < minDst) {
              minDst = dst;
              calleCercana = (i.descripcion || c.descripcion || '').replace(/-PERGAMINO/ig, '').trim();
            }
          }
        }
      }
    }
  }
  if (minDst < 400 && calleCercana) return calleCercana;
  return null;
}

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const stripBOM = (s) => String(s || '').replace(/^\uFEFF/, '');
const fmtTimeHHMM = (d) => d.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false });
const norm = (s) => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w\s\-\.]/g,' ').replace(/\s+/g,' ').trim().toUpperCase();

/* ---------------- Carga de líneas desde ./data ---------------- */
function listLineEntries() {
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  const files = [];
  for (const e of entries) if (e.isFile() && e.name.toLowerCase().startsWith('linea_')) files.push(path.join(DATA_DIR, e.name));
  return files;
}
function readJSONSafe(file) { try { return JSON.parse(stripBOM(fs.readFileSync(file,'utf8'))); } catch { return null; } }
function loadLines() {
  const files = listLineEntries();
  const lines = [];
  for (const f of files) {
    const j = readJSONSafe(f); if (!j) continue;
    const linea  = String(j.linea || j.Linea || (path.basename(f).match(/\d+/)||['?'])[0]);
    const calles = j.calles || j.Calles; if (!Array.isArray(calles)) continue;
    lines.push({ linea, file:f, calles });
  }
  return lines.sort((a,b)=>a.linea.localeCompare(b.linea,'es',{numeric:true}));
}
let LINES = loadLines();

/* ---------------- Geo de parada (para links de Maps) ---------------- */
function cleanStreetName(name) {
  return String(name || '').replace(/-PERGAMINO/ig, '').replace(/\.+$/, '').trim();
}

function findStopGeo(linea, paradaId) {
  const lobj = LINES.find(l => l.linea === String(linea));
  if (!lobj) return { lat:null, lon:null, maps:null, name:null };
  
  for (const c of lobj.calles || []) {
    for (const it of (c.intersecciones || c.Intersecciones || [])) {
      for (const p of (it.paradas || it.Paradas || [])) {
        const id = String(p.identificador || p.Identificador || p.parada || p.Parada || '').trim();
        if (id === String(paradaId)) {
          const slat = p.lat != null ? Number(p.lat) : null;
          const slon = p.lon != null ? Number(p.lon) : null;
          const smaps = (slat != null && slon != null) ? `https://www.google.com/maps?q=${slat},${slon}` : null;
          
          const cName = cleanStreetName(c.descripcion || c.Descripcion);
          const iName = cleanStreetName(it.descripcion || it.Descripcion);
          const stopName = (cName && iName) ? `${cName} y ${iName}` : (cName || iName || null);

          return { lat: slat, lon: slon, maps: smaps, name: stopName };
        }
      }
    }
  }
  return { lat:null, lon:null, maps:null, name:null };
}

function getStopLineStr(parada, stopGeo) {
  let txt = `🛑 Parada ${parada}`;
  if (stopGeo && (stopGeo.name || stopGeo.maps)) {
    const linkText = stopGeo.name || "Ver mapa";
    txt += stopGeo.maps ? ` · [${linkText}](${stopGeo.maps})` : ` · ${linkText}`;
  }
  return txt;
}

/* ---------------- Favoritos ---------------- */
function favPath(chatId){ return path.join(FAV_DIR, `${chatId}.json`); }
function loadFavs(chatId){ try{ const f=favPath(chatId); if(!fs.existsSync(f))return[]; const j=JSON.parse(stripBOM(fs.readFileSync(f,'utf8'))); return Array.isArray(j)?j:[]; }catch{ return []; } }
function saveFavs(chatId,favs){ try{ fs.writeFileSync(favPath(chatId), JSON.stringify(favs,null,2),'utf8'); }catch{} }
function addFav(chatId, parada, linea, name=null){ const favs=loadFavs(chatId); const i=favs.findIndex(f=>f.parada===parada&&f.linea===linea); if(i===-1){favs.push({parada,linea,tag:`${parada} ${linea}`,name}); saveFavs(chatId,favs); return {added:true};} return {added:false}; }
function setFavName(chatId, parada, linea, name){ const favs=loadFavs(chatId); const i=favs.findIndex(f=>f.parada===parada&&f.linea===linea); if(i>-1){favs[i].name=name; saveFavs(chatId,favs); return true;} return false; }
function delFav(chatId, parada, linea){ const favs=loadFavs(chatId); const keep=favs.filter(f=>!(f.parada===parada&&f.linea===linea)); saveFavs(chatId,keep); return keep.length!==favs.length; }
function listFavsKeyboard(chatId){ const favs=loadFavs(chatId); if(!favs.length) return kb([[{text:'— (sin favoritos) —', callback_data:'noop'}]]); const rows=[]; for(const f of favs.slice(0,MAX_BTNS)){ const label=f.name?`${f.name} (${f.parada} ${f.linea})`:`${f.parada} ${f.linea}`; rows.push([{text:`⏱️ ${label}`,callback_data:`fav_go:${f.parada}:${f.linea}`},{text:'🖊️',callback_data:`fav_rename:${f.parada}:${f.linea}`},{text:'🗑️',callback_data:`fav_del:${f.parada}:${f.linea}`}]); } return kb(rows); }

/* ---------------- Arribos (puente Node) ---------------- */
function obtenerArribos(parada, linea){
  const script = path.join(__dirname, 'scripts','arribos_cli.js');
  const res = spawnSync(process.execPath, [script,'--parada',parada,'--linea',linea], { encoding:'utf8', env:{...process.env} });
  if (res.status !== 0) throw new Error(res.stderr || 'Error en scripts/arribos_cli.js');
  const j = JSON.parse(res.stdout||'{}');
  return Array.isArray(j.arribos) ? j.arribos : [];
}

/* ---------------- Búsqueda por calle/intersección/paradas ---------------- */
function searchCalles(lineObj, queryText){ const Q=norm(queryText); const out=[]; lineObj.calles.forEach((c,idx)=>{ const d=String(c.descripcion||c.Descripcion||'').trim(); if(norm(d).includes(Q)) out.push({idx,desc:d}); }); return out; }
function listIntersections(calleObj){ const inters=calleObj?.intersecciones||calleObj?.Intersecciones||[]; return inters.map((i,idx)=>({idx,desc:String(i.descripcion||i.Descripcion||`Intersección ${idx+1}`).trim()})); }
function stopsOfIntersection(calleObj, iIdx){ const inter=(calleObj?.intersecciones||calleObj?.Intersecciones||[])[iIdx]; if(!inter) return []; const pars=inter.paradas||inter.Paradas||[]; return pars.map(p=>({ id:String(p.identificador||p.Identificador||p.parada||p.Parada||'s/n').trim(), lat:p.lat, lon:p.lon, maps:p.maps })); }

/* ---------------- Formateo de arribos ---------------- */
function fmtArribos(arr, { parada, linea, stopGeo=null }){
  const stopLine = getStopLineStr(parada, stopGeo);
  if (!arr.length) return `🚌 *${lineTitle(linea)}*\n${stopLine}\n\n_No hay arribos disponibles._`;

  // NUEVO: Ordenar para que "Arribando.." quede primero siempre
  arr.sort((a, b) => {
    const minA = (a.hora && a.hora.toLowerCase().includes('arribando')) ? 0 : ((a.minutos != null && a.minutos < 900) ? a.minutos : 9999);
    const minB = (b.hora && b.hora.toLowerCase().includes('arribando')) ? 0 : ((b.minutos != null && b.minutos < 900) ? b.minutos : 9999);
    return minA - minB;
  });

  const now = new Date();
  // ... el resto de la función sigue igual (const lines = arr.map...)
  const lines = arr.map(a=>{
    const realMin = (a.minutos != null && a.minutos < 900) ? a.minutos : null;
    const eta = (realMin != null) ? fmtTimeHHMM(new Date(now.getTime() + realMin*60000)) : null;
    const minTxt = (realMin != null) ? `${realMin} min` : (a.hora || '—');
    
    const ramal=a.ramal?` · ${a.ramal}`:'';
    const dest=a.destino?` → ${a.destino}`:'';
    const coche=a.interno?` · Coche ${a.interno}`:'';
    
    const ubicacion = (a.lat && a.lon) ? getCalleAproximada(a.lat, a.lon) : null;
    const ubicacionTxt = ubicacion ? `\n   📍 Aprox: ${ubicacion}` : '';
    const vmap = a.vehiculo_maps ? `\n   🗺️ Link: ${a.vehiculo_maps}` : '';
    
    const etaTxt=eta?` · ETA ${eta}`:'';
    return `• ${minTxt}${etaTxt}${ramal}${dest}${coche}${ubicacionTxt}${vmap}`;
  });
  return `🚌 *${lineTitle(linea)}*\n${stopLine}\n\n`+lines.join('\n  ───────────────\n');
}

/* ---------------- Teclados para paradas y seguimiento ---------------- */
function stopsKeyboard(paradas, linea){
  const rows=[];
  for (const p of paradas.slice(0,MAX_BTNS)){
    rows.push([
      { text:`⏱️ ${p.id} ${linea}`, callback_data:`arr_q:${p.id}:${linea}` },
      { text:`⭐ ${p.id} ${linea}`, callback_data:`fav_add:${p.id}:${linea}` },
    ]);
  }
  rows.push([{ text:'📄 Ver favoritos', callback_data:'fav_list' }]);
  return kb(rows);
}
function trackingKeyboardFromArribos(arribos, linea, parada){
  const rows=[]; 
  for(const a of arribos){
    if(!a.interno) continue;
    rows.push([{ text:`📡 Seguir coche ${a.interno}`, callback_data:`trk_start:${linea}:${parada}:${a.interno}` }]);
  }
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {};
}
function trackingStopKeyboard(linea, parada, interno){
  return { reply_markup: { inline_keyboard: [[{ text:'✋ Detener seguimiento', callback_data:`trk_stop:${linea}:${parada}:${interno}` }]] } };
}

/* ---------------- Estado conversacional ---------------- */
const STATE = new Map(); // chatId -> { stage, ... }

/* ---------------- Helpers de UI ---------------- */
function askMainStreet(chatId, linea){
  bot.sendMessage(chatId, `${lineTitle(linea)} seleccionada.\nEscribí parte del *nombre de la calle principal* (ej.: "RIVADAVIA", "BV ROCHA").`, { parse_mode:'Markdown' });
}
function showLinesMenu(chatId){
  LINES = loadLines();
  if (!LINES.length) return bot.sendMessage(chatId,'No encontré archivos "linea_*" en ./data');
  const rows=[]; let row=[];
  for (const l of LINES){
    row.push({ text: lineTitle(l.linea), callback_data: `sel_linea:${l.linea}` });
    if (row.length===3){ rows.push(row); row=[]; }
  }
  if (row.length) rows.push(row);
  bot.sendMessage(chatId,'Elegí un ramal/línea:', kb(rows));
}
function showFavsMenu(chatId){
  const favs = loadFavs(chatId);
  if (!favs.length) return bot.sendMessage(chatId,'No tenés favoritos guardados. Tocá ⭐ cuando veas las paradas.');
  bot.sendMessage(chatId, 'Tus favoritos:', listFavsKeyboard(chatId));
}
function showHelp(chatId) {
  const texto = `📖 *GUÍA DE USO Y COMANDOS*\n\n` +
    `*Búsqueda rápida:*\n` +
    `• /parada [nro] — Arribos de todas las líneas en una parada (ej. \`/parada 0026\`).\n` +
    `• /codigo [parada] [linea] — Arribos de una sola línea (ej. \`/codigo 0026 329\`).\n` +
    `• /menu — Buscá paradas navegando por las calles.\n\n` +
    `*Seguimiento en vivo:*\n` +
    `• /seguir [parada] [linea] [coche] — Fuerza el seguimiento de un coche específico, ideal si todavía está lejos y no figura en la lista (ej. \`/seguir 0026 329 44\`).\n\n` +
    `*Tus viajes:*\n` +
    `• /favs — Muestra tu lista de paradas guardadas con acceso rápido.\n\n` +
    `*Códigos de Líneas (Ramales):*\n` +
    `🚌 *329* = Ramal A\n` +
    `🚌 *330* = Ramal B\n` +
    `🚌 *331* = Ramal C\n` +
    `🚌 *332* = Ramal D\n` +
    `🚌 *333* = Ramal E`;
  
  bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
}
/* ---------------- Seguimiento de coche (lógica con avisos) ---------------- */
const TRACKERS = new Map(); // key: chatId:linea:interno -> { interval, msgId, startedAt, warnedAutostop, warnedETA5 }
const tKey = (chatId,linea,interno)=>`${chatId}:${linea}:${interno}`;

function buildTrackText({ linea, parada, stopGeo, coche }){
  const title = `📡 Seguimiento — ${lineTitle(linea)} · Coche ${coche.interno}`;
  const stopLine = getStopLineStr(parada, stopGeo);
  const now = new Date();
  
  const realMin = (coche.minutos != null && coche.minutos < 900) ? coche.minutos : null;
  const eta = (realMin != null) ? fmtTimeHHMM(new Date(now.getTime() + realMin*60000)) : null;
  const minTxt = (realMin != null) ? `${realMin} min` : (coche.hora || '—');
  
  const ramal = coche.ramal ? ` · ${coche.ramal}` : '';
  const dest = coche.destino ? ` → ${coche.destino}` : '';
  
  const ubicacion = (coche.lat && coche.lon) ? getCalleAproximada(coche.lat, coche.lon) : null;
  const ubicacionTxt = ubicacion ? `\n📍 Aprox: ${ubicacion}` : '';
  const vmap = coche.vehiculo_maps ? `\n🗺️ Link: ${coche.vehiculo_maps}` : (coche.lat!=null&&coche.lon!=null ? `\n🗺️ Link: https://www.google.com/maps?q=${coche.lat},${coche.lon}` : '');
  
  const upd = coche.actualizado ? `\n⏱️ ${coche.actualizado}` : '';
  const etaTxt = eta ? ` · ETA ${eta}` : '';
  
  return `${title}\n${stopLine}\n\n• ${minTxt}${etaTxt}${ramal}${dest}\nCoche ${coche.interno}${ubicacionTxt}${vmap}${upd}`;
}

async function startTracking({ chatId, linea, parada, interno }){
  await stopTracking({ chatId, linea, interno });

  const stopGeo = findStopGeo(linea, parada);

  const refresh = async (first=false, msgId=null)=>{
    try{
      const arribos = obtenerArribos(parada, linea) || [];
      const coche = arribos.find(a=>String(a.interno)===String(interno));
      let text;
      if (coche) text = buildTrackText({ linea, parada, stopGeo, coche });
      else text = `📡 Seguimiento — ${lineTitle(linea)} · Coche ${interno}\n${getStopLineStr(parada, stopGeo)}\n\n_No hay datos actuales. Reintento en ${Math.round(TRACK_REFRESH_MS/1000)}s._`;

      if (first){
        const sent=await bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview: true, ...trackingStopKeyboard(linea,parada,interno) });
        return { id: sent.message_id, coche };
      } else {
        await bot.editMessageText(text, { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', disable_web_page_preview: true, ...trackingStopKeyboard(linea,parada,interno) });
        return { id: msgId, coche };
      }
    }catch(e){
      const errText = `📡 Seguimiento — ${lineTitle(linea)} · Coche ${interno}\n_Error obteniendo datos. Reintento en ${Math.round(TRACK_REFRESH_MS/1000)}s._`;
      if (first){
        const sent = await bot.sendMessage(chatId, errText, { parse_mode:'Markdown', disable_web_page_preview: true, ...trackingStopKeyboard(linea,parada,interno) });
        return { id: sent.message_id, coche: null };
      } else {
        await bot.editMessageText(errText, { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', disable_web_page_preview: true, ...trackingStopKeyboard(linea,parada,interno) });
        return { id: msgId, coche: null };
      }
    }
  };

  const first = await refresh(true);
  const startedAt = Date.now();

  TRACKERS.set(tKey(chatId,linea,interno), {
    interval: null,
    msgId: first.id,
    startedAt,
    warnedAutostop: false,
    warnedETA5: false
  });

  const interval = setInterval(async ()=>{
    try{
      const key = tKey(chatId,linea,interno);
      const t = TRACKERS.get(key);
      if (!t) return;

      const elapsed = Date.now() - t.startedAt;
      const timeLeft = TRACK_MAX_MS - elapsed;
      if (timeLeft <= 0) {
        await stopTracking({ chatId, linea, interno });
        try { await bot.sendMessage(chatId, `⏹️ Seguimiento de coche ${interno} finalizado automáticamente.`); } catch {}
        return;
      }

      if (!t.warnedAutostop && timeLeft <= 2 * 60 * 1000) {
        t.warnedAutostop = true;
        try {
          await bot.sendMessage(chatId, `⏳ En *2 minutos* se detiene el seguimiento de *${lineTitle(linea)} — Coche ${interno}*.`, { parse_mode:'Markdown' });
        } catch {}
      }

      const { id: msgId, coche } = await (async () => {
        const cur = TRACKERS.get(key);
        return await refresh(false, (cur?.msgId || first.id));
      })();

      const cur = TRACKERS.get(key);
      if (cur) cur.msgId = msgId;

      if (coche && coche.minutos != null && coche.minutos <= 5 && !cur.warnedETA5) {
        cur.warnedETA5 = true;
        try {
          await bot.sendMessage(chatId, `🚏 *Arribo en ≤ 5 minutos* — ${lineTitle(linea)} · Coche ${interno}`, { parse_mode:'Markdown' });
        } catch {}
      }

    }catch{}
  }, TRACK_REFRESH_MS);

  const curKey = tKey(chatId,linea,interno);
  const cur = TRACKERS.get(curKey);
  if (cur) cur.interval = interval;
}

async function stopTracking({ chatId, linea, interno }){
  const key=tKey(chatId,linea,interno);
  const t=TRACKERS.get(key);
  if (t && t.interval) clearInterval(t.interval);
  TRACKERS.delete(key);
}

/* ---------------- /start y /ayuda ---------------- */
bot.onText(/^\/start$/, (msg)=>{
  const chatId=msg.chat.id;
  const menu = [
    [{ text:'🚌 Ver líneas disponibles', callback_data:'menu_lineas' }],
    [{ text:'⭐ Favoritos', callback_data:'menu_favs' }],
    [{ text:'🔎 Buscar por código', callback_data:'menu_buscar' }],
    [{ text:'📖 Ayuda e Instrucciones', callback_data:'menu_ayuda' }]
  ];
  const texto = `👋 *¡Bienvenido al Bot de La Nueva Perla by Rodney!*\n\nConsultá arribos en tiempo real y seguí a tu colectivo en el mapa.`;
  bot.sendMessage(chatId, texto, { parse_mode:'Markdown', reply_markup:{ inline_keyboard: menu } });
});

/* ---------------- /menu & /favs ---------------- */
bot.onText(/^\/ayuda$/i, (msg)=> showHelp(msg.chat.id));
bot.onText(/^\/menu$/, (msg)=> showLinesMenu(msg.chat.id));
bot.onText(/^\/favs|\/favoritos$/i, (msg)=> showFavsMenu(msg.chat.id));

/* ---------------- /codigo — directo o autoguiado ---------------- */
bot.onText(/^\/codigo(?:\s+(\d+)\s+(\d+))?$/, async (msg, match)=>{
  const chatId=msg.chat.id;
  const p=match[1], l=match[2];

  if (p && l) {
    try{
      const stopGeo = findStopGeo(l, p);
      const arr = obtenerArribos(p, l);
      const text = fmtArribos(arr, { parada:p, linea:l, stopGeo });
      return bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview: true, ...trackingKeyboardFromArribos(arr, l, p) });
    }catch(e){
      console.error(e);
      return bot.sendMessage(chatId, `❌ Error al consultar ${p} ${l}`);
    }
  }

  STATE.set(chatId, { stage:'ask_codigo_parada' });
  return bot.sendMessage(chatId, '📍 Decime el *código de parada* (ej: 0063):', { parse_mode:'Markdown' });
});

/* ---------------- /parada — directo o autoguiado (GLOBAL) ---------------- */
bot.onText(/^\/parada(?:\s+(\d+))?$/, async (msg, match)=>{
  const chatId=msg.chat.id;
  const parada=match[1];

  if (!parada) {
    STATE.set(chatId, { stage:'ask_parada_only' });
    return bot.sendMessage(chatId, '📍 Decime el *código de parada* (ej: 0063):', { parse_mode:'Markdown' });
  }

  LINES = loadLines();
  if (!LINES.length) return bot.sendMessage(chatId,'No encontré líneas cargadas.');

  let stopGeo = null;
  for (const l of LINES) {
    const g = findStopGeo(l.linea, parada);
    if (g && (g.name || g.maps || (g.lat!=null && g.lon!=null))) { stopGeo = g; break; }
  }
  const stopLine = getStopLineStr(parada, stopGeo);

  const all=[];
  for (const l of LINES){
    try{
      const arr = obtenerArribos(parada, l.linea);
      for (const a of arr) {
        let sortMin = 9999;
        if (a.hora && a.hora.toLowerCase().includes('arribando')) {
          sortMin = 0; // Prioridad máxima a los que están llegando
        } else if (a.minutos != null && a.minutos < 900) {
          sortMin = a.minutos;
        }
        all.push({ ...a, linea:l.linea, sortMin });
      }
    }catch{}
  }
  if (!all.length) return bot.sendMessage(chatId, `🚌 *Llegadas a parada ${parada} (todas las líneas)*\n${stopLine}\n\n_No se encontraron arribos._`, { parse_mode:'Markdown', disable_web_page_preview: true });

  all.sort((a,b)=> a.sortMin - b.sortMin);

  const now=new Date();
  const textLines = all.map(a=>{
    const realMin = (a.minutos != null && a.minutos < 900) ? a.minutos : null;
    const eta = (realMin != null) ? fmtTimeHHMM(new Date(now.getTime() + realMin*60000)) : '';
    const minTxt = (realMin != null) ? `${realMin} min` : (a.hora || '—');
    
    const coche=a.interno?` · Coche ${a.interno}`:'';
    const ramal=a.ramal?` · ${a.ramal}`:'';
    const dest=a.destino?` → ${a.destino}`:'';
    const etaTxt=eta?` · ETA ${eta}`:'';
    
    const ubicacion = (a.lat && a.lon) ? getCalleAproximada(a.lat, a.lon) : null;
    const ubicacionTxt = ubicacion ? `\n   📍 Aprox: ${ubicacion}` : '';
    const vmap = a.vehiculo_maps ? `\n   🗺️ Link: ${a.vehiculo_maps}` : '';
    
    return `• ${minTxt}${etaTxt}${ramal}${dest}${coche} (${lineTitle(a.linea)})${ubicacionTxt}${vmap}`;
  }).join('\n  ───────────────\n');

  const trkRows=[]; 
  for (const a of all) {
    if (!a.interno) continue;
    trkRows.push([{ text:`📡 Seguir coche ${a.interno} (${a.ramal})`, callback_data:`trk_start:${a.linea}:${parada}:${a.interno}` }]);
  }
  const replyMarkup = trkRows.length ? { reply_markup: { inline_keyboard: trkRows } } : {};

  bot.sendMessage(chatId, `🚌 *Llegadas a parada ${parada} (todas las líneas)*\n${stopLine}\n\n${textLines}`, { parse_mode:'Markdown', disable_web_page_preview: true, ...replyMarkup });
});

/* ---------------- Mensajes de texto (autoguiados + flujo por calle) ---------------- */
bot.on('message', (msg)=>{
  const chatId=msg.chat.id;
  const text=msg.text||'';
  if (text.startsWith('/')) return;

  const st=STATE.get(chatId);
  if (!st) return;

  if (st.stage === 'ask_parada_only') {
    const p = (text||'').trim();
    if (!/^\d{3,}$/.test(p)) return bot.sendMessage(chatId, 'El código debe ser numérico (ej: 0063). Probá de nuevo.');
    STATE.delete(chatId);
    return bot.emit('text', { ...msg, text:`/parada ${p}` });
  }

  if (st.stage === 'ask_codigo_parada') {
    const p=(text||'').trim();
    if (!/^\d{3,}$/.test(p)) return bot.sendMessage(chatId, 'El código debe ser numérico (ej: 0063). Probá de nuevo.');
    STATE.set(chatId, { stage:'ask_codigo_linea', parada:p });

    LINES = loadLines();
    const rows=[]; let row=[];
    for (const l of LINES){
      row.push({ text: lineTitle(l.linea), callback_data:`ask_codigo_pickline:${p}:${l.linea}` });
      if (row.length===3){ rows.push(row); row=[]; }
    }
    if (row.length) rows.push(row);
    return bot.sendMessage(chatId, 'Elegí la *línea* (ramal):', { parse_mode:'Markdown', reply_markup:{ inline_keyboard: rows } });
  }

  if (st.stage === 'ask_codigo_linea') {
    const l=(text||'').trim();
    if (!/^\d{3,}$/.test(l)) return bot.sendMessage(chatId, 'La línea debe ser numérica (ej: 329). Probá de nuevo.');
    const p=st.parada;
    STATE.delete(chatId);
    return bot.emit('text', { ...msg, text:`/codigo ${p} ${l}` });
  }

  if (st.stage === 'wait_main' && st.linea) {
    const lobj = LINES.find(l=>l.linea===st.linea);
    if (!lobj) return bot.sendMessage(chatId, 'No reconozco la línea. Usá /menu');
    const found = searchCalles(lobj, text);
    if (!found.length) return bot.sendMessage(chatId, 'No encontré calles con ese texto. Probá otra parte del nombre.');

    const slice=found.slice(0,MAX_BTNS);
    const rows=slice.map(it=>[{ text: it.desc, callback_data:`sel_calle:${st.linea}:${it.idx}` }]);
    const extra=found.length>MAX_BTNS?`\n\n(Mostrando ${MAX_BTNS}/${found.length}. Refiná la búsqueda.)`:'';
    bot.sendMessage(chatId, `Calles que coinciden:${extra}`, kb(rows));
  }

  if (st.stage === 'rename_fav' && st.fav) {
    const txt=text.trim();
    STATE.set(chatId, { stage:'idle' });
    if (!txt || txt.startsWith('/')) return bot.sendMessage(chatId,'Renombrado cancelado.');
    const ok=setFavName(chatId, st.fav.parada, st.fav.linea, txt);
    if (ok){ bot.sendMessage(chatId, `Listo. Guardado como: *${txt}* (${st.fav.parada} ${st.fav.linea})`, { parse_mode:'Markdown' }); return showFavsMenu(chatId); }
    return bot.sendMessage(chatId, 'No encontré ese favorito para renombrar.');
  }
});

/* ---------------- Callbacks (botones) ---------------- */
bot.on('callback_query', async (q)=>{
  const chatId=q.message.chat.id;
  const data=q.data||'';

  try{
    if (data==='menu_lineas'){ bot.answerCallbackQuery(q.id); return showLinesMenu(chatId); }
    if (data==='menu_favs'){   bot.answerCallbackQuery(q.id); return showFavsMenu(chatId); }
    if (data==='menu_buscar'){
      bot.answerCallbackQuery(q.id);
      const texto=`Usá:\n\n• */codigo* 0063 329 — parada + línea\n• */parada* 0063 — global (todas las líneas)`;
      return bot.sendMessage(chatId, texto, { parse_mode:'Markdown' });
    }
    if (data==='menu_ayuda'){ bot.answerCallbackQuery(q.id); return showHelp(chatId); }

    if (data.startsWith('sel_linea:')){
      const linea=data.split(':')[1];
      STATE.set(chatId, { stage:'wait_main', linea });
      bot.answerCallbackQuery(q.id, { text: lineTitle(linea) });
      return askMainStreet(chatId, linea);
    }

    if (data.startsWith('sel_calle:')){
      const [, linea, cIdxStr] = data.split(':');
      const cIdx=Number(cIdxStr);
      const lobj=LINES.find(l=>l.linea===linea);
      if (!lobj){ bot.answerCallbackQuery(q.id,{text:'Línea no disponible'}); return; }
      const calleObj=lobj.calles[cIdx];
      if (!calleObj){ bot.answerCallbackQuery(q.id,{text:'Calle inválida'}); return; }

      const ints=listIntersections(calleObj);
      if (!ints.length){ bot.answerCallbackQuery(q.id,{text:'Sin intersecciones'}); return bot.sendMessage(chatId,'Esa calle no tiene intersecciones cargadas.'); }
      const rows=ints.slice(0,MAX_BTNS).map(it=>[{ text: it.desc, callback_data:`sel_inter:${linea}:${cIdx}:${it.idx}` }]);
      STATE.set(chatId, { stage:'wait_inter', linea, cIdx });
      bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, `Intersecciones de: ${calleObj.descripcion}\n(${lineTitle(linea)})`, kb(rows));
    }

    if (data.startsWith('sel_inter:')){
      const [, linea, cIdxStr, iIdxStr] = data.split(':');
      const cIdx=Number(cIdxStr), iIdx=Number(iIdxStr);
      const lobj=LINES.find(l=>l.linea===linea);
      if (!lobj){ bot.answerCallbackQuery(q.id,{text:'Línea no disponible'}); return; }
      const calleObj=lobj.calles[cIdx];
      const paradas=stopsOfIntersection(calleObj, iIdx);
      bot.answerCallbackQuery(q.id);
      if (!paradas.length) return bot.sendMessage(chatId,'No hay paradas cargadas en esa intersección.');
      const interDesc=(calleObj.intersecciones||[])[iIdx]?.descripcion||'';
      const parts=paradas.map(p=>{ const url=p.maps||(p.lat!=null&&p.lon!=null?`https://www.google.com/maps?q=${p.lat},${p.lon}`:''); return `• Parada ${p.id}${url?`\n  ${url}`:''}`; }).join('\n');
      return bot.sendMessage(chatId, `${lineTitle(linea)}\nCalle: ${calleObj.descripcion}\nIntersección: ${interDesc}\n\n${parts}`, stopsKeyboard(paradas, linea));
    }

    if (data.startsWith('arr_q:')){
      const [, parada, linea] = data.split(':');
      bot.answerCallbackQuery(q.id, { text:`Consultando ${parada} ${linea}…` });
      try{
        const stopGeo = findStopGeo(linea, parada);
        const arr = obtenerArribos(parada, linea);
        const text = fmtArribos(arr, { parada, linea, stopGeo });
        return bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview: true, ...trackingKeyboardFromArribos(arr, linea, parada) });
      }catch(e){
        console.error('arr_q error:', e);
        return bot.sendMessage(chatId, `No pude obtener arribos para ${parada} ${linea}.`);
      }
    }

    if (data.startsWith('fav_add:')){
      const [, parada, linea] = data.split(':');
      const { added } = addFav(chatId, parada, linea);
      bot.answerCallbackQuery(q.id, { text: added ? 'Favorito guardado' : 'Ya existía' });
      STATE.set(chatId, { stage:'rename_fav', fav:{ parada, linea } });
      return bot.sendMessage(chatId, `¿Querés darle un nombre? Mandame el texto ahora.\nSi no, enviá /skip.`);
    }
    if (data === 'fav_list'){ bot.answerCallbackQuery(q.id); return showFavsMenu(chatId); }
    if (data.startsWith('fav_go:')){
      const [, parada, linea] = data.split(':');
      bot.answerCallbackQuery(q.id, { text:`${parada} ${linea}` });
      try{
        const stopGeo=findStopGeo(linea, parada);
        const arr=obtenerArribos(parada, linea);
        const text=fmtArribos(arr, { parada, linea, stopGeo });
        return bot.sendMessage(chatId, text, { parse_mode:'Markdown', disable_web_page_preview: true, ...trackingKeyboardFromArribos(arr, linea, parada) });
      }catch(e){
        console.error('fav_go error:', e);
        return bot.sendMessage(chatId, `No pude obtener arribos para ${parada} ${linea}.`);
      }
    }
    if (data.startsWith('fav_rename:')){
      const [, parada, linea] = data.split(':');
      STATE.set(chatId, { stage:'rename_fav', fav:{ parada, linea } });
      bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, `Escribí el nuevo nombre para *${parada} ${linea}*.\n(Enviá /skip para cancelar)`, { parse_mode:'Markdown' });
    }
    if (data.startsWith('fav_del:')){
      const [, parada, linea] = data.split(':');
      const ok=delFav(chatId, parada, linea);
      bot.answerCallbackQuery(q.id, { text: ok ? 'Eliminado' : 'No estaba guardado' });
      return showFavsMenu(chatId);
    }

    if (data.startsWith('ask_codigo_pickline:')) {
      const [, parada, linea] = data.split(':');
      bot.answerCallbackQuery(q.id, { text: lineTitle(linea) });
      STATE.delete(chatId);
      return bot.emit('text', { ...q.message, text: `/codigo ${parada} ${linea}` });
    }

    if (data.startsWith('trk_start:')){
      const [, linea, parada, interno] = data.split(':');
      bot.answerCallbackQuery(q.id, { text:`Siguiendo coche ${interno}…` });
      await startTracking({ chatId, linea, parada, interno });
      return;
    }
    if (data.startsWith('trk_stop:')){
      const [, linea, parada, interno] = data.split(':');
      bot.answerCallbackQuery(q.id, { text:`Seguimiento detenido` });
      await stopTracking({ chatId, linea, interno });
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id:chatId, message_id:q.message.message_id }); } catch {}
      return;
    }

    if (data==='noop'){ return bot.answerCallbackQuery(q.id); }

  }catch(e){
    console.error('callback_query error:', e);
    try{ await bot.answerCallbackQuery(q.id, { text:'Error', show_alert:true }); }catch{}
  }
});
/* ---------------- /seguir — forzar seguimiento manual ---------------- */
bot.onText(/^\/seguir(?:\s+(\d+)\s+(\d+)\s+(\d+))?$/, async (msg, match)=>{
  const chatId = msg.chat.id;
  const parada = match[1];
  const linea = match[2];
  const interno = match[3];

  if (parada && linea && interno) {
    // Verificamos si la línea existe
    LINES = loadLines();
    const lobj = LINES.find(l => l.linea === String(linea));
    if (!lobj) return bot.sendMessage(chatId, `❌ La línea ${linea} no existe.`);

    bot.sendMessage(chatId, `📡 *Forzando seguimiento*\nBuscando al Coche ${interno} de la ${lineTitle(linea)} hacia la Parada ${parada}...\n\n_(Si está muy lejos, dirá "Sin datos" hasta que se acerque)_`, { parse_mode: 'Markdown' });
    await startTracking({ chatId, linea, parada, interno });
    return;
  }

  // Si el usuario escribe solo /seguir o le faltan datos, le mostramos la ayuda
  bot.sendMessage(chatId, 'Para forzar el seguimiento de un coche específico, usá el formato:\n`/seguir [parada] [linea] [coche]`\n\nEjemplo: `/seguir 0063 329 50`', { parse_mode: 'Markdown' });
});

console.log('[OK] Bot listo: /start /menu /codigo /parada /favs + seguimiento 📡 (autostop 10 min + avisos)');
