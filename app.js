const API_BASE = "https://api.mobilidade.rio";
const GPS_API = "https://dados.mobilidade.rio/gps/sppo";
const LIVE_WINDOW_MINUTES = 5;
const REFRESH_SECONDS = 60;

const map = L.map("map").setView([-22.9068, -43.1729], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

let routeLine = null;
let stopMarkers = [];
let vehicleMarkers = [];
let routesCache = [];
let gtfsIndex = null;
let selectedLine = null;
let selectedRoute = null;
let selectedRouteData = null;
let seconds = REFRESH_SECONDS;
let dataSource = "";

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatApiDate(date) { return date.toISOString().slice(0, 19).replace("T", "+"); }

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally { clearTimeout(timeout); }
}

function pageResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function normalizeNextUrl(next) {
  if (!next) return null;
  try { const u = new URL(next, API_BASE); u.protocol = "https:"; return u.toString(); } catch { return null; }
}

async function apiGetAll(path, maxPages = 50) {
  let url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const all = [];
  for (let page = 0; page < maxPages && url; page++) {
    const data = await fetchJson(url);
    all.push(...pageResults(data));
    url = data && !Array.isArray(data) ? normalizeNextUrl(data.next) : null;
  }
  return all;
}

async function loadLocalGtfsIndex() {
  if (gtfsIndex) return gtfsIndex;
  const data = await fetchJson(`./gtfs-routes/index.json?v=${Date.now()}`);
  if (!Array.isArray(data.routes) || !data.routes.length) throw new Error("Índice GTFS vazio.");
  gtfsIndex = data;
  return data;
}

function mapIndexRoutes(data) {
  return data.routes.map(route => ({
    route_id: route.route_id,
    short_name: String(route.short_name || "").trim(),
    long_name: String(route.long_name || "").trim(),
    color: route.color || null,
    text_color: route.text_color || null
  })).filter(r => r.route_id && r.short_name)
    .sort((a, b) => a.short_name.localeCompare(b.short_name, "pt-BR", { numeric: true }));
}

async function loadRealRoutes() {
  try {
    const data = await apiGetAll("/gtfs/routes/", 20);
    const routes = data.map(route => ({
      route_id: route.route_id,
      short_name: String(route.route_short_name ?? "").trim(),
      long_name: String(route.route_long_name ?? "").trim(),
      color: route.route_color || null,
      text_color: route.route_text_color || null
    })).filter(r => r.route_id && r.short_name)
      .sort((a, b) => a.short_name.localeCompare(b.short_name, "pt-BR", { numeric: true }));
    if (!routes.length) throw new Error("API sem linhas.");
    routesCache = routes;
    dataSource = "API SMTR";
  } catch (apiError) {
    console.warn("API GTFS indisponível, usando índice GTFS local:", apiError);
    const local = await loadLocalGtfsIndex();
    routesCache = mapIndexRoutes(local);
    dataSource = "cache GTFS oficial";
  }
  return routesCache;
}

function searchRoutes(query = "") {
  const q = query.trim().toLowerCase();
  if (!q) return routesCache.slice(0, 100);
  return routesCache.filter(r => r.short_name.toLowerCase().includes(q) || r.long_name.toLowerCase().includes(q)).slice(0, 100);
}

function addRouteButton(route) {
  const btn = document.createElement("button");
  btn.className = "route";
  btn.innerHTML = `<strong>${route.short_name}</strong><span>${route.long_name || "Linha sem descrição"}</span>`;
  btn.onclick = () => selectRoute(route);
  document.getElementById("routes").appendChild(btn);
}

function renderRouteSearchResults() {
  const box = document.getElementById("routes");
  const routes = searchRoutes(document.getElementById("search").value);
  box.innerHTML = "";
  if (!routes.length) { box.innerHTML = "<p>Nenhuma linha encontrada.</p>"; return; }
  routes.forEach(addRouteButton);
}

async function loadCachedRouteData(route) {
  const data = await fetchJson(`./gtfs-routes/${encodeURIComponent(route.route_id)}.json?v=${Date.now()}`);
  if (!Array.isArray(data.trips) || !data.trips.length) throw new Error(`Esta linha não possui trajeto no cache GTFS.`);
  const trip = data.trips[0];
  return { shape: trip.shape || [], stops: trip.stops || [], trip };
}

