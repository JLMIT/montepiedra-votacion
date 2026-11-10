// Votación por alícuotas — Condominio Montepiedra.
// Las reglas de Firestore (firestore.rules) validan en el servidor: código por propiedad, un solo uso,
// un voto por propiedad y tema, y que nadie más que la administración lea votos antes del cierre.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, collection, query, where, onSnapshot, getDoc, getDocs, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { UNITS } from "./unidades.js";

const VERSION = "202611101400";
const fb = initializeApp({
  apiKey: "AIzaSyBtB3udh8TelPW1bS2MQJZA1GfQxxTc7WI",
  authDomain: "montepiedra-f6ce2.firebaseapp.com",
  projectId: "montepiedra-f6ce2",
  storageBucket: "montepiedra-f6ce2.firebasestorage.app",
  messagingSenderId: "1004453060393",
  appId: "1:1004453060393:web:5c6415cd7db8566a482138",
});
const auth = getAuth(fb);
const db = getFirestore(fb);

/* ---------- data helpers ---------- */
const TOTAL = UNITS.reduce((s, u) => s + u.a, 0);
const U = {}; UNITS.forEach(u => U[u.k] = u);
const SORTED = UNITS.slice().sort((a, b) => a.n.localeCompare(b.n, "es", { numeric: true }));
const sh = k => U[k] ? U[k].a / TOTAL : 0;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtP = (x, d = 3) => (x * 100).toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
const fmtT = iso => { try { return iso ? new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""; } catch (e) { return ""; } };
const fmtDT = iso => { try { return iso ? new Date(iso).toLocaleString("es-CL") : ""; } catch (e) { return ""; } };
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const isYes = o => norm(o) === "si";
const isAbst = o => /abst|blanco|nulo/.test(norm(o));
const optColor = (o, i) => isYes(o) ? "var(--yes)" : norm(o) === "no" ? "var(--no)" : isAbst(o) ? "var(--abs)" : ["#2f5d8a", "#b8862b", "#6b4c9a", "#2f8a86", "#a3577a"][i % 5];
const EPS = 1e-12;
const street = n => n.replace(/\s*\d+\s*$/, "").trim();
const byName = (a, b) => U[a].n.localeCompare(U[b].n, "es", { numeric: true });
const iso = v => v && typeof v.toDate === "function" ? v.toDate().toISOString() : (v || "");
const MESA = "mesa";

const TYPES = {
  ORD: { label: "Ordinaria", q: 0.33, qStrict: false, base: "presentes", thr: 0.5, strict: true, rule: "Mayoría absoluta de los derechos presentes", qLabel: "33% del total" },
  EXA: { label: "Extraordinaria de mayoría absoluta", q: 0.5, qStrict: true, base: "total", thr: 0.5, strict: true, rule: "Más del 50% del total de derechos", qLabel: "más del 50% del total" },
  EXR: { label: "Extraordinaria de mayoría reforzada", q: 0.66, qStrict: false, base: "total", thr: 0.66, strict: false, rule: "66% del total de derechos", qLabel: "66% del total" },
};
const typeOf = it => TYPES[it && it.type] || TYPES.ORD;

/* ---------- state ---------- */
const S = { config: {}, inhab: {}, stats: null, codes: null, items: {}, reg: {}, attend: {}, votes: {}, admins: [] };
let UID = null, EMAIL = "", ADMIN = false, TAB = "votar", screenSel = null, assistOpt = "", assistItem = "";
const pick = {};
let unsubs = [];

/* ---------- ui helpers ---------- */
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), ms); }
function setStatus(msg, kind) { $("#status").innerHTML = msg ? `<div class="banner ${kind || "info"}">${msg}</div>` : ""; }
function setHTML(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }
function errMsg(e) {
  if (typeof e === "string") return e;
  const c = e && e.code || "";
  if (c.includes("permission-denied")) return "No tiene permiso para esta acción.";
  if (c.includes("unavailable") || c.includes("network")) return "Sin conexión. Revise su internet e intente de nuevo.";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "Se cerró la ventana de ingreso.";
  if (c.includes("resource-exhausted")) return "Servicio ocupado. Intente de nuevo en unos segundos.";
  return (e && e.message) || "Error inesperado.";
}
function modal(html) { $("#modal-box").innerHTML = html; $("#modal").classList.add("on"); }
function closeModal() { $("#modal").classList.remove("on"); }
function ask(title, body, ok = "Confirmar", danger = false) {
  return new Promise(res => {
    modal(`<h3 style="margin-top:0">${esc(title)}</h3><p class="muted">${body}</p><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" id="m-no">Cancelar</button><button class="btn ${danger ? "danger" : "pri"}" id="m-ok">${esc(ok)}</button></div>`);
    $("#m-no").onclick = () => { closeModal(); res(false); };
    $("#m-ok").onclick = () => { closeModal(); res(true); };
  });
}
function infoModal(title, html) { modal(`<h3 style="margin-top:0">${esc(title)}</h3>${html}<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn pri" id="m-ok">Entendido</button></div>`); $("#m-ok").onclick = closeModal; }
async function copyText(txt, label) {
  try { await navigator.clipboard.writeText(txt); toast(label + " copiado al portapapeles."); }
  catch (e) {
    modal(`<h3 style="margin-top:0">${esc(label)}</h3><p class="muted small">Seleccione y copie el texto (Ctrl/Cmd + C).</p><textarea readonly id="m-txt">${esc(txt)}</textarea><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn pri" id="m-ok">Cerrar</button></div>`);
    $("#m-ok").onclick = closeModal; const ta = $("#m-txt"); ta.focus(); ta.select();
  }
}
async function sha256(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const claveOf = (k, code) => sha256(k + "|" + normCode(code));
function genCode() { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint8Array(8)); let s = ""; r.forEach(x => s += A[x % 32]); return s.slice(0, 4) + "-" + s.slice(4); }
const items = () => Object.entries(S.items).map(([id, d]) => ({ id, ...d })).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
const ownerOf = rg => rg && rg.uid;
const myUnits = () => Object.keys(S.reg).filter(k => U[k] && S.reg[k].uid === UID).sort(byName);
function unitOptions() {
  let h = "", cur = null;
  SORTED.forEach(u => {
    const st = street(u.n); if (st !== cur) { if (cur !== null) h += "</optgroup>"; h += `<optgroup label="${esc(st)}">`; cur = st; }
    h += `<option value="${u.k}">${esc(u.n)}  (${fmtP(sh(u.k), 3)})</option>`;
  });
  return h + "</optgroup>";
}
function groupLabels() {
  const first = {};
  for (const k in S.reg) { const r = S.reg[k]; if (!r.uid || r.uid === MESA) continue; if (!first[r.uid] || r.at < first[r.uid]) first[r.uid] = r.at; }
  const map = { [MESA]: "Mesa" };
  Object.keys(first).sort((a, b) => String(first[a]).localeCompare(String(first[b]))).forEach((d, i) => map[d] = "Votante " + (i + 1));
  return map;
}
async function batched(ops) { // ops: [["set"|"delete", ref, data?]] in chunks under the 500 limit
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([t, ref, data]) => t === "set" ? b.set(ref, data) : b.delete(ref));
    await b.commit();
  }
}

