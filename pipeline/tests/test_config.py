import json
from datetime import date

import pytest

from hotornot import config


def test_time_constants():
    assert config.RECORD_START == date(2000, 11, 1)
    assert config.AQUA_START == date(2002, 7, 4)
    assert config.SNPP_START == date(2012, 1, 20)
    assert config.N20_START == date(2018, 4, 1)
    assert config.VIIRS_SWITCH == date(2026, 11, 2)
    assert config.VIIRS_SERIES_START == date(2012, 1, 1)
    assert config.BASELINE == (date(2003, 1, 1), date(2025, 12, 31))
    assert config.CALIBRATION == (date(2012, 1, 1), date(2019, 12, 31))
    assert config.N20_TRANSFER == (date(2018, 4, 1), date(2025, 12, 31))
    assert config.GRID_DEG == 0.05


def test_time_constants_are_dates():
    for name in ("RECORD_START", "AQUA_START", "SNPP_START", "N20_START", "VIIRS_SWITCH",
                 "VIIRS_SERIES_START"):
        assert type(getattr(config, name)) is date, name
    for name in ("BASELINE", "CALIBRATION", "N20_TRANSFER"):
        first, last = getattr(config, name)
        assert type(first) is date and type(last) is date and first < last, name


def test_regions_json_loads():
    cfg = config.load_config()
    assert [r["id"] for r in cfg["regions"]] == ["nile_delta", "california", "se_australia", "n_argentina"]
    assert cfg["buffer_deg"] == 0.5
    for r in cfg["regions"]:
        west, south, east, north = r["bbox"]
        assert r["buffered"] == (west - 0.5, south - 0.5, east + 0.5, north + 0.5)
        assert r["history"] in config.HISTORY_SOURCES
    by_id = {r["id"]: r for r in cfg["regions"]}
    assert by_id["nile_delta"]["bbox"] == [29.5, 29.8, 32.5, 31.8]
    assert by_id["n_argentina"]["excluded_countries"] == ["Bolivia", "Brazil"]
    assert by_id["california"]["history"] == "api"
    assert set(cfg["firms_api"]) == {"MODIS", "S-NPP", "NOAA-20"}
    assert cfg["firms_api"]["S-NPP"]["end"] == "2026-11-01"


def test_regions_selection():
    assert [r["id"] for r in config.regions()] == ["nile_delta", "california", "se_australia", "n_argentina"]
    assert [r["id"] for r in config.regions(["n_argentina", "nile_delta"])] == ["nile_delta", "n_argentina"]
    assert [r["id"] for r in config.regions("california")] == ["california"]
    with pytest.raises(ValueError, match="atlantis"):
        config.regions(["nile_delta", "atlantis"])


@pytest.mark.parametrize("change, message", [
    ({"history": "ftp"}, "history"),
    ({"bbox": [32.5, 29.8, 29.5, 31.8]}, "bbox"),
])
def test_bad_region_is_rejected(tmp_path, change, message):
    cfg = json.loads(config.CONFIG_PATH.read_text())
    cfg["regions"][0].update(change)
    path = tmp_path / "regions.json"
    path.write_text(json.dumps(cfg))
    with pytest.raises(ValueError, match=message):
        config.load_config(path)


def test_duplicate_region_is_rejected(tmp_path):
    cfg = json.loads(config.CONFIG_PATH.read_text())
    cfg["regions"].append(cfg["regions"][0])
    path = tmp_path / "regions.json"
    path.write_text(json.dumps(cfg))
    with pytest.raises(ValueError, match="twice"):
        config.load_config(path)
