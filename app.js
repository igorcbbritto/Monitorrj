const DEMO_ROUTES = [
  { route_id: "demo-457", short_name: "457", long_name: "Abolição - Copacabana", direction: "Ida" },
  { route_id: "demo-100", short_name: "100", long_name: "Central - Gávea", direction: "Ida" },
  { route_id: "demo-485", short_name: "485", long_name: "Penha - General Osório", direction: "Ida" }
];

const DEMO_STOPS = {
  "demo-457": [
    { name: "Abolição", lat: -22.8870, lon: -43.2950 },
    { name: "Méier", lat: -22.9020, lon: -43.2810 },
    { name: "Maracanã", lat: -22.9120, lon: -43.2220 },
    { name: "Centro", lat: -22.9068, lon: -43.1729 },
    { name: "Copacabana", lat: -22.9711, lon: -43.1822 }
  ],
  "demo-100": [
    { name: "Central", lat: -22.9028, lon: -43.1905 },
    { name: "Catete", lat: -22.9250, lon: -43.1760 },
    { name: "Botafogo", lat: -22.9510, lon: -43.1810 },
    { name: "Gávea", lat: -22.9780, lon: -43.2380 }
  ],
  "demo-485": [
    { name: "Penha", lat: -22.8410, lon: -43.2770 },
    { name: "Olaria", lat: -22.8510, lon: -43.2570 },
    { name: "Centro", lat: -22.9068, lon: -43.1729 },
    { name: "Ipanema", lat: -22.9838, lon: -43.2056 }
  ]
};

const DEMO_VEHICLES = {
  "demo-457": [
    { id: "DEMO-457-01", lat: -22.9180, lon: -43.2150, speed: 31, updated: "agora" },
    { id: "DEMO-457-02", lat: -22.9460, lon: -43.1900, speed: 24, updated: "agora" },
    { id: "DEMO-457-03", lat: -22.9650, lon: -43.1850, speed: 18, updated: "agora" }
  ],
  "demo-100": [
    { id: "DEMO-100-01", lat: -22.9340, lon: -43.1790, speed: 22, updated: "agora" },
    { id: "DEMO-100-02", lat: -22.9620, lon: -43.2020, speed: 17, updated: "agora" }
  ],
  "demo-485": [
    { id: "DEMO-485-01", lat: -22.8800, lon: -43.2400, speed: 28, updated: "agora" },
    { id: "DEMO-485-02", lat: -22.9300, lon: -43.1900, speed: 20, updated: "agora" }
  ]
};

const map = L.map("map").setView([-22.9068, -43.1729], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let routeLine = null;
let stopMarkers = [];
let vehicleMarkers = [];
let selectedRoute = null;
let seconds = 20;

function searchRoutes(query = "") {
  const q = query.toLowerCase();
  return !q ? DEMO_ROUTES : DEMO_ROUTES.filter(r =>
    r.short_name.toLowerCase().includes(q) || r.long_name.toLowerCase().includes(q)
  );
}

function loadRoutes() {
  const q = document.getElementById("search").value.trim();
  const routes = searchRoutes(q);
  const box = document.getElementById("routes");
  box.innerHTML = "";

  if (!routes.length) {
    box.innerHTML = "<p>Nenhuma linha encontrada.</p>";
    return;
  }

  routes.forEach(route => {
    const btn = document.createElement("button");
    btn.className = "route";
    btn.innerHTML = `<strong>${route.short_name}</strong><span>${route.long_name}</span>`;
    btn.onclick = () => selectRoute(route.route_id);
    box.appendChild(btn);
  });
}

function selectRoute(routeId) {
  selectedRoute = routeId;
  const route = DEMO_ROUTES.find(r => r.route_id === routeId);
  if (!route) return;

  document.getElementById("details").classList.remove("hidden");
  document.getElementById("routeTitle").textContent = `Linha ${route.short_name}`;
  document.getElementById("routeDirection").textContent = `${route.long_name} · ${route.direction}`;

  clearMap();
  const stops = DEMO_STOPS[routeId] || [];
  const points = stops.map(s => [s.lat, s.lon]);

  if (points.length >= 2) {
    routeLine = L.polyline(points, { weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }

  stops.forEach((stop, index) => {
    const marker = L.circleMarker([stop.lat, stop.lon], { radius: 5 }).addTo(map);
    marker.bindPopup(`<b>${index + 1}. ${stop.name}</b>`);
    stopMarkers.push(marker);
  });

  refreshVehicles();
}

function refreshVehicles() {
  if (!selectedRoute) return;

  try {
    const vehicles = DEMO_VEHICLES[selectedRoute] || [];
    const box = document.getElementById("vehicles");
    box.innerHTML = `<h3>Ônibus em circulação: ${vehicles.length}</h3>`;

    vehicleMarkers.forEach(m => map.removeLayer(m));
    vehicleMarkers = [];

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

    document.getElementById("status").textContent = "Atualizado";
    seconds = 20;
  } catch (error) {
    document.getElementById("status").textContent = "Erro na atualização";
  }
}

function clearMap() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  stopMarkers.forEach(m => map.removeLayer(m));
  vehicleMarkers.forEach(m => map.removeLayer(m));
  stopMarkers = [];
  vehicleMarkers = [];
}

document.getElementById("searchBtn").onclick = loadRoutes;
document.getElementById("search").addEventListener("keydown", e => {
  if (e.key === "Enter") loadRoutes();
});

setInterval(() => {
  if (selectedRoute) {
    seconds--;
    if (seconds <= 0) refreshVehicles();
    document.getElementById("countdown").textContent = Math.max(seconds, 0);
  }
}, 1000);

loadRoutes();