/* ---------- core calculation ---------- */
function presentSet(votes) {
  const set = new Set();
  for (const k in S.reg) if (U[k] && !S.inhab[k]) set.add(k);
  for (const k in S.attend) if (U[k] && !S.inhab[k]) set.add(k);
  if (votes) for (const k in votes) if (U[k]) set.add(k);
  return set;
}
function shareOf(set) { let s = 0; set.forEach(k => s += sh(k)); return s; }
function compute(id, forceLive) {
  const it = S.items[id]; if (!it) return null;
  if (!forceLive && it.status === "closed" && it.final) return it.final;
  const T = typeOf(it), votes = S.votes[id] || {};
  const pres = presentSet(votes), presShare = shareOf(pres);
  const opts = it.options || [];
  const tot = {}, cnt = {}; opts.forEach(o => { tot[o] = 0; cnt[o] = 0; });
  let votedShare = 0, votedN = 0;
  for (const k in votes) { const o = votes[k].option; if (!U[k] || !(o in tot)) continue; tot[o] += sh(k); cnt[o]++; votedShare += sh(k); votedN++; }
  const base = T.base === "presentes" ? presShare : 1;
  const quorumOk = T.qStrict ? presShare > T.q + EPS : presShare >= T.q - EPS;
  const meets = x => base > 0 && (T.strict ? x / base > T.thr + EPS : x / base >= T.thr - EPS);
  let passed = false, winner = null, verdict;
  const yes = opts.find(isYes);
  if (yes) { passed = meets(tot[yes]); winner = passed ? yes : null; verdict = passed ? "APROBADO" : "RECHAZADO"; }
  else {
    const c = opts.filter(o => !isAbst(o)).sort((a, b) => tot[b] - tot[a]);
    const tie = c.length > 1 && Math.abs(tot[c[0]] - tot[c[1]]) < EPS;
    passed = !!c[0] && !tie && meets(tot[c[0]]); winner = passed ? c[0] : null;
    verdict = passed ? "GANA: " + c[0] : "SIN MAYORÍA REQUERIDA";
  }
  if (!quorumOk) { passed = false; winner = null; verdict = "SIN QUÓRUM DE CONSTITUCIÓN"; }
  return { type: it.type || "ORD", base, baseKind: T.base, thr: T.thr, strict: T.strict, presShare, presN: pres.size, presUnits: [...pres].sort(byName), tot, cnt, votedShare, votedN, quorumOk, passed, winner, verdict, at: new Date().toISOString() };
}
function attendance() { // admins compute it live; voters read the summary the admin publishes
  if (ADMIN) { const p = presentSet(); return { n: p.size, share: shareOf(p) }; }
  return S.stats ? { n: S.stats.n || 0, share: S.stats.share || 0 } : { n: 0, share: 0 };
}

/* ---------- actions ---------- */
let fails = 0, lockUntil = 0;
async function register(k, code, name, via) {
  if (!UID) throw "Conectando… intente de nuevo en unos segundos.";
  if (!U[k]) throw "Seleccione la propiedad de la lista.";
  if (S.inhab[k]) throw `${U[k].n} está inhabilitada para votar. Consulte en la mesa.`;
  if (Date.now() < lockUntil) throw `Demasiados intentos fallidos. Espere ${Math.ceil((lockUntil - Date.now()) / 1000)} segundos.`;
  const clave = await claveOf(k, code);
  const c = await getDoc(doc(db, "claves", clave));
  if (!c.exists() || c.data().unit !== k) { if (++fails >= 5) { lockUntil = Date.now() + 30000; fails = 0; } throw `El código no corresponde a ${U[k].n}. Revise que eligió la propiedad correcta.`; }
  fails = 0;
  const owner = via === "mesa" ? MESA : UID, ref = doc(db, "reg", k);
  const used = `El código de ${U[k].n} ya fue utilizado. Si cree que es un error, avise a la mesa.`;
  let cur;
  try { cur = await getDoc(ref); } catch (e) { throw used; }
  if (cur.exists()) { if (cur.data().uid === owner) return "ya"; throw used; }
  try { await setDoc(ref, { unit: k, uid: owner, clave, name: String(name || "").slice(0, 80), at: serverTimestamp(), via }); }
  catch (e) { throw errMsg(e).startsWith("No tiene permiso") ? used : errMsg(e); }
  return "ok";
}
async function castVotes(itemId, keys, opt, via) {
  const it = S.items[itemId];
  if (!it || it.status !== "open") throw "La votación de este tema no está abierta.";
  const owner = via === "mesa" ? MESA : UID, ok = [], errs = [];
  for (const k of keys) {
    const rg = S.reg[k];
    if (!rg || rg.uid !== owner) { errs.push(`${U[k].n} no está inscrita aquí.`); continue; }
    if ((S.votes[itemId] || {})[k]) { errs.push(`${U[k].n} ya votó en este tema.`); continue; }
    try {
      await setDoc(doc(db, "votos", `${itemId}__${k}`), { item: itemId, unit: k, option: opt, at: serverTimestamp(), uid: owner, channel: via, name: rg.name || "" });
      ok.push(k);
    } catch (e) { errs.push(errMsg(e).startsWith("No tiene permiso") ? `${U[k].n}: el voto no fue aceptado (ya votó, la votación cerró o la propiedad no está habilitada).` : `${U[k].n}: ${errMsg(e)}`); }
  }
  return { ok, errs };
}
async function deleteWhere(col, field, value) {
  const q = field ? query(collection(db, col), where(field, "==", value)) : collection(db, col);
  const s = await getDocs(q); await batched(s.docs.map(d => ["delete", d.ref]));
}

/* ---------- rendering ---------- */
let rq = false;
function sched() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function render() {
  const a = attendance();
  $("#h-title").textContent = S.config.name || "Asamblea de copropietarios";
  setHTML($("#h-quorum"), `Asistencia: <b>${fmtP(a.share, 2)}</b> de los derechos · ${a.n} de ${UNITS.length} propiedades${S.config.date ? " · " + esc(S.config.date.split("-").reverse().join("-")) : ""}`);
  $("#nav-admin").classList.toggle("hide", !ADMIN);
  $("#btn-admin").classList.toggle("hide", ADMIN);
  $("#btn-out").classList.toggle("hide", !EMAIL);
  $("#foot-who").textContent = EMAIL ? `Sesión: ${EMAIL}${ADMIN ? " (administración)" : " (sin permisos de administración)"} · versión ${VERSION}` : `Votación por alícuotas · Condominio Montepiedra · versión ${VERSION}`;
  if (TAB === "votar") renderVotar();
  if (TAB === "pantalla") renderScreen();
  if (TAB === "admin" && ADMIN) renderAdmin();
  if (ADMIN) publishStats();
}
let statsT = null;
function publishStats() { // one small summary document so voters' phones don't read every inscription
  const p = presentSet(), n = p.size, share = Math.round(shareOf(p) * 1e7) / 1e7;
  if (S.stats && S.stats.n === n && Math.abs((S.stats.share || 0) - share) < 1e-9) return;
  clearTimeout(statsT); statsT = setTimeout(() => setDoc(doc(db, "stats", "asistencia"), { n, share, at: serverTimestamp() }).catch(() => {}), 1500);
}
function barsHTML(r, opts) {
  const thrPct = r.thr * 100;
  const baseTxt = r.baseKind === "presentes" ? "de los derechos presentes" : "del total de derechos";
  let h = `<div class="bars">`;
  opts.forEach((o, i) => {
    const v = r.base > 0 ? (r.tot[o] || 0) / r.base : 0;
    const showThr = (isYes(o) || !opts.some(isYes)) && !isAbst(o);
    h += `<div class="bar"><div class="lab"><span>${esc(o)} <span class="muted small">· ${r.cnt[o] || 0} prop.</span></span><b>${fmtP(v, 2)}</b></div>
      <div class="track"><div class="fill" style="width:${Math.min(100, v * 100)}%;background:${optColor(o, i)}"></div>${showThr ? `<div class="thr" style="left:${thrPct}%"><span class="thrlab">${r.strict ? "más de" : "mínimo"} ${thrPct.toFixed(0)}%</span></div>` : ""}</div></div>`;
  });
  const rest = r.base > 0 ? Math.max(0, (r.base - r.votedShare) / r.base) : 0;
  h += `<div class="bar"><div class="lab"><span class="muted">${r.baseKind === "presentes" ? "Presentes que no votaron" : "No votaron o ausentes"}</span><b class="muted">${fmtP(rest, 2)}</b></div><div class="track"><div class="fill" style="width:${rest * 100}%;background:var(--none)"></div></div></div>`;
  return h + `<p class="muted small" style="margin:6px 0 0">Porcentajes ${baseTxt} (base: ${fmtP(r.base, 3)} del condominio).</p></div>`;
}
function statusBadge(it) { if (it.status === "closing") return `<span class="badge b-closed">Cerrando…</span>`; return it.status === "open" ? `<span class="badge b-open">Votación abierta</span>` : it.status === "closed" ? `<span class="badge b-closed">Cerrada</span>` : `<span class="badge b-draft">Borrador</span>`; }

