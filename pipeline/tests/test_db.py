import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

from hotornot import db


class TempDb(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "pipeline.sqlite"
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(self.path)})
        env.start()
        self.addCleanup(env.stop)

    def connect(self):
        con = db.connect()
        self.addCleanup(con.close)
        return con


class Connect(TempDb):
    def test_settings(self):
        self.assertEqual(db.db_path(), self.path)
        con = self.connect()
        self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.assertEqual(con.execute("PRAGMA busy_timeout").fetchone()[0], 300_000)
        columns = [r[1] for r in con.execute("PRAGMA table_info(artifacts)")]
        self.assertEqual(columns, ["name", "json", "created_at"])

    def test_default_path(self):
        with mock.patch.dict(os.environ, clear=True):
            self.assertEqual(db.db_path(), db.DEFAULT_DB)
        self.assertEqual(db.DEFAULT_DB.parts[-3:], ("pipeline", "data", "hotornot.sqlite"))


class Artifacts(TempDb):
    def test_round_trip(self):
        self.assertIsNone(db.get_artifact("info:missing"))
        db.put_artifact("info:report", {"rows": 5, "share": 0.25, "by_year": (1, 2),
                                        "until": date(2026, 11, 13), "note": None})
        self.assertEqual(db.get_artifact("info:report"),
                         {"rows": 5, "share": 0.25, "by_year": [1, 2], "until": "2026-11-13", "note": None})
        db.put_artifact("info:report", [1])
        self.assertEqual(db.get_artifact("info:report"), [1])
        created_at = self.connect().execute("SELECT created_at FROM artifacts").fetchone()[0]
        self.assertEqual(datetime.fromisoformat(created_at).utcoffset().total_seconds(), 0)

    def test_name_needs_step_prefix(self):
        for name in ("report", ":report", "info:", "info: report"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                db.put_artifact(name, 1)

    def test_rejects_values_json_cannot_hold(self):
        for value in (float("nan"), float("inf"), {1, 2}):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                db.put_artifact("info:report", {"r": value})

    def test_joins_an_open_transaction(self):
        con = self.connect()
        con.execute("BEGIN")
        db.put_artifact("info:a", 1, con=con)
        con.rollback()
        self.assertIsNone(db.get_artifact("info:a"))

        db.put_artifact("info:b", 2, con=con)
        self.assertFalse(con.in_transaction)
        self.assertEqual(db.get_artifact("info:b"), 2)


DDL = """
-- CREATE TABLE decoy (a);
CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY, label TEXT);
CREATE INDEX things_label ON things(label);
/* second table */ CREATE TABLE "other things" (x);
"""


class Recreate(TempDb):
    def setUp(self):
        super().setUp()
        self.con = self.connect()
        self.con.execute("CREATE TABLE decoy (a)")
        self.con.execute("CREATE TABLE things (old)")
        self.con.execute("INSERT INTO things VALUES (1)")
        self.con.commit()

    def test_rebuilds_tables(self):
        con = self.con
        with con:
            db.recreate(con, DDL)
            con.execute("INSERT INTO things(label) VALUES ('new')")
        self.assertEqual(con.execute("SELECT id, label FROM things").fetchall(), [(1, "new")])
        self.assertEqual(con.execute('SELECT COUNT(*) FROM "other things"').fetchone()[0], 0)
        names = {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
        self.assertLessEqual({"things", "things_label", "other things", "decoy"}, names)

        with con:
            db.recreate(con, DDL)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM things").fetchone()[0], 0)

    def test_is_atomic(self):
        con = self.con
        with self.assertRaises(RuntimeError), con:
            db.recreate(con, DDL)
            con.execute("INSERT INTO things(label) VALUES ('new')")
            raise RuntimeError("step failed")
        self.assertEqual(con.execute("SELECT * FROM things").fetchall(), [(1,)])
        self.assertEqual(self.connect().execute("SELECT * FROM things").fetchall(), [(1,)])