async function loadApiTripData(line) {
  const encoded = encodeURIComponent(line);
  const trips = await apiGetAll(`/gtfs/trips/?trip_short_name=${encoded}`, 30);
  const valid = trips.filter(t => t.trip_id);
  if (!valid.length) throw new Error(`Nenhuma viagem GTFS para ${line}.`);
  const byDirection = new Map();
  valid.forEach(t => { const d = String(t.direction_id ?? "0"); if (!byDirection.has(d)) byDirection.set(d, t); });
  const trip = [...byDirection.values()][0] || valid[0];
  const stopTimes = await apiGetAll(`/gtfs/stop_times/?trip_id=${encodeURIComponent(trip.trip_id)}`, 30);
  const stops = stopTimes.sort((a,b) => Number(a.stop_sequence||0)-Number(b.stop_sequence||0)).map(item => {
    const s = item.stop_id;
    if (!s || typeof s !== "object") return null;
    return { id:s.stop_id, name:s.stop_name||"Parada sem nome", lat:normalizeNumber(s.stop_lat), lon:normalizeNumber(s.stop_lon) };
  }).filter(s => s && s.lat !== null && s.lon !== null);
  let shape = [];
  if (trip.shape_id) {
    const points = await apiGetAll(`/gtfs/shapes/?shape_id=${encodeURIComponent(trip.shape_id)}`, 30);
    shape = points.sort((a,b)=>Number(a.shape_pt_sequence||0)-Number(b.shape_pt_sequence||0)).map(p=>[normalizeNumber(p.shape_pt_lat),normalizeNumber(p.shape_pt_lon)]).filter(p=>p[0]!==null&&p[1]!==null);
  }
  return { shape, stops, trip };
}

async function getRouteData(route) {
  if (dataSource === "cache GTFS oficial") {
    return loadCachedRouteData(route);
  }
  try {
    return await loadApiTripData(route.short_name);
  } catch (e) {
    try {
      const local = await loadCachedRouteData(route);
      dataSource = "cache GTFS oficial";
      return local;
    } catch (_) {
      throw e;
    }
  }
}

async function loadRoutes() {
  const box = document.getElementById("routes");
  box.innerHTML = "<p>Carregando linhas oficiais...</p>";
  document.getElementById("status").textContent = "Carregando dados oficiais...";
  try {
    await loadRealRoutes();
    renderRouteSearchResults();
    document.getElementById("status").textContent = `SMTR · ${routesCache.length} linhas · ${dataSource}`;
  } catch (error) {
    console.error("Falha ao carregar GTFS:", error);
    box.innerHTML = `<p>Não foi possível carregar as linhas.<br><small>${error.message || "Tente novamente."}</small></p>`;
    document.getElementById("status").textContent = "Dados GTFS indisponíveis";
  }
}

async function selectRoute(route) {
  selectedRoute = route;
  selectedLine = route.short_name;
  seconds = REFRESH_SECONDS;
  document.getElementById("details").classList.remove("hidden");
  document.getElementById("routeTitle").textContent = `Linha ${route.short_name}`;
  document.getElementById("routeDirection").textContent = route.long_name || "Dados oficiais da SMTR";
  document.getElementById("status").textContent = "Carregando trajeto...";
  clearMap();
  document.getElementById("vehicles").innerHTML = "<p>Carregando trajeto e GPS...</p>";
  try {
    selectedRouteData = await getRouteData(route);
    drawRoute(selectedRouteData.shape, selectedRouteData.stops);
    await refreshVehicles();
  } catch (error) {
    console.error("Falha ao carregar trajeto:", error);
    document.getElementById("status").textContent = "Trajeto indisponível";
    document.getElementById("vehicles").innerHTML = `<p>${error.message || "Não foi possível carregar o trajeto."}</p>`;
  }
}