/* ----- votar ----- */
function renderVotar() {
  const mine = myUnits();
  let p = "";
  if (mine.length) {
    const tot = mine.reduce((s, k) => s + sh(k), 0);
    p = `<div class="props">${mine.map(k => `<div class="p"><span>${esc(U[k].n)}${S.inhab[k] ? ` <span class="bad small">inhabilitada</span>` : ""}</span><span class="num">${fmtP(sh(k))}</span></div>`).join("")}
      <div class="p tot"><span>Su voto representa ${mine.length} ${mine.length === 1 ? "propiedad" : "propiedades"}</span><span class="num">${fmtP(tot)}</span></div></div>`;
  }
  setHTML($("#my-props"), p);
  const its = items(), open = its.filter(i => i.status === "open");
  let h = "";
  if (!open.length) h = `<div class="card"><div class="empty">No hay temas abiertos a votación en este momento.</div></div>`;
  for (const it of open) {
    const votes = S.votes[it.id] || {}, T = typeOf(it);
    const pend = mine.filter(k => !votes[k] && !S.inhab[k]), done = mine.filter(k => votes[k]);
    h += `<div class="card"><div class="row" style="justify-content:space-between"><h2>${esc(it.title)}</h2>${statusBadge(it)}</div>${it.desc ? `<p class="muted" style="margin:4px 0 6px;white-space:pre-wrap">${esc(it.desc)}</p>` : ""}<p class="small muted" style="margin:0 0 10px">${esc(T.label)} · se aprueba con: ${esc(T.rule)}</p>`;
    if (!mine.length) h += `<div class="empty">Inscriba su propiedad arriba para votar.</div>`;
    if (pend.length) {
      const sel = pick[it.id];
      h += `<div class="opts">${it.options.map(o => `<button class="opt ${sel === o ? "sel" : ""}" data-act="pick" data-i="${it.id}" data-o="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
      if (sel) h += `<div class="cfm"><span>Votará <b>«${esc(sel)}»</b> por ${pend.length === 1 ? esc(U[pend[0]].n) : `${pend.length} propiedades (${pend.map(k => esc(U[k].n)).join(", ")})`}, que suman <b>${fmtP(pend.reduce((s, k) => s + sh(k), 0))}</b> de los derechos. <span class="small">El voto no se puede modificar.</span></span><span class="row"><button class="btn" data-act="pick-clear" data-i="${it.id}">Cancelar</button><button class="btn pri" data-act="confirm" data-i="${it.id}">Confirmar voto</button></span></div>`;
    }
    if (done.length) {
      const opts = [...new Set(done.map(k => votes[k].option))];
      h += opts.length === 1 && !pend.length
        ? `<div class="done">✓ Votó «${esc(opts[0])}» por ${done.length === 1 ? esc(U[done[0]].n) : done.length + " propiedades"} (${fmtP(done.reduce((s, k) => s + sh(k), 0))}).</div>`
        : `<div class="ulist">${done.map(k => `<div><span>${esc(U[k].n)}</span><span class="good">✓ «${esc(votes[k].option)}» ${fmtT(votes[k].at)}</span></div>`).join("")}</div>`;
    }
    h += `<p class="small muted" style="margin:12px 0 0">Los resultados se publicarán cuando la administración cierre la votación.</p></div>`;
  }
  setHTML($("#v-open"), h);
  const closed = its.filter(i => i.status === "closed" && i.final);
  let c = "";
  if (closed.length) {
    c = `<div class="card"><h2>Resultados de temas cerrados</h2>`;
    for (const it of closed) { const r = it.final; c += `<div class="row" style="justify-content:space-between;padding:8px 0;border-top:1px dashed var(--line)"><span>${esc(it.title)}</span><span class="badge ${r.passed ? "b-yes" : "b-no"}">${esc(r.verdict)}</span></div>`; }
    c += `</div>`;
  }
  setHTML($("#v-closed"), c);
}

/* ----- pantalla ----- */
function autoItem() {
  const its = items(); const op = its.filter(i => i.status === "open");
  if (op.length) return op[op.length - 1].id;
  const cl = its.filter(i => i.status === "closed").sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")));
  return (cl[0] || {}).id || null;
}
function currentScreenItem() { if (screenSel && !S.items[screenSel]) screenSel = null; return screenSel || autoItem(); }
function renderScreen() {
  const its = items().filter(i => i.status !== "draft");
  const id = currentScreenItem();
  const pdfBtns = ADMIN ? `<span style="flex:1"></span><button class="btn sm pri" data-act="pdf-item" ${id && S.items[id] && S.items[id].status === "closed" ? "" : "disabled"} title="Disponible al cerrar la votación">Auditoría de este tema (PDF)</button><button class="btn sm" data-act="pdf-all" ${items().some(i => i.status === "closed") ? "" : "disabled"}>Auditoría de temas cerrados (PDF)</button>` : "";
  setHTML($("#s-pills"), (its.length ? `<button class="pill ${!screenSel ? "on" : ""}" data-act="sel" data-i="">Automático</button>` + its.map(it => `<button class="pill ${screenSel === it.id ? "on" : ""}" data-act="sel" data-i="${it.id}">${esc(it.title.length > 38 ? it.title.slice(0, 36) + "…" : it.title)}</button>`).join("") : "") + pdfBtns);
  const a = attendance(), ps = a.share;
  setHTML($("#s-side"), `<div class="card"><h3>Quórum de asistencia</h3><div class="kpi">${fmtP(ps, 2)}</div><div class="muted small">${a.n} de ${UNITS.length} propiedades presentes y habilitadas</div>
    <div class="meter"><div class="fill" style="width:${Math.min(100, ps * 100)}%"></div>${[33, 50, 66].map(p => `<div class="thr" style="left:${p}%"><span class="thrlab">${p}%</span></div>`).join("")}</div>
    <div class="small" style="margin-top:12px">${Object.values(TYPES).map(T => { const ok = T.qStrict ? ps > T.q + EPS : ps >= T.q - EPS; return `<div class="row" style="justify-content:space-between;padding:3px 0"><span>${esc(T.label)}</span><span class="${ok ? "good" : "bad"}">${ok ? "Cumple" : "No cumple"}</span></div>`; }).join("")}</div></div>`);
  if (!id || !S.items[id] || S.items[id].status === "draft") { setHTML($("#s-main"), `<div class="card big"><div class="empty">Aún no hay temas abiertos ni cerrados.</div></div>`); return; }
  const it = { id, ...S.items[id] }, T = typeOf(it), closed = it.status === "closed";
  const r = closed ? (it.final || compute(id)) : (ADMIN ? compute(id) : null);
  let h = `<div class="card big"><div class="row" style="justify-content:space-between">${statusBadge(it)}<span class="small muted">${esc(T.label)}</span></div><h2 style="margin-top:8px">${esc(it.title)}</h2>${it.desc ? `<p class="muted" style="white-space:pre-wrap">${esc(it.desc)}</p>` : ""}
    <p class="small muted" style="margin:0">Regla: ${esc(T.rule)} · quórum para sesionar: ${esc(T.qLabel)}</p>`;
  if (r) h += `<div class="row" style="gap:28px;margin:14px 0 4px"><div><div class="kpi">${r.votedN}</div><div class="small muted">propiedades votaron</div></div><div><div class="kpi">${fmtP(r.votedShare, 2)}</div><div class="small muted">de los derechos del condominio</div></div><div><div class="kpi">${fmtP(r.presShare > 0 ? r.votedShare / r.presShare : 0, 1)}</div><div class="small muted">participación sobre presentes</div></div></div>`;
  h += closed ? barsHTML(r, it.options) + `<div class="verdict ${r.passed ? "v-yes" : "v-no"}">${esc(r.verdict)}</div><p class="small muted" style="margin-bottom:0">Resultado congelado al cierre: ${fmtDT(it.closedAt || r.at)}.</p>`
    : `<div class="empty" style="margin-top:14px">Votación en curso. Los resultados se mostrarán cuando la administración cierre la votación.</div>`;
  setHTML($("#s-main"), h + `</div>`);
}

