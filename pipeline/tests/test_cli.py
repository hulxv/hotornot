import importlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from hotornot import cli

STEP = """
NAME = "{name}"
HELP = "Say hello."


def add_arguments(parser):
    parser.add_argument("--times", type=int, default=1)


def run(args):
    print(" ".join(["hello"] * args.times))
    return args.times
"""


def run_main(argv, package="hotornot.steps"):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = cli.main(argv, package=package)
        except SystemExit as e:
            code = e.code
    return code, out.getvalue(), err.getvalue()


class Discovery(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.pkg = Path(tmp.name) / "fake_steps"
        self.pkg.mkdir()
        (self.pkg / "__init__.py").write_text("")
        sys.path.insert(0, tmp.name)
        importlib.invalidate_caches()
        self.addCleanup(sys.path.remove, tmp.name)
        self.addCleanup(self.forget_package)

    @staticmethod
    def forget_package():
        for name in [m for m in sys.modules if m == "fake_steps" or m.startswith("fake_steps.")]:
            del sys.modules[name]

    def test_info_is_discovered(self):
        steps = cli.discover_steps()
        self.assertIn("info", steps)
        self.assertTrue(steps["info"].HELP)

    def test_new_step_needs_no_cli_change(self):
        (self.pkg / "hello.py").write_text(STEP.format(name="hello"))
        (self.pkg / "_private.py").write_text(STEP.format(name="private"))
        (self.pkg / "helper.py").write_text("VALUE = 1\n")
        (self.pkg / "broken.py").write_text("raise ImportError('missing dependency')\n")

        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(list(cli.discover_steps("fake_steps")), ["hello"])
        self.assertIn("skipping fake_steps.broken", err.getvalue())

        code, out, _ = run_main(["hello", "--times", "3"], package="fake_steps")
        self.assertEqual(code, 3)
        self.assertEqual(out, "hello hello hello\n")

    def test_duplicate_step_names_fail(self):
        (self.pkg / "a.py").write_text(STEP.format(name="hello"))
        (self.pkg / "b.py").write_text(STEP.format(name="hello"))
        with self.assertRaisesRegex(RuntimeError, "'hello'"):
            cli.discover_steps("fake_steps")


class Parser(unittest.TestCase):
    def test_help_lists_steps(self):
        code, out, _ = run_main(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("info", out)
        self.assertIn("row count", out)

    def test_step_is_required(self):
        code, _, err = run_main([])
        self.assertEqual(code, 2)
        self.assertIn("STEP", err)


class Info(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "pipeline.sqlite"
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(self.path)})
        env.start()
        self.addCleanup(env.stop)
        con = sqlite3.connect(self.path)
        con.execute("CREATE TABLE raw_hotspots (a)")
        con.executemany("INSERT INTO raw_hotspots VALUES (?)", [(1,), (2,), (3,)])
        con.execute("CREATE TABLE cmr_granules (a)")
        con.executemany("INSERT INTO cmr_granules VALUES (?)", [(1,), (2,)])
        con.commit()
        con.close()

    def test_counts_every_table(self):
        code, out, _ = run_main(["info"])
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertIn(str(self.path), lines[0])
        counts = dict(line.split() for line in lines[1:])
        self.assertEqual(counts, {"artifacts": "0", "cmr_granules": "2", "raw_hotspots": "3"})

    def test_named_tables_only(self):
        code, out, _ = run_main(["info", "cmr_granules"])
        self.assertEqual(code, 0)
        self.assertEqual([line.split() for line in out.splitlines()[1:]], [["cmr_granules", "2"]])

    def test_unknown_table(self):
        code, _, err = run_main(["info", "nope"])
        self.assertEqual(code, 1)
        self.assertIn("no such table: nope", err)
