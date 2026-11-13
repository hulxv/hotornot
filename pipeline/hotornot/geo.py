"""Geometry on lon/lat degrees, standing in for shapely.

A ring is a list of [lon, lat] points (GeoJSON order), closed or not. `rings` is a polygon's
outer ring followed by its holes, or every ring of a MultiPolygon: the even-odd rule handles
both. Edges are straight in lon/lat, as in GeoJSON; CMR footprint edges are great-circle arcs,
so read footprints with `footprint_rings`. Rings that cross the antimeridian, as about 7
percent of the CMR footprints in the database do, are unwrapped to continuous longitudes
before testing. Points exactly on a ring may test either way.
"""
import json
import math
from collections import defaultdict

EARTH_RADIUS_KM = 6371.0088
KM_PER_DEG = math.pi * EARTH_RADIUS_KM / 180


def rings_of(geometry):
    """Every ring of a GeoJSON Polygon or MultiPolygon, or of a bare list of polygons."""
    if isinstance(geometry, dict):
        if geometry["type"] == "Polygon":
            return list(geometry["coordinates"])
        if geometry["type"] == "MultiPolygon":
            return [ring for polygon in geometry["coordinates"] for ring in polygon]
        raise ValueError(f"unsupported geometry type {geometry['type']!r}")
    return [ring for polygon in geometry for ring in polygon]


def _xyz(lon, lat):
    lam, phi = math.radians(lon), math.radians(lat)
    return math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)


def _great_circle_ring(ring, max_step_deg):
    out = []
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        out.append((a[0], a[1]))
        pa, pb = _xyz(a[0], a[1]), _xyz(b[0], b[1])
        omega = math.acos(max(-1.0, min(1.0, sum(u * v for u, v in zip(pa, pb)))))
        steps = math.ceil(math.degrees(omega) / max_step_deg)
        if steps < 2 or math.sin(omega) < 1e-12:
            continue
        for j in range(1, steps):
            wa = math.sin((1 - j / steps) * omega) / math.sin(omega)
            wb = math.sin(j / steps * omega) / math.sin(omega)
            x, y, z = (wa * u + wb * v for u, v in zip(pa, pb))
            out.append((math.degrees(math.atan2(y, x)), math.degrees(math.atan2(z, math.hypot(x, y)))))
    return out


def footprint_rings(footprint, max_step_deg=0.25):
    """Rings of a `cmr_granules.footprint` value, JSON text or parsed. CMR edges are great-circle
    arcs that bow up to about 1° off the lon/lat line, so each is split into steps along its arc."""
    polygons = json.loads(footprint) if isinstance(footprint, str) else footprint
    return [_great_circle_ring(ring, max_step_deg) for polygon in polygons for ring in polygon]


def _crosses_antimeridian(rings):
    return any(abs(ring[i][0] - ring[i - 1][0]) > 180 for ring in rings for i in range(len(ring)))


def bbox_of(rings):
    """[west, south, east, north] for pre-filtering; spans -180 to 180 when a ring crosses the
    antimeridian."""
    lats = [p[1] for ring in rings for p in ring]
    if _crosses_antimeridian(rings):
        return [-180.0, min(lats), 180.0, max(lats)]
    lons = [p[0] for ring in rings for p in ring]
    return [min(lons), min(lats), max(lons), max(lats)]


def _unwrap(ring):
    out, shift, prev = [], 0.0, ring[0][0]
    for p in ring:
        step = p[0] - prev
        if step > 180:
            shift -= 360
        elif step < -180:
            shift += 360
        prev = p[0]
        out.append((p[0] + shift, p[1]))
    closing = ring[0][0] - prev
    if shift + (-360 if closing > 180 else 360 if closing < -180 else 0):
        # The ring winds around a pole; its raw coordinates are already the right planar shape.
        return [(p[0], p[1]) for p in ring]
    return out