/* ----- admin ----- */
function renderAdmin() {
  const its = items();
  let h = its.length ? "" : `<div class="empty">Agregue el primer tema con el formulario de arriba.</div>`;
  its.forEach((it, n) => {
    const nv = Object.keys(S.votes[it.id] || {}).length, vs = Object.keys(S.votes[it.id] || {}).reduce((s, k) => s + sh(k), 0);
    h += `<div class="item"><div class="top"><div><b>${n + 1}. ${esc(it.title)}</b> ${statusBadge(it)}<div class="small muted">${esc(typeOf(it).label)} · opciones: ${esc((it.options || []).join(" / "))}</div></div>
      <div class="small" style="text-align:right">${nv} propiedades votaron · ${fmtP(vs, 2)} de derechos<br>${it.status === "closed" && it.final ? `<span class="badge ${it.final.passed ? "b-yes" : "b-no"}">${esc(it.final.verdict)}</span>` : ""}</div></div>
      <div class="acts">
        ${it.status === "draft" ? `<button class="btn sm pri" data-act="open" data-i="${it.id}">Abrir votación</button>` : ""}
        ${it.status === "open" ? `<button class="btn sm pri" data-act="close" data-i="${it.id}">Cerrar y publicar resultado</button>` : ""}
        ${it.status === "closed" ? `<button class="btn sm" data-act="reopen" data-i="${it.id}">Reabrir</button>` : ""}
        <button class="btn sm" data-act="show" data-i="${it.id}">Proyectar</button>
        <button class="btn sm" data-act="edit" data-i="${it.id}">Editar</button>
        <button class="btn sm" data-act="up" data-i="${it.id}" ${n === 0 ? "disabled" : ""}>↑</button>
        <button class="btn sm" data-act="down" data-i="${it.id}" ${n === its.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn sm danger" data-act="clear" data-i="${it.id}" ${nv ? "" : "disabled"}>Borrar votos</button>
        <button class="btn sm danger" data-act="del" data-i="${it.id}">Eliminar</button>
      </div></div>`;
  });
  setHTML($("#a-items"), h);

  const codes = (S.codes && S.codes.codes) || {}, nCodes = Object.keys(codes).length, nReg = Object.keys(S.reg).length;
  setHTML($("#a-codes"), `<div class="small" style="margin-bottom:10px">${nCodes ? `Listado vigente (${S.codes.source === "importados" ? "cargado desde Excel" : "generado aquí"}) del <b>${fmtDT(S.codes.gen)}</b>: ${nCodes} códigos, <b>${nReg}</b> ya utilizados.` : `<span class="bad">Aún no hay códigos cargados.</span>`}</div>
    <div class="row"><button class="btn ${nCodes ? "" : "pri"}" data-act="gen">Generar códigos al azar</button><button class="btn" data-act="import">Cargar listado desde Excel</button>${nCodes ? `<button class="btn" data-act="cards">Tarjetas para imprimir (PDF)</button><button class="btn" data-act="copy-codes">Copiar listado</button>` : ""}</div>`);

  const open = its.filter(i => i.status === "open");
  if (!open.find(i => i.id === assistItem)) assistItem = open[0] ? open[0].id : "";
  const ai = S.items[assistItem];
  if (ai && !(ai.options || []).includes(assistOpt)) assistOpt = "";
  setHTML($("#a-assist-dyn"), open.length ? `<label class="f" for="as-item">Tema abierto</label><select class="in" id="as-item">${open.map(i => `<option value="${i.id}" ${i.id === assistItem ? "selected" : ""}>${esc(i.title)}</option>`).join("")}</select>
    <label class="f">Opción</label><div class="opts">${(ai.options || []).map(o => `<button class="opt sm ${assistOpt === o ? "sel" : ""}" data-act="as-opt" data-o="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    <div class="row" style="margin-top:12px"><button class="btn pri" data-act="as-go">Registrar voto en la mesa</button></div>` : `<div class="empty" style="margin-top:10px">No hay temas abiertos.</div>`);

  const q = norm($("#u-search").value), G = groupLabels(), pres = presentSet();
  let rows = "", nInh = 0, sInh = 0;
  UNITS.forEach(u => { if (S.inhab[u.k]) { nInh++; sInh += sh(u.k); } });
  for (const u of SORTED) {
    if (q && !norm(u.n).includes(q) && !norm(codes[u.k]).includes(q)) continue;
    const nv = its.filter(it => (S.votes[it.id] || {})[u.k]).length, rg = S.reg[u.k];
    rows += `<tr><td>${esc(u.n)}</td><td class="r num">${fmtP(sh(u.k), 4)}</td><td class="mono small">${codes[u.k] ? esc(codes[u.k]) : "—"}</td>
      <td class="small">${rg ? `<span class="tag g">${esc(G[rg.uid] || "Votante")}</span> ${fmtT(rg.at)}${rg.name ? " · " + esc(rg.name) : ""} <button class="btn sm" data-act="release" data-k="${u.k}">Liberar</button>` : `<span class="muted">Sin inscribir</span>`}</td>
      <td><button class="toggle ${S.attend[u.k] ? "on" : ""}" data-act="t-pres" data-k="${u.k}" aria-label="Presente manual" ${S.inhab[u.k] ? "disabled" : ""}></button></td>
      <td><button class="toggle red ${S.inhab[u.k] ? "on" : ""}" data-act="t-inh" data-k="${u.k}" aria-label="Inhabilitada"></button></td>
      <td class="r num">${nv}</td></tr>`;
  }
  setHTML($("#u-body"), rows || `<tr><td colspan="7" class="muted">Sin coincidencias.</td></tr>`);
  const nVoters = new Set(Object.values(S.reg).map(r => r.uid)).size;
  setHTML($("#u-sum"), `Presentes y habilitadas: <b>${pres.size}</b> propiedades = <b>${fmtP(shareOf(pres), 3)}</b> de los derechos · Inscritas: <b>${nReg}</b> por <b>${nVoters}</b> votantes · Inhabilitadas: <b>${nInh}</b> (${fmtP(sInh, 3)}) · Total: ${UNITS.length} propiedades = 100%`);
  setHTML($("#a-admins"), S.admins.length ? S.admins.map(e => `<div class="row" style="justify-content:space-between;padding:6px 0;border-top:1px dashed var(--line)"><span>${esc(e)}${e === EMAIL ? ` <span class="tag g">usted</span>` : ""}</span>${e === EMAIL ? "" : `<button class="btn sm danger" data-act="admin-del" data-e="${esc(e)}">Quitar</button>`}</div>`).join("") : `<div class="muted small">Cargando…</div>`);
}

/* ---------- acta (text) ---------- */
function actaText() {
  const a = attendance();
  let t = `${S.config.name || "Asamblea de copropietarios"} — Condominio Montepiedra\n`;
  if (S.config.date) t += `Fecha: ${S.config.date.split("-").reverse().join("-")}\n`;
  t += `Asistencia actual: ${a.n} de ${UNITS.length} propiedades, ${fmtP(a.share, 3)} de los derechos.\n\n`;
  items().forEach((it, n) => {
    if (it.status !== "closed") return;
    const r = compute(it.id), T = typeOf(it);
    t += `${n + 1}. ${it.title}\n   Tipo: ${T.label}. Regla: ${T.rule}.\n   Cerrada: ${fmtDT(it.closedAt)}\n`;
    t += `   Derechos presentes al cierre: ${fmtP(r.presShare, 3)} (${r.presN} propiedades). Base de cálculo: ${fmtP(r.base, 3)}.\n`;
    (it.options || []).forEach(o => t += `   - ${o}: ${fmtP(r.tot[o] || 0, 3)} del condominio = ${fmtP(r.base > 0 ? (r.tot[o] || 0) / r.base : 0, 3)} de la base (${r.cnt[o] || 0} propiedades)\n`);
    t += `   Resultado: ${r.verdict}\n\n`;
  });
  return t;
}

/* ---------- PDF ---------- */
const GREEN = [47, 93, 70];
function newPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) throw "No se pudo cargar el generador de PDF. Revise la conexión y recargue la página.";
  return new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
}
const pdfPct = (x, d = 3) => (x * 100).toFixed(d).replace(".", ",") + "%";
async function auditPDF(ids) {
  const doc_ = newPDF(), W = doc_.internal.pageSize.getWidth(), M = 40, G = groupLabels(), now = new Date();
  const pres = presentSet(), ps = shareOf(pres);
  let y = M;
  const H = (txt, size = 13) => { if (y > 760) { doc_.addPage(); y = M; } doc_.setFont("helvetica", "bold"); doc_.setFontSize(size); doc_.setTextColor(31, 42, 36); doc_.text(txt, M, y); y += size + 6; };
  const P = (txt, size = 9.5) => { doc_.setFont("helvetica", "normal"); doc_.setFontSize(size); doc_.setTextColor(60, 66, 62); doc_.splitTextToSize(txt, W - 2 * M).forEach(l => { if (y > 800) { doc_.addPage(); y = M; } doc_.text(l, M, y); y += size + 3.5; }); };
  const T = (head, body, opts = {}) => { doc_.autoTable({ head: [head], body, startY: y, margin: { left: M, right: M }, styles: { fontSize: 8.2, cellPadding: 3, textColor: [31, 42, 36] }, headStyles: { fillColor: GREEN, textColor: 255 }, alternateRowStyles: { fillColor: [247, 245, 239] }, ...opts }); y = doc_.lastAutoTable.finalY + 14; };
  const evidence = JSON.stringify({ reg: Object.keys(S.reg).sort().map(k => [k, S.reg[k].uid, S.reg[k].at]), votes: ids.map(id => [id, Object.keys(S.votes[id] || {}).sort().map(k => [k, S.votes[id][k].option, S.votes[id][k].at])]) });
  const fp = (await sha256(evidence)).slice(0, 32).toUpperCase();
  doc_.setFillColor(...GREEN); doc_.rect(0, 0, W, 70, "F");
  doc_.setTextColor(255); doc_.setFont("helvetica", "bold"); doc_.setFontSize(17); doc_.text("Auditoría de votación", M, 34);
  doc_.setFont("helvetica", "normal"); doc_.setFontSize(10); doc_.text(`Condominio Montepiedra · ${S.config.name || "Asamblea de copropietarios"}${S.config.date ? " · " + S.config.date.split("-").reverse().join("-") : ""}`, M, 52);
  y = 92;
  P(`Generado: ${now.toLocaleString("es-CL")} por ${EMAIL} · ${ids.length === 1 ? "Alcance: un tema." : `Alcance: ${ids.length} temas.`} Huella de integridad (SHA-256 de inscripciones y votos): ${fp}.`);
  P("Cálculo: cada propiedad pesa su alícuota dividida por la suma de todas las alícuotas (100,00016% en la planilla, normalizado a 100%). Los resultados suman derechos, no personas. Una persona con poder inscribe varias propiedades y su voto se registra por cada una. Los votos y las inscripciones fueron validados por las reglas de seguridad del servidor: código correcto por propiedad, un solo uso por código y un voto por propiedad y tema.");
  y += 6;
  H("1. Quórum de asistencia");
  P(`Propiedades presentes y habilitadas: ${pres.size} de ${UNITS.length}, que representan ${pdfPct(ps)} de los derechos del condominio.`);
  T(["Tipo de sesión", "Asistencia mínima", "Asistencia actual", "Cumple"], Object.values(TYPES).map(Ty => [Ty.label, Ty.qLabel, pdfPct(ps), (Ty.qStrict ? ps > Ty.q + EPS : ps >= Ty.q - EPS) ? "Sí" : "No"]));
  const inh = Object.keys(S.inhab).filter(k => U[k]).sort(byName);
  if (inh.length) P(`Propiedades inhabilitadas para votar (${inh.length}, ${pdfPct(inh.reduce((s, k) => s + sh(k), 0))}): ${inh.map(k => U[k].n).join(", ")}.`);
  ids.forEach((id, n) => {
    const it = S.items[id]; if (!it) return;
    const r = compute(id), Ty = typeOf(it), votes = S.votes[id] || {};
    doc_.addPage(); y = M;
    H(`${n + 2}. ${it.title}`, 13);
    P(`Tipo: ${Ty.label}. Regla de aprobación: ${Ty.rule}. Quórum para sesionar: ${Ty.qLabel}.`);
    P(`Estado: ${it.status === "closed" ? "cerrada" : "abierta"}.${it.openedAt ? " Apertura: " + fmtDT(it.openedAt) : ""}${it.closedAt && it.status === "closed" ? " · Cierre: " + fmtDT(it.closedAt) : ""}`);
    P(`Derechos presentes al cierre: ${pdfPct(r.presShare)} (${r.presN} propiedades). Base de cálculo: ${pdfPct(r.base)} ${r.baseKind === "presentes" ? "(derechos presentes)" : "(total del condominio)"}.`);
    T(["Opción", "Propiedades", "% del condominio", "% de la base"], (it.options || []).map(o => [o, String(r.cnt[o] || 0), pdfPct(r.tot[o] || 0), pdfPct(r.base > 0 ? (r.tot[o] || 0) / r.base : 0)])
      .concat([["Votos emitidos", String(r.votedN), pdfPct(r.votedShare), pdfPct(r.base > 0 ? r.votedShare / r.base : 0)]]), { columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } } });
    doc_.setFont("helvetica", "bold"); doc_.setFontSize(12); doc_.setTextColor(...(r.passed ? [47, 125, 79] : [163, 49, 31]));
    doc_.text(`Resultado: ${r.verdict}`, M, y); y += 20;
    const vk = Object.keys(votes).filter(k => U[k]).sort(byName);
    H("Detalle de votos por propiedad", 10.5);
    T(["Propiedad", "Alícuota", "Voto", "Hora", "Canal", "Votante", "Nombre declarado"],
      vk.length ? vk.map(k => { const v = votes[k]; return [U[k].n, pdfPct(sh(k), 4), v.option, fmtT(v.at), v.channel === "mesa" ? "Mesa" : "Teléfono", G[v.uid] || "-", v.name || ""]; }) : [["Sin votos", "", "", "", "", "", ""]],
      { columnStyles: { 1: { halign: "right" } } });
    const noVote = (r.presUnits || []).filter(k => !votes[k]);
    if (noVote.length) { H("Presentes que no votaron", 10.5); P(`${noVote.length} propiedades (${pdfPct(noVote.reduce((s, k) => s + sh(k), 0))}): ${noVote.map(k => U[k].n).join(", ")}.`, 8.5); }
  });
  doc_.addPage(); y = M;
  H(`${ids.length + 2}. Registro de inscripciones y poderes`);
  const byU = {};
  Object.keys(S.reg).filter(k => U[k]).forEach(k => { const d = S.reg[k].uid; (byU[d] = byU[d] || []).push(k); });
  const owners = Object.keys(byU).sort((a, b) => String(G[a]).localeCompare(String(G[b]), "es", { numeric: true }));
  P(`${Object.keys(S.reg).length} propiedades inscritas con código por ${owners.length} votantes. Cada código se usó una sola vez.`);
  const body = [];
  owners.forEach(d => byU[d].sort((a, b) => String(S.reg[a].at).localeCompare(String(S.reg[b].at))).forEach((k, i) => body.push([i === 0 ? (G[d] || "-") : "", U[k].n, pdfPct(sh(k), 4), fmtT(S.reg[k].at), S.reg[k].via === "mesa" ? "Mesa" : "Teléfono", S.reg[k].name || "", i === 0 ? pdfPct(byU[d].reduce((s, x) => s + sh(x), 0)) : ""])));
  T(["Votante", "Propiedad", "Alícuota", "Inscripción", "Vía", "Nombre declarado", "Total votante"], body.length ? body : [["Sin inscripciones", "", "", "", "", "", ""]], { columnStyles: { 2: { halign: "right" }, 6: { halign: "right" } } });
  const manual = Object.keys(S.attend).filter(k => U[k] && !S.reg[k]).sort(byName);
  if (manual.length) { H("Presentes marcados a mano por la mesa", 10.5); P(manual.map(k => `${U[k].n} (${pdfPct(sh(k), 4)})`).join(", ") + ".", 8.5); }
  const pages = doc_.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc_.setPage(i); doc_.setFont("helvetica", "normal"); doc_.setFontSize(7.5); doc_.setTextColor(120); doc_.text(`Auditoría · Condominio Montepiedra · Huella ${fp} · Página ${i} de ${pages}`, M, doc_.internal.pageSize.getHeight() - 20); }
  doc_.save(`auditoria-votacion-montepiedra-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.pdf`);
}
function cardsPDF() {
  const doc_ = newPDF(), W = doc_.internal.pageSize.getWidth(), Hh = doc_.internal.pageSize.getHeight();
  const cols = 3, rows = 8, mx = 24, my = 28, cw = (W - 2 * mx) / cols, ch = (Hh - 2 * my) / rows;
  const codes = (S.codes && S.codes.codes) || {};
  SORTED.filter(u => codes[u.k]).forEach((u, i) => {
    const pos = i % (cols * rows); if (i && pos === 0) doc_.addPage();
    const x = mx + (pos % cols) * cw, y = my + Math.floor(pos / cols) * ch;
    doc_.setDrawColor(190); doc_.setLineDashPattern([3, 3], 0); doc_.rect(x, y, cw, ch); doc_.setLineDashPattern([], 0);
    doc_.setFont("helvetica", "normal"); doc_.setFontSize(7); doc_.setTextColor(110); doc_.text("CONDOMINIO MONTEPIEDRA · VOTACIÓN EN ASAMBLEA", x + 10, y + 16);
    doc_.setFont("helvetica", "bold"); doc_.setFontSize(13); doc_.setTextColor(31, 42, 36); doc_.text(u.n, x + 10, y + 36);
    doc_.setFont("courier", "bold"); doc_.setFontSize(17); doc_.setTextColor(...GREEN); doc_.text(codes[u.k], x + 10, y + 60);
    doc_.setFont("helvetica", "normal"); doc_.setFontSize(6.6); doc_.setTextColor(110);
    doc_.text(doc_.splitTextToSize(`Código de esta propiedad. Se usa una sola vez al inscribirse en ${location.host}.`, cw - 20), x + 10, y + 74);
  });
  doc_.save("codigos-votacion-montepiedra.pdf");
}

