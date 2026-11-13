import json
import math
import random
import unittest

from hotornot import geo

SQUARE_WITH_HOLE = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
]
U_SHAPE = [[[0, 0], [9, 0], [9, 9], [6, 9], [6, 3], [3, 3], [3, 9], [0, 9]]]
BAND = [[[0, 0.4], [10, 0.4], [10, 0.6], [0, 0.6]]]
ACROSS_180 = [[[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]]]
# A MYD14 footprint from cmr_granules: it spans 150.9°E to 179.0°W.
FOOTPRINT_ACROSS_180 = [[[174.0558854, -21.7381319], [150.8708633, -24.8629242],
                         [152.8620805, -43.073913], [-179.0472845, -39.0490563],
                         [174.0558854, -21.7381319]]]
AROUND_SOUTH_POLE = [[[-180, -90], [-180, -60], [0, -65], [180, -60], [180, -90], [-180, -90]]]


class PointInPolygon(unittest.TestCase):
    def check(self, rings, cases):
        for lon, lat, expected in cases:
            with self.subTest(lon=lon, lat=lat):
                self.assertIs(geo.point_in_polygon(lon, lat, rings), expected)

    def test_square_with_hole(self):
        self.check(SQUARE_WITH_HOLE, [(1, 1, True), (5, 5, False), (7, 5, True), (11, 5, False),
                                      (-1, 5, False), (5, -0.1, False)])

    def test_open_ring_and_extra_coordinates(self):
        ring = [[0, 0, 7], [10, 0, 7], [10, 10, 7], [0, 10, 7]]
        self.check([ring], [(5, 5, True), (15, 5, False)])

    def test_concave(self):
        self.check(U_SHAPE, [(1, 8, True), (4.5, 8, False), (4.5, 1, True), (8, 8, True)])

    def test_multipolygon(self):
        rings = geo.rings_of({"type": "MultiPolygon", "coordinates": [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
        ]})
        self.check(rings, [(0.5, 0.5, True), (5.5, 5.5, True), (3, 3, False)])

    def test_across_antimeridian(self):
        self.check(ACROSS_180, [(175, 0, True), (-175, 0, True), (180, 0, True), (-180, 0, True),
                                (0, 0, False), (160, 0, False), (-160, 0, False)])

    def test_real_footprint_across_antimeridian(self):
        # (145, -30) and (105, -35) are inside the footprint when it is read as a flat polygon.
        self.check(FOOTPRINT_ACROSS_180, [(165, -30, True), (178, -35, True), (-179.5, -38.5, True),
                                          (145, -30, False), (105, -35, False), (-179.5, -30, False)])

    def test_ring_around_a_pole(self):
        self.check(AROUND_SOUTH_POLE, [(10, -80, True), (-170, -80, True), (10, -50, False)])


class PolygonIntersectsBbox(unittest.TestCase):
    def check(self, rings, cases):
        for bbox, expected in cases:
            with self.subTest(bbox=bbox):
                self.assertIs(geo.polygon_intersects_bbox(rings, bbox), expected)

    def test_crossing_with_no_vertex_inside(self):
        self.assertFalse(any(4 <= x <= 6 and 0 <= y <= 1 for x, y in BAND[0]))
        self.assertFalse(any(geo.point_in_polygon(x, y, BAND) for x, y in [(4, 0), (6, 0), (6, 1), (4, 1)]))
        self.check(BAND, [([4, 0, 6, 1], True), ([4, 0.7, 6, 1], False)])

    def test_containment_both_ways(self):
        self.check(SQUARE_WITH_HOLE, [([1, 1, 2, 2], True), ([-5, -5, 15, 15], True)])

    def test_inside_hole_or_notch(self):
        self.check(SQUARE_WITH_HOLE, [([4.5, 4.5, 5.5, 5.5], False), ([3, 3, 7, 7], True)])
        self.check(U_SHAPE, [([3.5, 4, 5.5, 8], False), ([3.5, 2, 5.5, 8], True)])

    def test_disjoint_and_touching(self):
        self.check(SQUARE_WITH_HOLE, [([11, 0, 12, 10], False), ([10, 2, 12, 3], True),
                                      ([10, 10, 11, 11], True)])

    def test_triangle_clipping_a_corner(self):
        triangle = [[[-1, 0.5], [0.5, -1], [-1, -1]]]
        self.check(triangle, [([0, 0, 1, 1], False), ([-0.1, -0.1, 1, 1], False),
                              ([-0.3, -0.3, 1, 1], True)])

    def test_across_antimeridian(self):
        self.check(ACROSS_180, [([-175, -5, -172, 5], True), ([175, -5, 178, 5], True),
                                ([100, -5, 120, 5], False), ([175, 20, 178, 30], False)])

    def test_real_footprint_across_antimeridian(self):
        self.check(FOOTPRINT_ACROSS_180, [([140, -39, 154, -28], True), ([100, -36, 110, -34], False),
                                          ([29.5, 29.8, 32.5, 31.8], False)])

    def test_rejects_swapped_bounds(self):
        with self.assertRaises(ValueError):
            geo.polygon_intersects_bbox(BAND, [6, 0, 4, 1])


