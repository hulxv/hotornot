import sqlite3
import sys
from datetime import date

import numpy as np
import pytest

from hotornot import cli, db

STEP = """
NAME = "{name}"
HELP = "Say hello."


def add_arguments(parser):
    parser.add_argument("--times", type=int, default=1)


def run(args):
    print(" ".join(["hello"] * args.times))
    return args.times
"""


@pytest.fixture
def step_package(tmp_path, monkeypatch):
    pkg = tmp_path / "fake_steps"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    monkeypatch.syspath_prepend(tmp_path)
    yield pkg
    for name in [m for m in sys.modules if m == "fake_steps" or m.startswith("fake_steps.")]:
        del sys.modules[name]


@pytest.fixture
def db_file(tmp_path, monkeypatch):
    path = tmp_path / "pipeline.sqlite"
    monkeypatch.setenv("HOTORNOT_DB", str(path))
    return path


def test_info_is_discovered():
    steps = cli.discover_steps()
    assert "info" in steps
    assert steps["info"].HELP


def test_new_step_needs_no_cli_change(step_package, capsys):
    (step_package / "hello.py").write_text(STEP.format(name="hello"))
    (step_package / "_private.py").write_text(STEP.format(name="private"))
    (step_package / "helper.py").write_text("VALUE = 1\n")
    (step_package / "broken.py").write_text("raise ImportError('missing dependency')\n")

    assert list(cli.discover_steps("fake_steps")) == ["hello"]
    assert "skipping fake_steps.broken" in capsys.readouterr().err

    assert cli.main(["hello", "--times", "3"], package="fake_steps") == 3
    assert capsys.readouterr().out == "hello hello hello\n"


def test_duplicate_step_names_fail(step_package):
    (step_package / "a.py").write_text(STEP.format(name="hello"))
    (step_package / "b.py").write_text(STEP.format(name="hello"))
    with pytest.raises(RuntimeError, match="'hello'"):
        cli.discover_steps("fake_steps")


def test_help_lists_steps(capsys):
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--help"])
    assert exit_info.value.code == 0
    out = capsys.readouterr().out
    assert "info" in out and "row count" in out


def test_step_is_required():
    with pytest.raises(SystemExit) as exit_info:
        cli.main([])
    assert exit_info.value.code == 2


def test_info_prints_row_counts(db_file, capsys):
    con = sqlite3.connect(db_file)
    con.execute("CREATE TABLE raw_hotspots (a)")
    con.executemany("INSERT INTO raw_hotspots VALUES (?)", [(1,), (2,), (3,)])
    con.execute("CREATE TABLE cmr_granules (a)")
    con.executemany("INSERT INTO cmr_granules VALUES (?)", [(1,), (2,)])
    con.commit()
    con.close()

    assert cli.main(["info"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert str(db_file) in lines[0]
    counts = dict(line.split() for line in lines[1:])
    assert counts == {"artifacts": "0", "cmr_granules": "2", "raw_hotspots": "3"}

    assert cli.main(["info", "cmr_granules"]) == 0
    assert [line.split() for line in capsys.readouterr().out.splitlines()[1:]] == [["cmr_granules", "2"]]

    assert cli.main(["info", "nope"]) == 1
    assert "no such table: nope" in capsys.readouterr().err


# db.py has no test file of its own in P01's file list, so its tests live here.

def test_connect(db_file):
    assert db.db_path() == db_file
    con = db.connect()
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert con.execute("PRAGMA busy_timeout").fetchone()[0] == 300_000
    columns = [r[1] for r in con.execute("PRAGMA table_info(artifacts)")]
    assert columns == ["name", "json", "created_at"]


def test_default_db_path(monkeypatch):
    monkeypatch.delenv("HOTORNOT_DB", raising=False)
    assert db.db_path() == db.DEFAULT_DB
    assert db.DEFAULT_DB.parts[-3:] == ("pipeline", "data", "hotornot.sqlite")


def test_artifact_roundtrip(db_file):
    assert db.get_artifact("info:missing") is None
    db.put_artifact("info:report", {"rows": np.int64(5), "share": np.float64(0.25),
                                    "by_year": np.array([1, 2]), "until": date(2026, 11, 13)})
    assert db.get_artifact("info:report") == {"rows": 5, "share": 0.25, "by_year": [1, 2],
                                              "until": "2026-11-13"}
    db.put_artifact("info:report", [1])
    assert db.get_artifact("info:report") == [1]
    created_at = db.connect().execute("SELECT created_at FROM artifacts").fetchone()[0]
    assert created_at.endswith("+00:00")


@pytest.mark.parametrize("name", ["report", ":report", "info:", "info: report"])
def test_artifact_name_must_have_step_prefix(db_file, name):
    with pytest.raises(ValueError):
        db.put_artifact(name, 1)


def test_artifact_rejects_nan(db_file):
    with pytest.raises(ValueError):
        db.put_artifact("info:report", {"r": float("nan")})


def test_put_artifact_joins_open_transaction(db_file):
    con = db.connect()
    con.execute("BEGIN")
    db.put_artifact("info:a", 1, con=con)
    con.rollback()
    assert db.get_artifact("info:a") is None

    db.put_artifact("info:b", 2, con=con)
    assert not con.in_transaction
    assert db.get_artifact("info:b") == 2


DDL = """
-- CREATE TABLE decoy (a);
CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY, label TEXT);
CREATE INDEX things_label ON things(label);
/* second table */ CREATE TABLE "other things" (x);
"""


def test_recreate_rebuilds_tables(db_file):
    con = db.connect()
    con.execute("CREATE TABLE decoy (a)")
    con.execute("CREATE TABLE things (old)")
    con.execute("INSERT INTO things VALUES (1)")
    con.commit()

    with con:
        db.recreate(con, DDL)
        con.execute("INSERT INTO things(label) VALUES ('new')")
    assert con.execute("SELECT id, label FROM things").fetchall() == [(1, "new")]
    assert con.execute("SELECT COUNT(*) FROM \"other things\"").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM decoy").fetchone()[0] == 0
    names = {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
    assert {"things", "things_label", "other things", "decoy"} <= names

    with con:
        db.recreate(con, DDL)
    assert con.execute("SELECT COUNT(*) FROM things").fetchone()[0] == 0


def test_recreate_is_atomic(db_file):
    con = db.connect()
    con.execute("CREATE TABLE things (old)")
    con.execute("INSERT INTO things VALUES (1)")
    con.commit()

    with pytest.raises(RuntimeError), con:
        db.recreate(con, DDL)
        con.execute("INSERT INTO things(label) VALUES ('new')")
        raise RuntimeError("step failed")
    assert con.execute("SELECT * FROM things").fetchall() == [(1,)]
    assert db.connect().execute("SELECT * FROM things").fetchall() == [(1,)]
