import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from hotornot import config

REGION_IDS = ["nile_delta", "california", "se_australia", "n_argentina"]


class TimeConstants(unittest.TestCase):
    def test_values(self):
        self.assertEqual(config.RECORD_START, date(2000, 11, 1))
        self.assertEqual(config.AQUA_START, date(2002, 7, 4))
        self.assertEqual(config.SNPP_START, date(2012, 1, 20))
        self.assertEqual(config.N20_START, date(2018, 4, 1))
        self.assertEqual(config.VIIRS_SWITCH, date(2026, 11, 2))
        self.assertEqual(config.VIIRS_SERIES_START, date(2012, 1, 1))
        self.assertEqual(config.BASELINE, (date(2003, 1, 1), date(2025, 12, 31)))
        self.assertEqual(config.CALIBRATION, (date(2012, 1, 1), date(2019, 12, 31)))
        self.assertEqual(config.N20_TRANSFER, (date(2018, 4, 1), date(2025, 12, 31)))
        self.assertEqual(config.GRID_DEG, 0.05)

    def test_types(self):
        for name in ("RECORD_START", "AQUA_START", "SNPP_START", "N20_START", "VIIRS_SWITCH",
                     "VIIRS_SERIES_START"):
            self.assertIs(type(getattr(config, name)), date, name)
        for name in ("BASELINE", "CALIBRATION", "N20_TRANSFER"):
            first, last = getattr(config, name)
            self.assertIs(type(first), date, name)
            self.assertIs(type(last), date, name)
            self.assertLess(first, last, name)


class LoadConfig(unittest.TestCase):
    def test_regions_json(self):
        cfg = config.load_config()
        self.assertEqual([r["id"] for r in cfg["regions"]], REGION_IDS)
        self.assertEqual(cfg["buffer_deg"], 0.5)
        for r in cfg["regions"]:
            west, south, east, north = r["bbox"]
            self.assertEqual(r["buffered"], (west - 0.5, south - 0.5, east + 0.5, north + 0.5))
            self.assertIn(r["history"], config.HISTORY_SOURCES)
        by_id = {r["id"]: r for r in cfg["regions"]}
        self.assertEqual(by_id["nile_delta"]["bbox"], [29.5, 29.8, 32.5, 31.8])
        self.assertEqual(by_id["n_argentina"]["excluded_countries"], ["Bolivia", "Brazil"])
        self.assertEqual(by_id["california"]["history"], "api")
        self.assertEqual(set(cfg["firms_api"]), {"MODIS", "S-NPP", "NOAA-20"})
        self.assertEqual(cfg["firms_api"]["S-NPP"]["end"], "2026-11-01")

    def test_buffered_boxes_match_ingest(self):
        from hotornot.ingest import ingest
        self.assertEqual([r["buffered"] for r in config.load_config()["regions"]],
                         [r["buffered"] for r in ingest.load_config()["regions"]])

    def test_region_selection(self):
        self.assertEqual([r["id"] for r in config.regions()], REGION_IDS)
        self.assertEqual([r["id"] for r in config.regions(["n_argentina", "nile_delta"])],
                         ["nile_delta", "n_argentina"])
        self.assertEqual([r["id"] for r in config.regions("california,nile_delta")],
                         ["nile_delta", "california"])
        with self.assertRaisesRegex(ValueError, "atlantis"):
            config.regions(["nile_delta", "atlantis"])

    def load_modified(self, modify):
        cfg = json.loads(config.CONFIG_PATH.read_text())
        modify(cfg)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "regions.json"
            path.write_text(json.dumps(cfg))
            return config.load_config(path)

    def test_bad_regions_are_rejected(self):
        cases = [
            (lambda cfg: cfg["regions"][0].update(history="ftp"), "history"),
            (lambda cfg: cfg["regions"][0].update(bbox=[32.5, 29.8, 29.5, 31.8]), "bbox"),
            (lambda cfg: cfg["regions"].append(cfg["regions"][0]), "twice"),
        ]
        for modify, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.load_modified(modify)