/* ---------- code list loading ---------- */
async function saveCodeList(codes, source) {
  const ops = [];
  (await getDocs(collection(db, "claves"))).docs.forEach(d => ops.push(["delete", d.ref]));
  (await getDocs(collection(db, "reg"))).docs.forEach(d => ops.push(["delete", d.ref]));
  for (const k in codes) ops.push(["set", doc(db, "claves", await claveOf(k, codes[k])), { unit: k }]);
  await batched(ops);
  await setDoc(doc(db, "secretos", "codigos"), { codes, gen: new Date().toISOString(), source });
}
function parseCodeList(txt) {
  const byN = {}; UNITS.forEach(u => { byN[norm(u.n).replace(/[^a-z0-9]/g, "")] = u.k; byN[u.k.toLowerCase().replace(/[^a-z0-9]/g, "")] = u.k; });
  const codes = {}, bad = [], dupes = [];
  txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    const parts = line.split(/\t|;|,/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) { bad.push(line); return; }
    const code = parts[parts.length - 1], key = byN[norm(parts[0]).replace(/[^a-z0-9]/g, "")];
    if (!key) { if (!/^unidad|^propiedad/i.test(parts[0])) bad.push(line); return; }
    if (normCode(code).length < 4) { bad.push(line); return; }
    codes[key] = code.toUpperCase();
  });
  const seen = {}; for (const k in codes) { const c = normCode(codes[k]); if (seen[c]) dupes.push(`${U[seen[c]].n} y ${U[k].n}`); else seen[c] = k; }
  return { codes, bad, dupes };
}