function drawRoute(shape, stops) {
  if (shape.length >= 2) {
    routeLine = L.polyline(shape, { weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  } else if (stops.length >= 2) {
    routeLine = L.polyline(stops.map(s=>[s.lat,s.lon]), { weight: 5, dashArray: "8 6" }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
  stops.forEach((stop,index) => {
    const marker = L.circleMarker([stop.lat,stop.lon], {radius:4}).addTo(map);
    marker.bindPopup(`<b>${index+1}. ${stop.name}</b>`);
    stopMarkers.push(marker);
  });
}

function normalizeLine(value) { return String(value ?? "").trim().toUpperCase().replace(/\s+/g, ""); }

function normalizeLiveVehicle(item) {
  const lat=normalizeNumber(item.latitude), lon=normalizeNumber(item.longitude);
  if(lat===null||lon===null) return null;
  const speed=normalizeNumber(item.velocidade);
  const raw=item.datetime ?? item.datahora ?? item.timestamp_gps;
  let timestamp=0, updated="agora";
  if(raw){ const d=new Date(raw); if(!Number.isNaN(d.getTime())){timestamp=d.getTime();updated=d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});} }
  return {id:item.id_veiculo ?? item.ordem ?? "Veículo",lat,lon,speed:speed??0,updated,timestamp};
}

async function fetchLiveVehicles(line) {
  const now=new Date(), start=new Date(now.getTime()-LIVE_WINDOW_MINUTES*60000);
  const params=new URLSearchParams({dataInicial:formatApiDate(start),dataFinal:formatApiDate(now)});
  const response=await fetch(`${GPS_API}?${params.toString()}`,{cache:"no-store"});
  if(!response.ok) throw new Error(`GPS SMTR HTTP ${response.status}`);
  const data=await response.json();
  const rawItems=Array.isArray(data)?data:(data.veiculos||data.data||[]);
  const wanted=normalizeLine(line), latest=new Map();
  rawItems.forEach(item=>{
    const itemLine=normalizeLine(item.servico ?? item.linha ?? item.route_short_name);
    if(itemLine!==wanted) return;
    const v=normalizeLiveVehicle(item); if(!v) return;
    const key=String(v.id), previous=latest.get(key);
    if(!previous||v.timestamp>=previous.timestamp) latest.set(key,v);
  });
  return Array.from(latest.values());
}

async function refreshVehicles() {
  if(!selectedLine) return;
  try {
    const vehicles=await fetchLiveVehicles(selectedLine);
    renderVehicles(vehicles);
    document.getElementById("status").textContent=`GPS real · SMTR · ${dataSource}`;
  } catch(error) {
    console.error(error);
    document.getElementById("status").textContent=`GPS indisponível · ${dataSource}`;
    renderVehicles([]);
  }
  seconds=REFRESH_SECONDS;
}

function renderVehicles(vehicles) {
  const box=document.getElementById("vehicles");
  box.innerHTML=`<h3>Ônibus encontrados: ${vehicles.length}</h3>`;
  vehicleMarkers.forEach(m=>map.removeLayer(m)); vehicleMarkers=[];
  if(!vehicles.length){ box.innerHTML+=`<p>Nenhum ônibus desta linha foi localizado nos últimos ${LIVE_WINDOW_MINUTES} minutos.</p>`; return; }
  vehicles.forEach(v=>{
    const marker=L.marker([v.lat,v.lon]).addTo(map);
    marker.bindPopup(`<b>🚌 ${v.id}</b><br>Velocidade: ${v.speed} km/h<br>Atualizado: ${v.updated}`);
    vehicleMarkers.push(marker);
    const item=document.createElement("div"); item.className="vehicle";
    item.innerHTML=`<strong>🚌 ${v.id}</strong><span>${v.speed} km/h · ${v.updated}</span>`;
    item.onclick=()=>{map.setView([v.lat,v.lon],15);marker.openPopup();}; box.appendChild(item);
  });
}

function clearMap(){
  if(routeLine){map.removeLayer(routeLine);routeLine=null;}
  stopMarkers.forEach(m=>map.removeLayer(m)); vehicleMarkers.forEach(m=>map.removeLayer(m));
  stopMarkers=[];vehicleMarkers=[];
}

document.getElementById("searchBtn").onclick=renderRouteSearchResults;
document.getElementById("search").addEventListener("input",renderRouteSearchResults);
document.getElementById("search").addEventListener("keydown",e=>{if(e.key==="Enter")renderRouteSearchResults();});

setInterval(()=>{if(!selectedLine)return;seconds--;document.getElementById("countdown").textContent=Math.max(seconds,0);if(seconds<=0)refreshVehicles();},1000);
loadRoutes();
