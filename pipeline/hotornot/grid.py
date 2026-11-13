"""The global grid from CONTRACTS. web/lib/grid.ts implements the same formulas; both must
pass shared/grid_vectors.json."""
import math

from hotornot.config import GRID_DEG

CELLS_PER_DEG = round(1 / GRID_DEG)
ROWS = 180 * CELLS_PER_DEG
COLS = 360 * CELLS_PER_DEG


def cell_of(lat, lon):
    """(row, col, cell_id) of the cell containing the point."""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"point out of range: lat={lat}, lon={lon}")
    # round(.., 6) absorbs float error so that points on a grid line fall in the cell above it.
    row = min(math.floor(round((lat + 90) * CELLS_PER_DEG, 6)), ROWS - 1)
    col = min(math.floor(round((lon + 180) * CELLS_PER_DEG, 6)), COLS - 1)
    return row, col, row * COLS + col


def tile_of(cell_id):
    """1-degree tile named after its south-west corner, e.g. "n30e031"."""
    row, col = divmod(cell_id, COLS)
    lat0 = row // CELLS_PER_DEG - 90
    lon0 = col // CELLS_PER_DEG - 180
    return f"{'n' if lat0 >= 0 else 's'}{abs(lat0):02d}{'e' if lon0 >= 0 else 'w'}{abs(lon0):03d}"


def center(cell_id):
    """(lon, lat) of the cell center."""
    row, col = divmod(cell_id, COLS)
    return (col + 0.5) / CELLS_PER_DEG - 180, (row + 0.5) / CELLS_PER_DEG - 90


def _indices(lo, hi, offset, n):
    first = max(math.floor((lo + offset) * CELLS_PER_DEG - 0.5), 0)
    last = min(math.ceil((hi + offset) * CELLS_PER_DEG - 0.5), n - 1)
    return [i for i in range(first, last + 1) if lo <= (i + 0.5) / CELLS_PER_DEG - offset <= hi]


def cells_in_bbox(bbox):
    """Sorted cell ids whose center lies inside [west, south, east, north], edges included."""
    west, south, east, north = bbox
    if west > east or south > north:
        raise ValueError(f"bbox must be [west, south, east, north], got {list(bbox)}")
    rows = _indices(south, north, 90, ROWS)
    cols = _indices(west, east, 180, COLS)
    return [r * COLS + c for r in rows for c in cols]
