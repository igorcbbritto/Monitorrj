const API_BASE = "https://api.mobilidade.rio";
const GPS_API = "https://dados.mobilidade.rio/gps/sppo";
const LIVE_WINDOW_MINUTES = 5;
const REFRESH_SECONDS = 60;

const map = L.map("map").setView([-22.9068, -43.1729], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let routeLine = null;
let stopMarkers = [];
let vehicleMarkers = [];
let routesCache = [];
let selectedRoute = null;
let selectedLine = null;
let seconds = REFRESH_SECONDS;

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatApiDate(date) {
  return date.toISOString().slice(0, 19).replace("T", "+");
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}

function getResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

async function loadRealRoutes() {
  if (routesCache.length) return routesCache;

  const data = await apiGet("/gtfs/routes/");
  routesCache = getResults(data)
    .map(route => ({
      route_id: route.route_id,
      short_name: String(route.route_short_name ?? "").trim(),
      long_name: String(route.route_long_name ?? "").trim(),
      color: route.route_color || null,
      text_color: route.route_text_color || null
    }))
    .filter(route => route.route_id && route.short_name)
    .sort((a, b) => a.short_name.localeCompare(b.short_name, "pt-BR", { numeric: true }));

  return routesCache;
}

async function loadTripsForLine(line) {
  const encoded = encodeURIComponent(line);
  const data = await apiGet(`/gtfs/trips/?trip_short_name=${encoded}`);
  return getResults(data);
}

async function loadStopsAndShapeForTrip(tripId) {
  const encoded = encodeURIComponent(tripId);

  const [stopTimesData, tripData] = await Promise.all([
    apiGet(`/gtfs/stop_times/?trip_id=${encoded}`),
    apiGet(`/gtfs/trips/?trip_id=${encoded}`)
  ]);

  const stopTimes = getResults(stopTimesData)
    .sort((a, b) => Number(a.stop_sequence ?? 0) - Number(b.stop_sequence ?? 0));

  const trip = getResults(tripData)[0] || null;
  const shapeId = trip?.shape_id;

  let shape = [];
  if (shapeId) {
    const shapeData = await apiGet(`/gtfs/shapes/?shape_id=${encodeURIComponent(shapeId)}`);
    shape = getResults(shapeData)
      .sort((a, b) => Number(a.shape_pt_sequence ?? 0) - Number(b.shape_pt_sequence ?? 0))
      .map(point => [normalizeNumber(point.shape_pt_lat), normalizeNumber(point.shape_pt_lon)])
      .filter(point => point[0] !== null && point[1] !== null);
  }

  const stopIds = [...new Set(stopTimes.map(item => item.stop_id).filter(Boolean))];
  const stops = [];

  // A linha pode ter muitos pontos. O endpoint aceita stop_id e permite buscar em lote.
  for (let i = 0; i < stopIds.length; i += 80) {
    const batch = stopIds.slice(i, i + 80).join(",");
    const stopsData = await apiGet(`/gtfs/stops/?stop_id=${encodeURIComponent(batch)}`);
    stops.push(...getResults(stopsData));
  }

  const stopsById = new Map(stops.map(stop => [String(stop.stop_id), stop]));
  const orderedStops = stopTimes
    .map(item => stopsById.get(String(item.stop_id)))
    .filter(Boolean)
    .map(stop => ({
      id: stop.stop_id,
      name: stop.stop_name || "Parada sem nome",
      lat: normalizeNumber(stop.stop_lat),
      lon: normalizeNumber(stop.stop_lon)
    }))
    .filter(stop => stop.lat !== null && stop.lon !== null);

  return { shape, stops: orderedStops, trip };
}

function searchRoutes(query = "") {
  const q = query.trim().toLowerCase();
  if (!q) return routesCache.slice(0, 80);

  return routesCache.filter(route =>
    route.short_name.toLowerCase().includes(q) ||
    route.long_name.toLowerCase().includes(q)
  ).slice(0, 80);
}

function addRouteButton(route) {
  const btn = document.createElement("button");
  btn.className = "route";
  btn.innerHTML = `<strong>${route.short_name}</strong><span>${route.long_name || "Linha sem descrição"}</span>`;
  btn.onclick = () => selectRoute(route);
  document.getElementById("routes").appendChild(btn);
}

async function loadRoutes() {
  const box = document.getElementById("routes");
  box.innerHTML = "<p>Carregando linhas oficiais...</p>";
  document.getElementById("status").textContent = "Carregando GTFS...";

  try {
    await loadRealRoutes();
    renderRouteSearchResults();
    document.getElementById("status").textContent = "Linhas oficiais · SMTR";
  } catch (error) {
    console.error(error);
    box.innerHTML = "<p>Não foi possível carregar as linhas oficiais da SMTR.</p>";
    document.getElementById("status").textContent = "GTFS indisponível";
  }
}

function renderRouteSearchResults() {
  const q = document.getElementById("search").value;
  const box = document.getElementById("routes");
  const routes = searchRoutes(q);
  box.innerHTML = "";

  if (!routes.length) {
    box.innerHTML = "<p>Nenhuma linha oficial encontrada.</p>";
    return;
  }

  routes.forEach(addRouteButton);
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
    const trips = await loadTripsForLine(selectedLine);
    const validTrips = trips.filter(trip => trip.trip_id);

    if (!validTrips.length) {
      throw new Error("Nenhuma viagem GTFS encontrada para esta linha.");
    }

    // Usa uma viagem de cada sentido para permitir visualizar ida/volta.
    const tripByDirection = new Map();
    validTrips.forEach(trip => {
      const direction = String(trip.direction_id ?? "0");
      if (!tripByDirection.has(direction)) tripByDirection.set(direction, trip);
    });

    const selectedTrip = [...tripByDirection.values()][0] || validTrips[0];
    const routeData = await loadStopsAndShapeForTrip(selectedTrip.trip_id);

    drawRoute(routeData.shape, routeData.stops);
    await refreshVehicles();
  } catch (error) {
    console.error(error);
    document.getElementById("status").textContent = "Erro no GTFS";
    document.getElementById("vehicles").innerHTML = `<p>${error.message || "Não foi possível carregar a rota oficial."}</p>`;
  }
}