def _prepare(rings):
    """Rings in one continuous longitude frame, and the longitude shifts a point needs to be
    tested at."""
    if not _crosses_antimeridian(rings):
        return rings, (0,)
    unwrapped = [_unwrap(ring) for ring in rings]
    ref = sum(p[0] for p in unwrapped[0]) / len(unwrapped[0])
    aligned = []
    for ring in unwrapped:
        turns = round((sum(p[0] for p in ring) / len(ring) - ref) / 360)
        aligned.append([(x - 360 * turns, y) for x, y in ring] if turns else ring)
    return aligned, (0, 360, -360)


def _parity(x, y, rings):
    inside = False
    for ring in rings:
        xj, yj = ring[-1][0], ring[-1][1]
        for p in ring:
            xi, yi = p[0], p[1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            xj, yj = xi, yi
    return inside


def point_in_polygon(lon, lat, rings):
    prepared, shifts = _prepare(rings)
    return any(_parity(lon + s, lat, prepared) for s in shifts)


def _segment_hits_box(x0, y0, x1, y1, west, south, east, north):
    t0, t1 = 0.0, 1.0
    dx, dy = x1 - x0, y1 - y0
    for p, q in ((-dx, x0 - west), (dx, east - x0), (-dy, y0 - south), (dy, north - y0)):
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return True


def _intersects_box(rings, west, south, east, north):
    for ring in rings:
        prev = ring[-1]
        for p in ring:
            if _segment_hits_box(prev[0], prev[1], p[0], p[1], west, south, east, north):
                return True
            prev = p
    # No edge touches the box, so it lies wholly inside or wholly outside: one corner decides.
    return _parity(west, south, rings)


def polygon_intersects_bbox(rings, bbox):
    """True when the polygon's area and the box [west, south, east, north] share any point."""
    west, south, east, north = bbox
    if west > east or south > north:
        raise ValueError(f"bbox must be [west, south, east, north], got {list(bbox)}")
    prepared, shifts = _prepare(rings)
    return any(_intersects_box(prepared, west + s, south, east + s, north) for s in shifts)


def haversine_km(lat1, lon1, lat2, lon2):
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((phi2 - phi1) / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def local_km(lat0, lon0, lat, lon):
    """(x east, y north) in km from (lat0, lon0) on an equirectangular projection centred there.
    The error is under 0.1 percent within 5 km of the centre below 45° latitude."""
    dlon = (lon - lon0 + 180) % 360 - 180
    return (math.radians(dlon) * EARTH_RADIUS_KM * math.cos(math.radians(lat0)),
            math.radians(lat - lat0) * EARTH_RADIUS_KM)


class GridIndex:
    """Points bucketed into lon/lat cells `cell_km` tall, for radius queries. Pick `cell_km`
    near the usual query radius. Buckets do not wrap across the antimeridian."""

    def __init__(self, cell_km):
        if cell_km <= 0:
            raise ValueError("cell_km must be positive")
        self.cell_deg = cell_km / KM_PER_DEG
        self._buckets = defaultdict(list)
        self._count = 0

    def __len__(self):
        return self._count

    def _key(self, lat, lon):
        return math.floor(lat / self.cell_deg), math.floor(lon / self.cell_deg)

    def add(self, lat, lon, item):
        self._buckets[self._key(lat, lon)].append((lat, lon, item))
        self._count += 1

    def near(self, lat, lon, radius_km):
        """[(distance_km, item)] for every point within `radius_km`, nearest first."""
        if radius_km < 0:
            return []
        dlat = radius_km / KM_PER_DEG
        if abs(lat) + dlat >= 90:
            dlon = 180.0
        else:
            dlon = math.degrees(math.asin(min(1.0, math.sin(math.radians(dlat))
                                              / math.cos(math.radians(lat))))) + 1e-9
        row0, col0 = self._key(lat - dlat, lon - dlon)
        row1, col1 = self._key(lat + dlat, lon + dlon)
        found = []
        for row in range(row0, row1 + 1):
            for col in range(col0, col1 + 1):
                for plat, plon, item in self._buckets.get((row, col), ()):
                    d = haversine_km(lat, lon, plat, plon)
                    if d <= radius_km:
                        found.append((d, item))
        found.sort(key=lambda pair: pair[0])
        return found
