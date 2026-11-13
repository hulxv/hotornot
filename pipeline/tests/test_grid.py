import json
import unittest
from pathlib import Path

from hotornot import grid
from hotornot.config import GRID_DEG, load_config

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "shared" / "grid_vectors.json").read_text())


def brute_force(bbox):
    west, south, east, north = bbox
    out = []
    for row in range(grid.cell_of(south, 0)[0] - 2, grid.cell_of(north, 0)[0] + 3):
        for col in range(grid.cell_of(0, west)[1] - 2, grid.cell_of(0, east)[1] + 3):
            lon, lat = grid.center(row * grid.COLS + col)
            if west <= lon <= east and south <= lat <= north:
                out.append(row * grid.COLS + col)
    return sorted(out)


class ReferenceVectors(unittest.TestCase):
    def test_vector_file_is_complete(self):
        self.assertGreaterEqual(len(VECTORS), 44)

    def test_every_vector(self):
        for v in VECTORS:
            with self.subTest(lat=v["lat"], lon=v["lon"]):
                self.assertEqual(grid.cell_of(v["lat"], v["lon"]), (v["row"], v["col"], v["cell_id"]))
                self.assertEqual(grid.tile_of(v["cell_id"]), v["tile_id"])
                lon, lat = grid.center(v["cell_id"])
                self.assertAlmostEqual(lon, v["center"][0], delta=1e-6)
                self.assertAlmostEqual(lat, v["center"][1], delta=1e-6)

    def test_contracts_examples(self):
        self.assertEqual(grid.cell_of(30.6, 31.2), (2412, 4224, 17370624))
        self.assertEqual(grid.tile_of(17370624), "n30e031")
        self.assertEqual(grid.tile_of(grid.cell_of(-33.5, -60.2)[2]), "s34w061")


class CellOf(unittest.TestCase):
    def test_points_on_grid_lines_fall_in_the_cell_above(self):
        # Without round(.., 6), (-89.95 + 90) * 20 = 0.99999... would floor to row 0.
        self.assertEqual(grid.cell_of(-89.95, -179.9)[:2], (1, 2))
        for k in range(grid.ROWS):
            self.assertEqual(grid.cell_of(round(-90 + k * GRID_DEG, 2), 0)[0], k)
        for k in range(grid.COLS):
            self.assertEqual(grid.cell_of(0, round(-180 + k * GRID_DEG, 2))[1], k)

    def test_out_of_range(self):
        for lat, lon in [(90.0001, 0), (-90.0001, 0), (0, 180.0001), (0, -180.0001), (float("nan"), 0)]:
            with self.subTest(lat=lat, lon=lon), self.assertRaises(ValueError):
                grid.cell_of(lat, lon)


class CellsInBbox(unittest.TestCase):
    def test_matches_brute_force(self):
        for bbox in ([31.01, 30.02, 31.33, 30.27], [-60.21, -33.52, -59.97, -33.31],
                     [31.025, 30.025, 31.075, 30.075], [10.0, 10.0, 10.04, 10.04]):
            with self.subTest(bbox=bbox):
                self.assertEqual(grid.cells_in_bbox(bbox), brute_force(bbox))

    def test_regions(self):
        expected = {"nile_delta": 60 * 40, "california": 210 * 190, "se_australia": 280 * 220,
                    "n_argentina": 180 * 260}
        for r in load_config()["regions"]:
            with self.subTest(region=r["id"]):
                cells = grid.cells_in_bbox(r["bbox"])
                self.assertEqual(len(cells), expected[r["id"]])
                self.assertEqual(cells, sorted(set(cells)))
                west, south, east, north = r["bbox"]
                for cell_id in cells[:: max(1, len(cells) // 500)]:
                    lon, lat = grid.center(cell_id)
                    self.assertTrue(west < lon < east and south < lat < north)
                    self.assertEqual(grid.cell_of(lat, lon)[2], cell_id)

    def test_world_edges(self):
        self.assertEqual(len(grid.cells_in_bbox([-180, 89.9, 180, 90])), 2 * grid.COLS)
        self.assertEqual(len(grid.cells_in_bbox([-180, -90, -179.9, 90])), grid.ROWS * 2)
        self.assertEqual(grid.cells_in_bbox([179.96, 89.96, 180, 90]), [grid.ROWS * grid.COLS - 1])
        self.assertEqual(grid.cells_in_bbox([-180, -90, -179.96, -89.96]), [0])

    def test_rejects_swapped_bounds(self):
        with self.assertRaises(ValueError):
            grid.cells_in_bbox([32.5, 29.8, 29.5, 31.8])
