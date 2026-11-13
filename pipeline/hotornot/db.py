"""The pipeline SQLite database ($HOTORNOT_DB) and the shared `artifacts` table."""
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path

from hotornot.config import DATA_DIR

DEFAULT_DB = DATA_DIR / "hotornot.sqlite"
BUSY_TIMEOUT_S = 300

ARTIFACTS_DDL = """
CREATE TABLE IF NOT EXISTS artifacts (
    name       TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    created_at TEXT NOT NULL
)"""

ARTIFACT_NAME = re.compile(r"[^:\s]+:\S+")
_CREATE_TABLE = re.compile(
    r"(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*"
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\"[^\"]+\"|\w+)",
    re.IGNORECASE | re.DOTALL,
)


def db_path():
    return Path(os.environ.get("HOTORNOT_DB") or DEFAULT_DB)


def connect(path=None):
    """Open the database in WAL mode with a 300 s busy timeout; ensures `artifacts` exists."""
    path = Path(path) if path is not None else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=BUSY_TIMEOUT_S)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    create_artifacts_table(con)
    return con


@contextmanager
def _using(con):
    if con is not None:
        yield con
        return
    own = connect()
    try:
        yield own
    finally:
        own.close()


def create_artifacts_table(con=None):
    if con is None:
        connect().close()
    else:
        con.execute(ARTIFACTS_DDL)


def _jsonable(obj):
    if hasattr(obj, "tolist"):  # numpy arrays and scalars
        return obj.tolist()
    if isinstance(obj, date):
        return obj.isoformat()
    raise TypeError(f"{type(obj).__name__} is not JSON serializable")


def put_artifact(name, obj, con=None):
    """Store `obj` as JSON under `name` ("<step>:<name>"), replacing any earlier value.

    NaN and infinity are rejected (the web app parses this JSON); use None. With `con` inside
    an open transaction the write joins that transaction; otherwise it is committed at once.
    """
    if not ARTIFACT_NAME.fullmatch(name):
        raise ValueError(f"artifact name {name!r} must look like '<step>:<name>'")
    text = json.dumps(obj, allow_nan=False, default=_jsonable, separators=(",", ":"))
    created_at = datetime.now(UTC).isoformat(timespec="seconds")
    with _using(con) as c:
        joined = c.in_transaction
        c.execute("INSERT OR REPLACE INTO artifacts(name, json, created_at) VALUES (?, ?, ?)",
                  (name, text, created_at))
        if not joined:
            c.commit()


def get_artifact(name, con=None):
    """The stored object, or None when there is no artifact with that name."""
    with _using(con) as c:
        row = c.execute("SELECT json FROM artifacts WHERE name = ?", (name,)).fetchone()
    return json.loads(row[0]) if row else None


def _statements(script):
    buf = ""
    for piece in script.split(";"):
        buf += piece + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip(" \t\r\n;"):
                yield buf
            buf = ""
    if buf.strip(" \t\r\n;"):
        yield buf


def recreate(con, ddl):
    """Drop every table that `ddl` creates, then run `ddl`.

    Begins a transaction when none is open and leaves it open, so
    `with con: recreate(con, DDL); con.executemany(...)` swaps the tables atomically.
    """
    if not con.in_transaction:
        con.execute("BEGIN")
    for stmt in _statements(ddl):
        m = _CREATE_TABLE.match(stmt)
        if m:
            con.execute(f"DROP TABLE IF EXISTS {m.group(1)}")
        con.execute(stmt)
