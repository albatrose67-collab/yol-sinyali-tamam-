/**
 * YolSinyali — app.js
 * Mimari: Modüler bölümler (State, Stats, Territory, Socket, Markers, UI Binding)
 * Tüm buton bağlamaları addEventListener ile yapılır (inline onclick YOK).
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
let map, socket;
let myUsername = "", serverUrl = "";
let myLatLng = null, myMarker = null;
const friendMarkers = {};
const radarList = new Set();

let isDrawing = false;
let tPath = [], tLine = null, tStartMark = null;
const CLOSE_M = 30;
let myTerritories = [];
const allTerritories = {};

let alarmActive = false;
const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = AudioCtxClass ? new AudioCtxClass() : null;

const COLORS = ["#3b82f6","#ef4444","#22c55e","#f97316","#8b5cf6","#14b8a6","#ec4899","#eab308"];
function colorOf(u) {
  let h = 0;
  for (let i = 0; i < u.length; i++) h = u.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS MANAGER — adım, kazanılan/kaybedilen alan, toplam mesafe
// ═══════════════════════════════════════════════════════════════════════════
const Stats = {
  steps: 0,          // GPS güncelleme sayısı (yaklaşık adım/hareket birimi)
  totalDistance: 0,  // metre — kat edilen toplam yol
  areaGained: 0,     // m² — kazanılan/ele geçirilen toplam alan
  areaLost: 0,       // m² — kaybedilen toplam alan
  lastLatLng: null,

  load() {
    try {
      const raw = localStorage.getItem("ys_stats_" + myUsername);
      if (raw) Object.assign(this, JSON.parse(raw));
    } catch (e) { /* bozuk veri — sessizce yoksay */ }
  },

  save() {
    try {
      localStorage.setItem("ys_stats_" + myUsername, JSON.stringify({
        steps: this.steps,
        totalDistance: this.totalDistance,
        areaGained: this.areaGained,
        areaLost: this.areaLost,
      }));
    } catch (e) { /* storage kotası dolabilir — kritik değil */ }
  },

  registerMovement(latlng) {
    this.steps += 1;
    if (this.lastLatLng) {
      const d = this.lastLatLng.distanceTo(latlng);
      // GPS sıçramalarını (0-1000m arası mantıklı hareket) filtrele
      if (d > 0 && d < 1000) this.totalDistance += d;
    }
    this.lastLatLng = latlng;
    this.save();
    this.render();
  },

  registerAreaGained(m2) {
    this.areaGained += m2;
    this.save();
    this.render();
    this.pulse("stat-gained");
    this.pulse("summary-gained");
  },

  registerAreaLost(m2) {
    this.areaLost += m2;
    this.save();
    this.render();
    this.pulse("stat-lost");
    this.pulse("summary-lost");
  },

  pulse(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("count-pop");
    void el.offsetWidth; // reflow tetikle — animasyonu yeniden başlat
    el.classList.add("count-pop");
  },

  render() {
    const netArea = this.areaGained - this.areaLost;
    setText("stat-steps", this.steps.toLocaleString("tr-TR"));
    setText("stat-gained", fmtArea(this.areaGained));
    setText("stat-lost", fmtArea(this.areaLost));
    setText("stat-distance", fmtDistance(this.totalDistance));

    setText("summary-steps", this.steps.toLocaleString("tr-TR"));
    setText("summary-gained", fmtArea(this.areaGained));
    setText("summary-lost", fmtArea(this.areaLost));
    setText("summary-net", (netArea >= 0 ? "+" : "") + fmtArea(Math.abs(netArea)).replace(/^/, netArea < 0 ? "-" : ""));
  },
};

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
}
function fmtArea(m2) {
  if (m2 >= 1e6) return (m2 / 1e6).toFixed(2) + " km²";
  if (m2 >= 1e4) return (m2 / 1e4).toFixed(1) + " ha";
  return Math.round(m2) + " m²";
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function show(id)     { const e = document.getElementById(id); if (e) e.style.display = ""; }
function hide(id)      { const e = document.getElementById(id); if (e) e.style.display = "none"; }
function showFlex(id)  { const e = document.getElementById(id); if (e) e.style.display = "flex"; }
function showBlock(id) { const e = document.getElementById(id); if (e) e.style.display = "block"; }

function togglePanel(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const visible = el.style.display && el.style.display !== "none";
  el.style.display = visible ? "none" : "block";
}

function shake(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.transition = "transform .07s";
  [0, 9, -9, 9, -9, 0].forEach((x, i) =>
    setTimeout(() => { el.style.transform = `translateX(${x}px)`; }, i * 70));
  setTimeout(() => { el.style.transform = ""; }, 500);
}

let _toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT — DOM hazır olunca harita kur + event bağla
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindEvents();
  loadSession();
});

