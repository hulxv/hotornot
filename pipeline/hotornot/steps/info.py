"""Row counts of the tables in the pipeline database."""
import sys

from hotornot import db

NAME = "info"
HELP = "Print the database path and the row count of each table."


def add_arguments(parser):
    parser.add_argument("tables", nargs="*", help="only these tables (default: all)")


def run(args):
    path = db.db_path()
    con = db.connect(path)
    try:
        existing = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name")]
        missing = sorted(set(args.tables) - set(existing))
        if missing:
            print(f"no such table: {', '.join(missing)}", file=sys.stderr)
            return 1
        print(f"database: {path} ({path.stat().st_size / 1e9:.2f} GB)")
        for name in args.tables or existing:
            quoted = '"' + name.replace('"', '""') + '"'
            count = con.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
            print(f"  {name:<24} {count:>14,}")
    finally:
        con.close()
    return 0