class Helpers(unittest.TestCase):
    def test_rings_of(self):
        polygon = {"type": "Polygon", "coordinates": SQUARE_WITH_HOLE}
        self.assertEqual(geo.rings_of(polygon), SQUARE_WITH_HOLE)
        self.assertEqual(geo.rings_of([SQUARE_WITH_HOLE, BAND]), SQUARE_WITH_HOLE + BAND)
        with self.assertRaises(ValueError):
            geo.rings_of({"type": "Point", "coordinates": [0, 0]})

    def test_bbox_of(self):
        self.assertEqual(geo.bbox_of(SQUARE_WITH_HOLE), [0, 0, 10, 10])
        self.assertEqual(geo.bbox_of(FOOTPRINT_ACROSS_180), [-180, -43.073913, 180, -21.7381319])


# A MYD14 footprint stored for nile_delta: CMR matched it to the buffered box, but its north
# edge read as a straight lon/lat line passes south of the box.
BOWED = [[[[51.0118904, 31.6059127], [27.2203558, 28.0062006], [32.7843646, 10.3820205],
           [53.9567982, 13.4300566], [51.0118904, 31.6059127]]]]
NILE_BUFFERED = [29.0, 29.3, 33.0, 32.3]


class FootprintRings(unittest.TestCase):
    def test_edges_follow_great_circles(self):
        self.assertFalse(geo.polygon_intersects_bbox(geo.rings_of(BOWED), NILE_BUFFERED))
        self.assertTrue(geo.polygon_intersects_bbox(geo.footprint_rings(BOWED), NILE_BUFFERED))
        self.assertTrue(geo.polygon_intersects_bbox(geo.footprint_rings(json.dumps(BOWED)), NILE_BUFFERED))

    def test_arc_shape(self):
        ring = geo.footprint_rings([[[[0, 30], [20, 30], [20, 20], [0, 20]]]])[0]
        peak = math.degrees(math.atan(math.tan(math.radians(30)) / math.cos(math.radians(10))))
        self.assertAlmostEqual(max(lat for lon, lat in ring if lat > 25), peak, places=6)
        self.assertTrue(all(-180 <= lon <= 180 and -90 <= lat <= 90 for lon, lat in ring))
        equator = geo.footprint_rings([[[[0, 0], [10, 0]]]])[0]
        self.assertGreater(len(equator), 2)
        self.assertTrue(all(abs(lat) < 1e-9 for _, lat in equator))

    def test_short_edges_are_kept(self):
        small = [[[31.0, 30.0], [31.2, 30.0], [31.2, 30.2], [31.0, 30.2], [31.0, 30.0]]]
        self.assertEqual(geo.footprint_rings([small])[0], [tuple(p) for p in small[0]])

    def test_across_antimeridian(self):
        rings = geo.footprint_rings([FOOTPRINT_ACROSS_180])
        for lon, lat, expected in [(165, -30, True), (178, -35, True), (145, -30, False), (105, -35, False)]:
            with self.subTest(lon=lon, lat=lat):
                self.assertIs(geo.point_in_polygon(lon, lat, rings), expected)