function initMap() {
  map = L.map("map", { center: [39.9334, 32.8597], zoom: 6 });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OSM © CARTO", subdomains: "abcd", maxZoom: 19,
  }).addTo(map);
}

// ── Tüm event listener bağlamaları merkezi burada — inline onclick YOK ──────
function bindEvents() {
  on("login-btn", "click", handleLogin);
  on("login-username", "keydown", e => { if (e.key === "Enter") handleLogin(); });
  on("login-server-url", "keydown", e => { if (e.key === "Enter") handleLogin(); });

  on("btn-toggle-radar", "click", () => togglePanel("radar-panel"));
  on("btn-toggle-territory", "click", () => togglePanel("territory-panel"));
  on("btn-toggle-territory-bottom", "click", () => togglePanel("territory-panel"));
  on("btn-close-radar", "click", () => hide("radar-panel"));
  on("btn-close-territory", "click", () => hide("territory-panel"));

  on("btn-sos-top", "click", sendSOSWhatsApp);
  on("btn-sos-bottom", "click", sendSOSWhatsApp);
  on("btn-center-me", "click", centerOnMe);

  on("btn-add-friend", "click", addFriend);
  on("friend-input", "keydown", e => { if (e.key === "Enter") addFriend(); });
  on("alarm-distance", "input", updateAlarmLabel);

  on("territory-btn", "click", toggleTerritoryDrawing);
  on("btn-dismiss-alarm", "click", dismissAlarm);

  on("btn-save-territory", "click", saveTerritoryFromModal);
  on("btn-cancel-territory", "click", cancelTerritoryModal);
  on("territory-name-input", "keydown", e => { if (e.key === "Enter") saveTerritoryFromModal(); });
}

function on(id, evt, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, handler);
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════════════
function loadSession() {
  const u = localStorage.getItem("ys_u");
  const s = localStorage.getItem("ys_s");
  if (u) document.getElementById("login-username").value = u;
  if (s) document.getElementById("login-server-url").value = s;
  if (u) setTimeout(() => handleLogin(), 400);
}

