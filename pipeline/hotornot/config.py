"""Pipeline paths, region config and the CONTRACTS time constants."""
import json
from datetime import date
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = PIPELINE_DIR / "config" / "regions.json"
DATA_DIR = PIPELINE_DIR / "data"

GRID_DEG = 0.05

RECORD_START = date(2000, 11, 1)
AQUA_START = date(2002, 7, 4)
SNPP_START = date(2012, 1, 20)
N20_START = date(2018, 4, 1)
VIIRS_SWITCH = date(2026, 11, 2)
# The series uses VIIRS (and drops MODIS) from this date, before SNPP_START: see
# "Series sources by date" in CONTRACTS.
VIIRS_SERIES_START = date(2012, 1, 1)

# Inclusive (first day, last day) ranges.
BASELINE = (date(2003, 1, 1), date(2025, 12, 31))
CALIBRATION = (date(2012, 1, 1), date(2019, 12, 31))
N20_TRANSFER = (date(2018, 4, 1), date(2025, 12, 31))

HISTORY_SOURCES = ("country_files", "api")


def load_config(path=CONFIG_PATH):
    """regions.json as a dict; each region gains `buffered`, its bbox grown by `buffer_deg`."""
    with open(path) as f:
        cfg = json.load(f)
    buffer = cfg["buffer_deg"]
    seen = set()
    for r in cfg["regions"]:
        west, south, east, north = r["bbox"]
        if not (west < east and south < north):
            raise ValueError(f"region {r['id']}: bbox must be [west, south, east, north]")
        if r["history"] not in HISTORY_SOURCES:
            raise ValueError(f"region {r['id']}: history must be one of {HISTORY_SOURCES}")
        if r["id"] in seen:
            raise ValueError(f"region {r['id']} appears twice")
        seen.add(r["id"])
        r["buffered"] = (west - buffer, south - buffer, east + buffer, north + buffer)
    return cfg


def regions(ids=None, cfg=None):
    """Regions in config order, optionally only those in `ids` (a list or "a,b")."""
    all_regions = (cfg or load_config())["regions"]
    if ids is None:
        return all_regions
    if isinstance(ids, str):
        ids = ids.split(",")
    unknown = set(ids) - {r["id"] for r in all_regions}
    if unknown:
        raise ValueError(f"unknown region ids: {', '.join(sorted(unknown))}")
    return [r for r in all_regions if r["id"] in ids]