class Distances(unittest.TestCase):
    def test_haversine(self):
        degree = math.pi * geo.EARTH_RADIUS_KM / 180
        self.assertAlmostEqual(geo.haversine_km(0, 0, 1, 0), degree, places=6)
        self.assertAlmostEqual(geo.haversine_km(0, 0, 0, 90), 90 * degree, places=6)
        self.assertAlmostEqual(geo.haversine_km(0, 179.5, 0, -179.5), degree, places=6)
        self.assertAlmostEqual(geo.haversine_km(60, 0, 60, 1), geo.haversine_km(60, 1, 60, 0))
        self.assertEqual(geo.haversine_km(30.1, 31.2, 30.1, 31.2), 0)

    def test_local_km(self):
        degree = geo.KM_PER_DEG
        self.assertEqual(geo.local_km(30, 31, 30, 31), (0, 0))
        x, y = geo.local_km(30, 31, 31, 31)
        self.assertAlmostEqual(x, 0)
        self.assertAlmostEqual(y, degree)
        x, y = geo.local_km(60, 10, 60, 11)
        self.assertAlmostEqual(x, degree / 2, places=6)
        x, _ = geo.local_km(0, 179.9, 0, -179.9)
        self.assertAlmostEqual(x, 0.2 * degree, places=6)

    def test_local_km_agrees_with_haversine_within_5_km(self):
        rng = random.Random(1)
        for _ in range(2000):
            lat0, lon0 = rng.uniform(-45, 45), rng.uniform(-180, 180)
            bearing, dist = rng.uniform(0, 2 * math.pi), rng.uniform(0.1, 5)
            lat = lat0 + dist * math.cos(bearing) / geo.KM_PER_DEG
            lon = lon0 + dist * math.sin(bearing) / (geo.KM_PER_DEG * math.cos(math.radians(lat0)))
            x, y = geo.local_km(lat0, lon0, lat, lon)
            exact = geo.haversine_km(lat0, lon0, lat, lon)
            self.assertLess(abs(math.hypot(x, y) - exact) / exact, 0.001)


class GridIndexTest(unittest.TestCase):
    def test_matches_brute_force(self):
        rng = random.Random(7)
        for center_lat in (30.5, -35.0, 80.0):
            points = [(center_lat + rng.uniform(-0.3, 0.3), 31 + rng.uniform(-0.3, 0.3))
                      for _ in range(3000)]
            index = geo.GridIndex(cell_km=1.0)
            for i, (lat, lon) in enumerate(points):
                index.add(lat, lon, i)
            self.assertEqual(len(index), len(points))
            for _ in range(50):
                qlat, qlon = center_lat + rng.uniform(-0.2, 0.2), 31 + rng.uniform(-0.2, 0.2)
                for radius in (0.375, 1.0, 3.6):
                    with self.subTest(lat=center_lat, radius=radius):
                        found = index.near(qlat, qlon, radius)
                        expected = sorted(i for i, (lat, lon) in enumerate(points)
                                          if geo.haversine_km(qlat, qlon, lat, lon) <= radius)
                        self.assertEqual(sorted(item for _, item in found), expected)
                        distances = [d for d, _ in found]
                        self.assertEqual(distances, sorted(distances))

    def test_edge_cases(self):
        index = geo.GridIndex(cell_km=1.0)
        index.add(30.0, 31.0, "a")
        index.add(30.0, 31.0, "b")
        self.assertEqual(sorted(item for _, item in index.near(30.0, 31.0, 0)), ["a", "b"])
        self.assertEqual(index.near(30.0, 31.0, -1), [])
        self.assertEqual(index.near(89.99, 0, 5), [])
        with self.assertRaises(ValueError):
            geo.GridIndex(cell_km=0)