function handleLogin() {
  const username = (document.getElementById("login-username").value || "").trim();
  const url = (document.getElementById("login-server-url").value || "").trim();
  if (!username) { shake("login-username"); return; }

  myUsername = username;
  serverUrl = url;
  localStorage.setItem("ys_u", username);
  if (url) localStorage.setItem("ys_s", url);

  try {
    if (window.AndroidBridge) {
      if (url) window.AndroidBridge.saveServerUrl(url);
      window.AndroidBridge.saveUsernameAndStartTracking(username);
    }
  } catch (e) { /* Android köprüsü yoksa (tarayıcı modu) sessizce geç */ }

  Stats.load();
  Stats.render();

  hide("login-screen");
  show("topbar");
  showFlex("statsbar");
  showFlex("bottombar");
  document.getElementById("topbar-username").textContent = username;

  if (url) connectSocket();
  watchGPS();
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════════════════════
function watchGPS() {
  if (!navigator.geolocation) { toast("Tarayıcı konum desteklemiyor"); return; }
  navigator.geolocation.watchPosition(
    pos => onGPS(pos.coords.latitude, pos.coords.longitude),
    err => console.warn("GPS hata:", err.message),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function onGPS(lat, lng) {
  const latlng = L.latLng(lat, lng);
  myLatLng = latlng;

  if (!myMarker) {
    myMarker = mkMarker(lat, lng, myUsername, true);
    map.setView(myLatLng, 17);
  } else {
    myMarker.setLatLng(myLatLng);
  }

  Stats.registerMovement(latlng);

  if (isDrawing) addPoint(latlng);

  if (socket && socket.connected) {
    socket.emit("update_location", { username: myUsername, latitude: lat, longitude: lng });
  }

  checkAlarms();
}

// ═══════════════════════════════════════════════════════════════════════════
// TERRITORY DRAWING
// ═══════════════════════════════════════════════════════════════════════════
function toggleTerritoryDrawing() {
  isDrawing ? stopDrawing(false) : startDrawing();
}

function startDrawing() {
  if (!myLatLng) { toast("Konum henüz alınamadı, bekle."); return; }
  isDrawing = true;
  tPath = [myLatLng];

  tStartMark = L.circleMarker(myLatLng, {
    radius: 9, color: "#fff", weight: 2.5, fillColor: colorOf(myUsername), fillOpacity: 1,
  }).addTo(map).bindTooltip("Buraya dön!", { permanent: true, direction: "top" });

  tLine = L.polyline([myLatLng], {
    color: colorOf(myUsername), weight: 3.5, opacity: 0.9, dashArray: "8 5",
  }).addTo(map);

  const btn = document.getElementById("territory-btn");
  btn.textContent = "⏹ Durdur";
  btn.style.background = "#991b1b";

  showBlock("territory-status");
  toast("🗺 Yürü! Başlangıca 30m yaklaşınca kapanır.");
}

function addPoint(latlng) {
  const last = tPath[tPath.length - 1];
  if (last && last.distanceTo(latlng) < 5) return;

  tPath.push(latlng);
  tLine.addLatLng(latlng);
  updateDrawStatus();

  if (tPath.length >= 5) {
    const d = latlng.distanceTo(tPath[0]);
    setText("dist-to-start", Math.round(d) + " m");
    if (d <= CLOSE_M) stopDrawing(true);
  }
}

function updateDrawStatus() {
  setText("territory-points", tPath.length);
  let total = 0;
  for (let i = 1; i < tPath.length; i++) total += tPath[i - 1].distanceTo(tPath[i]);
  setText("territory-dist", fmtDistance(total));
}

function stopDrawing(autoClosed) {
  isDrawing = false;
  const btn = document.getElementById("territory-btn");
  btn.textContent = "🗺 Bölge Çizmeye Başla";
  btn.style.background = "#7c3aed";
  hide("territory-status");

  if (tStartMark) { map.removeLayer(tStartMark); tStartMark = null; }
  if (tLine) { map.removeLayer(tLine); tLine = null; }

  if (!autoClosed || tPath.length < 5) {
    toast(autoClosed ? "Daha fazla yürü (min 5 nokta gerekli)." : "Bölge çizimi iptal edildi.");
    tPath = [];
    return;
  }

  openNameModal([...tPath, tPath[0]]);
}

function openNameModal(path) {
  window._pendingPath = path;
  document.getElementById("territory-name-input").value = "";

  if (window._preview) map.removeLayer(window._preview);
  window._preview = L.polygon(path, {
    color: colorOf(myUsername), weight: 2, fillColor: colorOf(myUsername), fillOpacity: 0.15,
  }).addTo(map);
  map.fitBounds(window._preview.getBounds(), { padding: [50, 50] });

  document.getElementById("territory-modal").classList.add("open");
  setTimeout(() => document.getElementById("territory-name-input").focus(), 150);
}

function saveTerritoryFromModal() {
  const name = (document.getElementById("territory-name-input").value || "").trim();
  if (!name) { shake("territory-name-input"); return; }

  if (window._preview) { map.removeLayer(window._preview); window._preview = null; }
  document.getElementById("territory-modal").classList.remove("open");
  createTerritory(window._pendingPath, name);
}

function cancelTerritoryModal() {
  if (window._preview) { map.removeLayer(window._preview); window._preview = null; }
  document.getElementById("territory-modal").classList.remove("open");
  tPath = [];
}

function createTerritory(path, name) {
  const color = colorOf(myUsername);
  const id = Date.now().toString();
  const area = calcArea(path);

  const layer = L.polygon(path, { color, weight: 2.5, fillColor: color, fillOpacity: 0.22 })
    .addTo(map)
    .bindPopup(buildPopup({ id, name, username: myUsername, area }, true));

  const territory = { id, name, path, layer, color, area, username: myUsername };
  myTerritories.push(territory);
  if (!allTerritories[myUsername]) allTerritories[myUsername] = [];
  allTerritories[myUsername].push(territory);

  Stats.registerAreaGained(area);

  if (socket && socket.connected) {
    socket.emit("territory_created", {
      id, name, username: myUsername, color,
      path: path.map(p => [p.lat, p.lng]), area,
    });
  }

  toast(`✅ "${name}" oluşturuldu! (${fmtArea(area)})`);
  renderTerritoryList();
}

// ═══════════════════════════════════════════════════════════════════════════
// TERRITORY CAPTURE — rakip merkeze ulaşınca ele geçirir
// ═══════════════════════════════════════════════════════════════════════════
function checkCapture() {
  if (!myLatLng) return;
  Object.entries(allTerritories).forEach(([owner, list]) => {
    if (owner === myUsername) return;
    list.forEach(t => {
      if (t.captured) return;
      const center = t.layer.getBounds().getCenter();
      if (myLatLng.distanceTo(center) <= 25) captureTerritory(t, owner);
    });
  });
}

function captureTerritory(t, previousOwner) {
  t.captured = true;
  const newColor = colorOf(myUsername);
  t.layer.setStyle({ color: newColor, fillColor: newColor, fillOpacity: 0.35, dashArray: "6 3" });
  t.layer.setPopupContent(buildPopup({ ...t, username: myUsername, capturedFrom: previousOwner }, false));
  flashLayer(t.layer);

  Stats.registerAreaGained(t.area);

  if (socket && socket.connected) {
    socket.emit("territory_captured", { id: t.id, capturedBy: myUsername, previousOwner });
  }

  toast(`🏴 "${t.name}" ele geçirildi! (${previousOwner}'dan, +${fmtArea(t.area)})`);
  beep();
}

function flashLayer(layer) {
  let n = 0;
  const iv = setInterval(() => {
    layer.setStyle({ fillOpacity: n++ % 2 === 0 ? 0.7 : 0.1 });
    if (n >= 8) { clearInterval(iv); layer.setStyle({ fillOpacity: 0.35 }); }
  }, 180);
}

function drawFriendTerritory(data) {
  const latlngs = data.path.map(p => L.latLng(p[0], p[1]));
  if (!allTerritories[data.username]) allTerritories[data.username] = [];

  const idx = allTerritories[data.username].findIndex(t => t.id === data.id);
  if (idx >= 0) { map.removeLayer(allTerritories[data.username][idx].layer); allTerritories[data.username].splice(idx, 1); }

  const layer = L.polygon(latlngs, { color: data.color, weight: 2, fillColor: data.color, fillOpacity: 0.15 })
    .addTo(map).bindPopup(buildPopup({ ...data }, false));

  allTerritories[data.username].push({ ...data, path: latlngs, layer });
}

function removeTerritoryById(id) {
  Object.values(allTerritories).forEach(list => {
    const i = list.findIndex(t => t.id === id);
    if (i >= 0) { map.removeLayer(list[i].layer); list.splice(i, 1); }
  });
}

function buildPopup(t, isOwner) {
  const capturedNote = t.capturedFrom
    ? `<div style="color:#f97316;font-size:11px;margin-top:3px">⚔️ ${t.capturedFrom}'dan alındı</div>` : "";
  const deleteBtnHtml = (isOwner && t.username === myUsername)
    ? `<button class="ys-delete-territory" data-id="${t.id}"
         style="margin-top:8px;width:100%;background:#ef4444;color:#fff;border:none;padding:5px;border-radius:6px;font-size:12px;cursor:pointer">Sil</button>`
    : "";
  return `<div style="min-width:150px">
    <b style="font-size:14px">📍 ${escapeHtml(t.name)}</b>
    <div style="color:#94a3b8;font-size:12px;margin-top:3px">Sahip: <b style="color:#e2e8f0">${escapeHtml(t.username)}</b></div>
    <div style="color:#94a3b8;font-size:12px">Alan: ${fmtArea(t.area)}</div>
    ${capturedNote}${deleteBtnHtml}
  </div>`;
}

// Popup içindeki dinamik "Sil" butonları için event delegation (leaflet popup her seferinde yeni DOM üretir)
document.addEventListener("click", e => {
  const delBtn = e.target.closest(".ys-delete-territory");
  if (delBtn) deleteTerritory(delBtn.dataset.id);
});

function deleteTerritory(id) {
  const i = myTerritories.findIndex(t => t.id === id);
  if (i >= 0) {
    Stats.registerAreaLost(myTerritories[i].area);
    map.removeLayer(myTerritories[i].layer);
    myTerritories.splice(i, 1);
  }
  removeTerritoryById(id);
  if (socket && socket.connected) socket.emit("territory_deleted", { id, username: myUsername });
  renderTerritoryList();
  toast("Bölge silindi.");
}

function renderTerritoryList() {
  const el = document.getElementById("territory-list");
  if (!myTerritories.length) {
    el.innerHTML = `<p style="color:#475569;font-size:12px;text-align:center;padding:12px 0">Henüz bölgen yok.</p>`;
    return;
  }
  el.innerHTML = myTerritories.map(t => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:rgba(30,40,60,.6);margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:7px;min-width:0">
        <div style="width:10px;height:10px;border-radius:3px;background:${t.color};flex-shrink:0"></div>
        <span style="color:#e2e8f0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.name)}</span>
        <span style="color:#475569;font-size:11px;flex-shrink:0">${fmtArea(t.area)}</span>
      </div>
      <button class="ys-focus-territory" data-id="${t.id}" style="background:none;border:none;color:#60a5fa;cursor:pointer;padding:2px 6px;font-size:13px">🔍</button>
    </div>`).join("");
}

document.addEventListener("click", e => {
  const btn = e.target.closest(".ys-focus-territory");
  if (btn) focusTerritory(btn.dataset.id);
});

function focusTerritory(id) {
  const t = Object.values(allTerritories).flat().find(t => t.id === id);
  if (t) map.fitBounds(t.layer.getBounds(), { padding: [40, 40] });
}

// ── Alan hesaplama (Shoelace + enlem düzeltmesi) ─────────────────────────────
function calcArea(latlngs) {
  let area = 0;
  const n = latlngs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = latlngs[i].lng * Math.cos(latlngs[i].lat * Math.PI / 180);
    const xj = latlngs[j].lng * Math.cos(latlngs[j].lat * Math.PI / 180);
    area += xi * latlngs[j].lat - xj * latlngs[i].lat;
  }
  return Math.abs(area / 2) * 111320 * 111320;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════
function connectSocket() {
  if (socket) socket.disconnect();
  try {
    socket = io(serverUrl, { transports: ["websocket", "polling"], reconnectionAttempts: 10 });

    socket.on("connect", () => socket.emit("join", { username: myUsername }));

    socket.on("friend_location_update", d => {
      if (d.username === myUsername) return;
      updateFriendMarker(d.username, d.latitude, d.longitude);
      checkCapture();
    });

    socket.on("friend_disconnected", d => removeFriendMarker(d.username));

    socket.on("active_users_snapshot", d => {
      (d.users || []).forEach(u => { if (u.username !== myUsername) updateFriendMarker(u.username, u.latitude, u.longitude); });
      setText("online-count", (d.users?.length || 0) + " kişi");
    });

    socket.on("territory_created", d => { if (d.username !== myUsername) drawFriendTerritory(d); });
    socket.on("territory_deleted", d => removeTerritoryById(d.id));
    socket.on("territories_snapshot", d => (d.territories || []).forEach(t => { if (t.username !== myUsername) drawFriendTerritory(t); }));

    socket.on("territory_captured", d => {
      if (d.previousOwner === myUsername) {
        Stats.registerAreaLost(findTerritoryArea(d.id));
        toast(`⚠️ Bölgen ${d.capturedBy} tarafından alındı!`);
        beep();
      }
      const t = Object.values(allTerritories).flat().find(t => t.id === d.id);
      if (t) {
        const c = colorOf(d.capturedBy);
        t.layer.setStyle({ color: c, fillColor: c });
        flashLayer(t.layer);
      }
    });

  } catch (e) { console.error("Socket bağlantı hatası:", e); }
}

function findTerritoryArea(id) {
  const t = Object.values(allTerritories).flat().find(t => t.id === id);
  return t ? t.area : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKERS
// ═══════════════════════════════════════════════════════════════════════════
function mkMarker(lat, lng, username, isMe = false) {
  const c = isMe ? "#3b82f6" : colorOf(username);
  const init = username.charAt(0).toUpperCase();
  const html = `<div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center">
    <div style="position:absolute;width:44px;height:44px;border-radius:50%;background:${c}22;border:2px solid ${c}66;animation:ripple 1.6s ease-out infinite"></div>
    <div style="width:32px;height:32px;border-radius:50%;background:${c};color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px ${c}88;position:relative;z-index:2;border:2px solid #fff">${init}</div>
  </div>`;
  return L.marker([lat, lng], {
    icon: L.divIcon({ html, className: "", iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -24] }),
  }).addTo(map).bindPopup(`<b>${escapeHtml(username)}${isMe ? " (Sen)" : ""}</b>`);
}

function updateFriendMarker(username, lat, lng) {
  if (friendMarkers[username]) {
    const start = friendMarkers[username].getLatLng();
    let frame = 0;
    const step = () => {
      frame++;
      const t = frame / 20;
      friendMarkers[username].setLatLng([start.lat + (lat - start.lat) * t, start.lng + (lng - start.lng) * t]);
      if (frame < 20) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  } else {
    friendMarkers[username] = mkMarker(lat, lng, username, false);
    if (radarList.has(username)) renderRadarList();
  }
}

function removeFriendMarker(username) {
  if (friendMarkers[username]) {
    map.removeLayer(friendMarkers[username]);
    delete friendMarkers[username];
    renderRadarList();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RADAR
// ═══════════════════════════════════════════════════════════════════════════
function addFriend() {
  const input = document.getElementById("friend-input");
  const name = (input.value || "").trim();
  if (!name || name === myUsername) { shake("friend-input"); return; }
  radarList.add(name);
  input.value = "";
  renderRadarList();
}

function removeFriendFromRadar(name) { radarList.delete(name); renderRadarList(); }
function focusOnFriend(name) { if (friendMarkers[name]) map.setView(friendMarkers[name].getLatLng(), 17, { animate: true }); }

function renderRadarList() {
  const el = document.getElementById("friend-list");
  if (!radarList.size) {
    el.innerHTML = `<p style="color:#475569;font-size:12px;text-align:center;padding:12px 0">Henüz takip edilen yok.</p>`;
    return;
  }
  el.innerHTML = [...radarList].map(name => {
    const online = !!friendMarkers[name];
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:${online ? "rgba(30,58,138,.3)" : "rgba(30,40,60,.5)"};margin-bottom:4px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:7px;height:7px;border-radius:50%;background:${online ? "#34d399" : "#374151"}"></div>
        <span style="color:#e2e8f0;font-size:13px">${escapeHtml(name)}</span>
        <span style="color:#475569;font-size:11px">${online ? "çevrimiçi" : "çevrimdışı"}</span>
      </div>
      <div style="display:flex;gap:4px">
        ${online ? `<button class="ys-focus-friend" data-name="${escapeHtml(name)}" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:14px;padding:2px 5px">📍</button>` : ""}
        <button class="ys-remove-friend" data-name="${escapeHtml(name)}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;padding:2px 5px">✕</button>
      </div>
    </div>`;
  }).join("");
}

document.addEventListener("click", e => {
  const focusBtn = e.target.closest(".ys-focus-friend");
  if (focusBtn) focusOnFriend(focusBtn.dataset.name);
  const removeBtn = e.target.closest(".ys-remove-friend");
  if (removeBtn) removeFriendFromRadar(removeBtn.dataset.name);
});

// ═══════════════════════════════════════════════════════════════════════════
// ALARM
// ═══════════════════════════════════════════════════════════════════════════
function checkAlarms() {
  if (!myLatLng) return;
  const threshold = parseInt(document.getElementById("alarm-distance")?.value || "500");
  let hit = false, who = "";
  radarList.forEach(name => {
    const m = friendMarkers[name];
    if (m && myLatLng.distanceTo(m.getLatLng()) <= threshold) { hit = true; who = name; }
  });
  if (hit && !alarmActive) {
    alarmActive = true;
    setText("alarm-text", `⚠️ ${who} yakında!`);
    showBlock("alarm-banner");
    beep();
  } else if (!hit && alarmActive) {
    dismissAlarm();
  }
  checkCapture();
}

function dismissAlarm() { alarmActive = false; hide("alarm-banner"); }

function updateAlarmLabel() {
  const v = document.getElementById("alarm-distance")?.value || "500";
  setText("alarm-label", v >= 1000 ? (v / 1000).toFixed(1) + "km" : v + " m");
}

function beep() {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start(); osc.stop(audioCtx.currentTime + 0.5);
  } catch (e) { /* AudioContext kısıtlı olabilir (kullanıcı etkileşimi öncesi) */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// SOS / MAP CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
function sendSOSWhatsApp() {
  if (!myLatLng) { toast("Konum henüz alınamadı."); return; }
  const msg = encodeURIComponent(`🚨 ACİL - YolSinyali\n${myUsername} yardım istiyor!\n📍 https://maps.google.com?q=${myLatLng.lat},${myLatLng.lng}`);
  window.open(`https://wa.me/?text=${msg}`, "_blank");
}

function centerOnMe() {
  if (myLatLng) map.setView(myLatLng, 17, { animate: true });
  else toast("Konum henüz alınamadı.");
}