/* ---------- events ---------- */
function setTab(t) {
  if (t === "admin" && !ADMIN) t = "votar";
  TAB = t;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  ["votar", "pantalla", "admin"].forEach(x => $("#tab-" + x).classList.toggle("hide", x !== t));
  try { if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t); } catch (e) {}
  render();
}
$("#nav").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (["votar", "pantalla", "admin"].includes(t) && t !== TAB) setTab(t); });

$("#f-reg").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#r-msg"), k = $("#r-unit").value, btn = $("#f-reg button[type=submit]");
  btn.disabled = true; msg.innerHTML = `<span class="muted">Verificando…</span>`;
  try {
    const name = $("#r-name").value.trim();
    try { localStorage.setItem("mp-name", name); } catch (er) {}
    const r = await register(k, $("#r-code").value, name, "app");
    $("#r-unit").value = ""; $("#r-code").value = "";
    msg.innerHTML = `<span class="good">${esc(U[k].n)} ${r === "ya" ? "ya estaba inscrita en este teléfono" : "inscrita"}. ${r === "ok" ? "Si trae poderes, inscriba la siguiente propiedad." : ""}</span>`;
  } catch (er) { msg.innerHTML = `<span class="bad">${esc(errMsg(er))}</span>`; }
  btn.disabled = false; sched();
});
$("#f-config").addEventListener("submit", async e => {
  e.preventDefault();
  try { await setDoc(doc(db, "config", "main"), { name: $("#c-name").value.trim(), date: $("#c-date").value }); toast("Datos de la asamblea guardados."); }
  catch (er) { toast(errMsg(er)); }
});
$("#f-admin").addEventListener("submit", async e => {
  e.preventDefault();
  const em = $("#ad-email").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { toast("Correo no válido."); return; }
  try { await setDoc(doc(db, "admins", em), { email: em, addedBy: EMAIL, at: serverTimestamp() }); $("#ad-email").value = ""; toast("Administrador agregado. Debe entrar con esa cuenta de Google."); }
  catch (er) { toast(errMsg(er)); }
});
function resetItemForm() { $("#i-id").value = ""; $("#f-item").reset(); $("#i-opts").value = "Sí, No, Abstención"; $("#i-submit").textContent = "Agregar tema"; $("#it-form-title").textContent = "Nuevo tema a votación"; $("#i-cancel").classList.add("hide"); ["#i-type", "#i-opts"].forEach(s => $(s).disabled = false); $("#i-msg").textContent = ""; }
$("#i-cancel").onclick = resetItemForm;
$("#f-item").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("#i-id").value, title = $("#i-title").value.trim();
  const options = [...new Set($("#i-opts").value.split(",").map(s => s.trim()).filter(Boolean))];
  if (!title) return;
  if (options.length < 2) { $("#i-msg").textContent = "Indique al menos dos opciones."; return; }
  try {
    if (id) {
      const hasV = Object.keys(S.votes[id] || {}).length > 0;
      const upd = { title, desc: $("#i-desc").value.trim() };
      if (!hasV) { upd.type = $("#i-type").value; upd.options = options; }
      await setDoc(doc(db, "items", id), { ...S.items[id], ...upd }); toast("Tema actualizado.");
    } else {
      const nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const maxO = Math.max(0, ...items().map(i => i.order || 0));
      await setDoc(doc(db, "items", nid), { title, desc: $("#i-desc").value.trim(), type: $("#i-type").value, options, status: "draft", order: maxO + 1, createdAt: new Date().toISOString() });
      toast("Tema agregado como borrador. Ábralo cuando corresponda votar.");
    }
    resetItemForm();
  } catch (er) { $("#i-msg").textContent = errMsg(er); }
});
$("#u-search").addEventListener("input", () => renderAdmin());
document.addEventListener("change", e => { if (e.target.id === "as-item") { assistItem = e.target.value; assistOpt = ""; sched(); } });
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
$("#btn-admin").addEventListener("click", async () => {
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (String(e.code).includes("popup-blocked") || String(e.code).includes("operation-not-supported")) { await signInWithRedirect(auth, p); return; }
    toast(errMsg(e), 4000);
  }
});
$("#btn-out").addEventListener("click", async () => { await signOut(auth); toast("Sesión de administrador cerrada."); });

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.i, k = b.dataset.k, o = b.dataset.o;
  try {
    switch (act) {
      case "pick": pick[id] = o; sched(); break;
      case "pick-clear": delete pick[id]; sched(); break;
      case "confirm": {
        const opt = pick[id], votes = S.votes[id] || {}, pend = myUnits().filter(x => !votes[x] && !S.inhab[x]);
        if (!opt || !pend.length) break;
        b.disabled = true;
        const res = await castVotes(id, pend, opt, "app");
        delete pick[id];
        if (res.ok.length) toast(`Voto registrado por ${res.ok.length} ${res.ok.length === 1 ? "propiedad" : "propiedades"}.`);
        if (res.errs.length) infoModal("Algunos votos no se registraron", `<ul>${res.errs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
        sched(); break;
      }
      case "sel": screenSel = id || null; sched(); break;
      case "show": screenSel = id; setTab("pantalla"); break;
      case "pdf-item": { const cur = currentScreenItem(); if (cur && S.items[cur].status === "closed") await auditPDF([cur]); break; }
      case "pdf-all": { const ids = items().filter(i => i.status === "closed").map(i => i.id); if (ids.length) await auditPDF(ids); break; }
      case "open": await setDoc(doc(db, "items", id), { ...S.items[id], status: "open", openedAt: new Date().toISOString(), final: null }); toast("Votación abierta."); break;
      case "close": {
        const r0 = compute(id, true);
        if (!(await ask("Cerrar votación", `Se calculará y publicará el resultado. Votaron ${r0.votedN} propiedades (${fmtP(r0.votedShare, 2)} de los derechos). Después no se aceptan más votos.`, "Cerrar y publicar"))) break;
        await setDoc(doc(db, "items", id), { ...S.items[id], status: "closing" });  // stops new votes on the server first
        await new Promise(r => setTimeout(r, 1200));
        const vs = await getDocs(query(collection(db, "votos"), where("item", "==", id))); ingestVotes(vs.docs, id);
        const r = compute(id, true);
        await setDoc(doc(db, "items", id), { ...S.items[id], status: "closed", closedAt: new Date().toISOString(), final: r }); toast("Votación cerrada. Resultado publicado."); break;
      }
      case "reopen": if (await ask("Reabrir votación", "El resultado publicado se retira y la votación vuelve a recibir votos. Los votos ya emitidos se mantienen.", "Reabrir")) await setDoc(doc(db, "items", id), { ...S.items[id], status: "open", final: null }); break;
      case "edit": {
        const it = S.items[id], hasV = Object.keys(S.votes[id] || {}).length > 0;
        $("#i-id").value = id; $("#i-title").value = it.title || ""; $("#i-desc").value = it.desc || ""; $("#i-type").value = it.type || "ORD"; $("#i-opts").value = (it.options || []).join(", ");
        $("#i-type").disabled = hasV; $("#i-opts").disabled = hasV;
        $("#i-msg").textContent = hasV ? "Este tema ya tiene votos: solo se pueden editar título y descripción." : "";
        $("#i-submit").textContent = "Guardar cambios"; $("#it-form-title").textContent = "Editar tema"; $("#i-cancel").classList.remove("hide");
        $("#f-item").scrollIntoView({ behavior: "smooth", block: "center" }); break;
      }
      case "up": case "down": {
        const its = items(), i = its.findIndex(x => x.id === id), j = act === "up" ? i - 1 : i + 1; if (j < 0 || j >= its.length) break;
        const a = its[i], c = its[j], oa = a.order || i + 1, oc = c.order || j + 1;
        await setDoc(doc(db, "items", a.id), { ...S.items[a.id], order: oc === oa ? (act === "up" ? oa - 1 : oa + 1) : oc });
        await setDoc(doc(db, "items", c.id), { ...S.items[c.id], order: oa }); break;
      }
      case "clear": if (await ask("Borrar votos", `Se eliminarán todos los votos del tema «${esc(S.items[id].title)}».`, "Borrar votos", true)) { await deleteWhere("votos", "item", id); toast("Votos borrados."); } break;
      case "del": if (await ask("Eliminar tema", `Se eliminará «${esc(S.items[id].title)}» y todos sus votos.`, "Eliminar", true)) { await deleteWhere("votos", "item", id); await deleteDoc(doc(db, "items", id)); toast("Tema eliminado."); } break;
      case "acta": await copyText(actaText(), "Acta de resultados"); break;
      case "as-opt": assistOpt = o; sched(); break;
      case "as-go": {
        const uk = $("#as-unit").value, code = $("#as-code").value;
        if (!assistItem) throw "Seleccione un tema."; if (!U[uk]) throw "Seleccione la propiedad."; if (!assistOpt) throw "Seleccione una opción.";
        if (S.reg[uk] && S.reg[uk].uid !== MESA) throw `${U[uk].n} está inscrita en un teléfono. Debe votar desde ahí, o libere la inscripción primero.`;
        if (!S.reg[uk]) { if (!code.trim()) throw "Ingrese el código de la propiedad (solo la primera vez)."; await register(uk, code, "", "mesa"); }
        if (!(await ask("Registrar voto en la mesa", `${esc(U[uk].n)} vota <b>${esc(assistOpt)}</b> en «${esc(S.items[assistItem].title)}».`, "Registrar"))) break;
        if (!S.reg[uk]) { const g = await getDoc(doc(db, "reg", uk)); if (g.exists()) S.reg[uk] = { ...g.data(), at: iso(g.data().at) }; }
        const res = await castVotes(assistItem, [uk], assistOpt, "mesa"); if (res.errs.length) throw res.errs.join(" ");
        toast("Voto registrado en la mesa."); $("#as-unit").value = ""; $("#as-code").value = ""; assistOpt = ""; sched(); break;
      }
      case "gen": {
        if (S.codes && !(await ask("Generar códigos nuevos", "Todos los códigos actuales dejarán de funcionar y se borrarán las inscripciones. Los votos ya emitidos se mantienen.", "Generar", true))) break;
        b.disabled = true; const codes = {}; UNITS.forEach(u => codes[u.k] = genCode());
        await saveCodeList(codes, "generados"); toast("Códigos generados."); break;
      }
      case "import": {
        modal(`<h3 style="margin-top:0">Cargar listado de códigos</h3><p class="muted small">Copie desde Excel dos columnas, <b>Propiedad</b> y <b>Código</b>, y péguelas aquí. El nombre debe coincidir con el listado de alícuotas (mayúsculas y tildes no importan). Este listado reemplaza al vigente y borra las inscripciones.</p><textarea class="in" id="m-codes" placeholder="Montepiedra 52&#9;K7PX-29QD&#10;Rehue 46&#9;M3TA-8HWE"></textarea><div id="m-res" class="small" style="margin-top:8px"></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="m-ok">Revisar y cargar</button></div>`);
        $("#m-no").onclick = closeModal;
        $("#m-ok").onclick = async () => {
          const { codes, bad, dupes } = parseCodeList($("#m-codes").value), n = Object.keys(codes).length;
          const missing = SORTED.filter(u => !codes[u.k]).map(u => u.n);
          let rep = `<b>${n}</b> de ${UNITS.length} propiedades con código.`;
          if (missing.length) rep += `<br><span class="bad">Sin código (${missing.length}):</span> ${esc(missing.slice(0, 12).join(", "))}${missing.length > 12 ? "…" : ""}`;
          if (bad.length) rep += `<br><span class="bad">Líneas no reconocidas (${bad.length}):</span> ${esc(bad.slice(0, 5).join(" | "))}`;
          if (dupes.length) rep += `<br><span class="bad">Códigos repetidos:</span> ${esc(dupes.join("; "))}`;
          if (!n) { $("#m-res").innerHTML = rep; return; }
          if ($("#m-ok").dataset.ready !== "1") { $("#m-res").innerHTML = rep + `<br>Pulse de nuevo para confirmar la carga.`; $("#m-ok").dataset.ready = "1"; $("#m-ok").textContent = "Confirmar carga"; return; }
          $("#m-ok").disabled = true;
          try { await saveCodeList(codes, "importados"); closeModal(); toast(`Listado cargado: ${n} códigos.`); } catch (er) { $("#m-res").innerHTML = `<span class="bad">${esc(errMsg(er))}</span>`; $("#m-ok").disabled = false; }
        };
        break;
      }
      case "cards": cardsPDF(); break;
      case "copy-codes": { const codes = (S.codes && S.codes.codes) || {}; let t = "Propiedad\tAlícuota (%)\tCódigo\tInscrita\n"; SORTED.forEach(u => t += `${u.n}\t${(sh(u.k) * 100).toFixed(5).replace(".", ",")}\t${codes[u.k] || ""}\t${S.reg[u.k] ? "Sí" : "No"}\n`); await copyText(t, "Listado de códigos"); break; }
      case "release": if (await ask("Liberar inscripción", `El código de ${esc(U[k].n)} quedará disponible para inscribirse de nuevo (por ejemplo, desde otro teléfono). Los votos ya emitidos por esta propiedad se mantienen.`, "Liberar")) { await deleteDoc(doc(db, "reg", k)); toast("Inscripción liberada."); } break;
      case "t-pres": if (S.attend[k]) await deleteDoc(doc(db, "asistencia", k)); else await setDoc(doc(db, "asistencia", k), { at: serverTimestamp(), by: EMAIL }); break;
      case "t-inh": { const m = { ...S.inhab }; if (m[k]) delete m[k]; else m[k] = true; await setDoc(doc(db, "config", "habiles"), { inhabiles: m }); break; }
      case "admin-del": { const em = b.dataset.e; if (await ask("Quitar administrador", `${esc(em)} dejará de tener acceso a la administración.`, "Quitar", true)) await deleteDoc(doc(db, "admins", em)); break; }
      case "reset-all": {
        if (!(await ask("Reiniciar asamblea", "Se borrarán las inscripciones, la asistencia y los votos de todos los temas. Los temas, la configuración y los códigos se mantienen. No se puede deshacer.", "Reiniciar todo", true))) break;
        await deleteWhere("votos"); await deleteWhere("reg"); await deleteWhere("asistencia");
        for (const it of items()) await setDoc(doc(db, "items", it.id), { ...S.items[it.id], status: "draft", final: null });
        toast("Asamblea reiniciada."); break;
      }
    }
  } catch (er) { toast(errMsg(er), 4500); if (b) b.disabled = false; }
});

/* ---------- subscriptions ---------- */
function mapDocs(docs) { const m = {}; docs.forEach(d => { const x = d.data({ serverTimestamps: "estimate" }); if (x) m[d.id] = { ...x, at: iso(x.at) }; }); return m; }
function ingestVotes(docs, onlyItem) {
  const m = onlyItem ? { ...S.votes, [onlyItem]: {} } : {};
  docs.forEach(d => { const x = d.data({ serverTimestamps: "estimate" }); if (!x || !x.option || !U[x.unit]) return; if (onlyItem && x.item !== onlyItem) return; (m[x.item] = m[x.item] || {})[x.unit] = { ...x, at: iso(x.at) }; });
  S.votes = m; sched();
}
function subscribe() {
  unsubs.forEach(f => f()); unsubs = [];
  S.reg = {}; S.votes = {}; S.attend = {}; S.codes = null; S.admins = [];
  const onErr = e => setStatus("Problema de conexión con la base de datos: " + esc(errMsg(e)) + " Recargue la página.", "err");
  const L = (ref, fn) => unsubs.push(onSnapshot(ref, fn, onErr));
  L(doc(db, "config", "main"), s => { S.config = s.data() || {}; if (document.activeElement !== $("#c-name")) $("#c-name").value = S.config.name || ""; if (document.activeElement !== $("#c-date")) $("#c-date").value = S.config.date || ""; setStatus(""); sched(); });
  L(doc(db, "config", "habiles"), s => { S.inhab = (s.data() || {}).inhabiles || {}; sched(); });
  L(doc(db, "stats", "asistencia"), s => { S.stats = s.data() || null; sched(); });
  L(collection(db, "items"), q => { S.items = {}; q.docs.forEach(d => S.items[d.id] = d.data()); sched(); });
  if (ADMIN) {
    L(collection(db, "reg"), q => { S.reg = mapDocs(q.docs); sched(); });
    L(collection(db, "votos"), q => ingestVotes(q.docs));
    L(collection(db, "asistencia"), q => { S.attend = mapDocs(q.docs); sched(); });
    L(doc(db, "secretos", "codigos"), s => { S.codes = s.data() || null; sched(); });
    L(collection(db, "admins"), q => { S.admins = q.docs.map(d => d.id).sort(); sched(); });
  } else {
    L(query(collection(db, "reg"), where("uid", "==", UID)), q => { S.reg = mapDocs(q.docs); sched(); });
    L(query(collection(db, "votos"), where("uid", "==", UID)), q => ingestVotes(q.docs));
  }
}

/* ---------- boot ---------- */
$("#r-unit").insertAdjacentHTML("beforeend", unitOptions());
$("#as-unit").insertAdjacentHTML("beforeend", unitOptions());
try { $("#r-name").value = localStorage.getItem("mp-name") || ""; } catch (e) {}
setStatus("Conectando…", "info");
getRedirectResult(auth).catch(e => toast(errMsg(e), 4000));
onAuthStateChanged(auth, async user => {
  if (!user) { try { await signInAnonymously(auth); } catch (e) { setStatus("No se pudo conectar: " + esc(errMsg(e)), "err"); } return; }
  UID = user.uid; EMAIL = (user.email || "").toLowerCase(); ADMIN = false;
  if (EMAIL) {
    try { ADMIN = (await getDoc(doc(db, "admins", EMAIL))).exists(); } catch (e) { ADMIN = false; }
    if (!ADMIN) toast(`${EMAIL} no está registrado como administrador.`, 5000);
  }
  subscribe();
  const h = location.hash.slice(1);
  setTab(["votar", "pantalla", "admin"].includes(h) ? h : (TAB || "votar"));
});
