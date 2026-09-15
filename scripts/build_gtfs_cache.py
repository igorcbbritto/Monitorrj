import csv
import json
import os
import shutil
import sys
import zipfile
from datetime import datetime, timezone

zip_path = sys.argv[1]
out_dir = sys.argv[2]


def rows(z, name):
    with z.open(name) as f:
        return csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f))

if os.path.exists(out_dir):
    shutil.rmtree(out_dir)
os.makedirs(out_dir, exist_ok=True)

with zipfile.ZipFile(zip_path) as z:
    routes = []
    route_ids = set()
    with z.open('routes.txt') as f:
        for r in csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f)):
            rid = r.get('route_id', '')
            short = (r.get('route_short_name') or '').strip()
            if not rid or not short:
                continue
            route_ids.add(rid)
            routes.append({
                'route_id': rid,
                'short_name': short,
                'long_name': (r.get('route_long_name') or '').strip(),
                'color': r.get('route_color') or None,
                'text_color': r.get('route_text_color') or None,
            })

    selected = {}
    with z.open('trips.txt') as f:
        for t in csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f)):
            rid = t.get('route_id', '')
            if rid not in route_ids:
                continue
            tid = t.get('trip_id', '')
            if not tid:
                continue
            direction = t.get('direction_id') or '0'
            key = (rid, direction)
            if key not in selected:
                selected[key] = {
                    'trip_id': tid,
                    'direction_id': direction,
                    'headsign': (t.get('trip_headsign') or '').strip(),
                    'shape_id': t.get('shape_id') or '',
                }

    route_data = {r['route_id']: {'route': r, 'trips': []} for r in routes}
    for (rid, _), trip in selected.items():
        route_data[rid]['trips'].append(trip)

    selected_trip_ids = {t['trip_id'] for t in selected.values()}
    stop_refs = {}
    with z.open('stop_times.txt') as f:
        for st in csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f)):
            tid = st.get('trip_id', '')
            if tid not in selected_trip_ids:
                continue
            try:
                seq = int(st.get('stop_sequence') or 0)
            except ValueError:
                seq = 0
            stop_refs.setdefault(tid, []).append((seq, st.get('stop_id', '')))

    needed_stop_ids = {sid for vals in stop_refs.values() for _, sid in vals if sid}
    stops = {}
    with z.open('stops.txt') as f:
        for s in csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f)):
            sid = s.get('stop_id', '')
            if sid not in needed_stop_ids:
                continue
            try:
                lat = float(s.get('stop_lat', ''))
                lon = float(s.get('stop_lon', ''))
            except ValueError:
                continue
            stops[sid] = {
                'id': sid,
                'name': (s.get('stop_name') or 'Parada sem nome').strip(),
                'lat': lat,
                'lon': lon,
            }

    shape_ids = {t['shape_id'] for t in selected.values() if t['shape_id']}
    shapes = {sid: [] for sid in shape_ids}
    with z.open('shapes.txt') as f:
        for p in csv.DictReader((line.decode('utf-8-sig', errors='replace') for line in f)):
            sid = p.get('shape_id', '')
            if sid not in shapes:
                continue
            try:
                lat = float(p.get('shape_pt_lat', ''))
                lon = float(p.get('shape_pt_lon', ''))
                seq = int(p.get('shape_pt_sequence') or 0)
            except ValueError:
                continue
            shapes[sid].append((seq, [lat, lon]))

    index = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'routes': routes,
    }

    for rid, item in route_data.items():
        trips = []
        for t in sorted(item['trips'], key=lambda x: x['direction_id']):
            trip_id = t['trip_id']
            trip_stops = []
            for _, sid in sorted(stop_refs.get(trip_id, [])):
                if sid in stops:
                    trip_stops.append(stops[sid])
            shape = [p for _, p in sorted(shapes.get(t['shape_id'], []))]
            trips.append({
                'trip_id': trip_id,
                'direction_id': t['direction_id'],
                'headsign': t['headsign'],
                'shape': shape,
                'stops': trip_stops,
            })

        with open(os.path.join(out_dir, f'{rid}.json'), 'w', encoding='utf-8') as f:
            json.dump({'route_id': rid, 'trips': trips}, f, ensure_ascii=False, separators=(',', ':'))

    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))

print(f'Cache GTFS dividido em {len(routes)} linhas: {out_dir}/index.json + arquivos por route_id')