function drawRoute(shape, stops) {
  if (shape.length >= 2) {
    routeLine = L.polyline(shape, { weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  } else if (stops.length >= 2) {
    const points = stops.map(stop => [stop.lat, stop.lon]);
    routeLine = L.polyline(points, { weight: 5, dashArray: "8 6" }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }

  stops.forEach((stop, index) => {
    const marker = L.circleMarker([stop.lat, stop.lon], { radius: 4 }).addTo(map);
    marker.bindPopup(`<b>${index + 1}. ${stop.name}</b>`);
    stopMarkers.push(marker);
  });
}

function normalizeLiveVehicle(item) {
  const lat = normalizeNumber(item.latitude);
  const lon = normalizeNumber(item.longitude);
  if (lat === null || lon === null) return null;

  const speed = normalizeNumber(item.velocidade);
  const rawDate = item.datetime ?? item.datahora ?? item.timestamp_gps;
  let updated = "agora";
  let timestamp = 0;

  if (rawDate) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.getTime())) {
      timestamp = date.getTime();
      updated = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
  }

  return {
    id: item.id_veiculo ?? item.ordem ?? "Veículo",
    lat,
    lon,
    speed: speed ?? 0,
    updated,
    timestamp
  };
}

async function fetchLiveVehicles(line) {
  const now = new Date();
  const start = new Date(now.getTime() - LIVE_WINDOW_MINUTES * 60 * 1000);
  const params = new URLSearchParams({
    dataInicial: formatApiDate(start),
    dataFinal: formatApiDate(now)
  });

  const response = await fetch(`${GPS_API}?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`GPS SMTR HTTP ${response.status}`);

  const data = await response.json();
  const rawItems = Array.isArray(data) ? data : (data.veiculos || data.data || []);

  // A API pode devolver vários registros do mesmo ônibus na janela de 5 minutos.
  // Mantemos somente o registro mais recente de cada veículo e filtramos pela linha.
  const latest = new Map();
  rawItems.forEach(item => {
    const itemLine = String(item.servico ?? item.linha ?? item.route_short_name ?? "").trim();
    if (itemLine !== String(line).trim()) return;

    const vehicle = normalizeLiveVehicle(item);
    if (!vehicle) return;

    const key = String(vehicle.id);
    const previous = latest.get(key);
    if (!previous || vehicle.timestamp >= previous.timestamp) latest.set(key, vehicle);
  });

  return Array.from(latest.values());
}

async function refreshVehicles() {
  if (!selectedLine) return;

  document.getElementById("status").textContent = "Atualizando GPS...";

  try {
    const vehicles = await fetchLiveVehicles(selectedLine);
    renderVehicles(vehicles);
    document.getElementById("status").textContent = "GPS real · SMTR";
  } catch (error) {
    console.error(error);
    document.getElementById("status").textContent = "GPS indisponível";
    renderVehicles([]);
  }

  seconds = REFRESH_SECONDS;
}

function renderVehicles(vehicles) {
  const box = document.getElementById("vehicles");
  box.innerHTML = `<h3>Ônibus encontrados: ${vehicles.length}</h3>`;

  vehicleMarkers.forEach(marker => map.removeLayer(marker));
  vehicleMarkers = [];

  if (!vehicles.length) {
    const empty = document.createElement("p");
    empty.textContent = "Nenhum ônibus desta linha foi localizado nos últimos 5 minutos.";
    box.appendChild(empty);
    return;
  }

  vehicles.forEach(vehicle => {
    const marker = L.marker([vehicle.lat, vehicle.lon]).addTo(map);
    marker.bindPopup(`<b>🚌 ${vehicle.id}</b><br>Velocidade: ${vehicle.speed} km/h<br>Atualizado: ${vehicle.updated}`);
    vehicleMarkers.push(marker);

    const item = document.createElement("div");
    item.className = "vehicle";
    item.innerHTML = `<strong>🚌 ${vehicle.id}</strong><span>${vehicle.speed} km/h · ${vehicle.updated}</span>`;
    item.onclick = () => {
      map.setView([vehicle.lat, vehicle.lon], 15);
      marker.openPopup();
    };
    box.appendChild(item);
  });
}

function clearMap() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  stopMarkers.forEach(marker => map.removeLayer(marker));
  vehicleMarkers.forEach(marker => map.removeLayer(marker));
  stopMarkers = [];
  vehicleMarkers = [];
}

document.getElementById("searchBtn").onclick = renderRouteSearchResults;
document.getElementById("search").addEventListener("input", renderRouteSearchResults);
document.getElementById("search").addEventListener("keydown", event => {
  if (event.key === "Enter") renderRouteSearchResults();
});

setInterval(() => {
  if (!selectedLine) return;
  seconds--;
  document.getElementById("countdown").textContent = Math.max(seconds, 0);
  if (seconds <= 0) refreshVehicles();
}, 1000);

loadRoutes();
