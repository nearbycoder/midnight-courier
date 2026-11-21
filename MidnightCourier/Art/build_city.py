"""Generates the neighbourhood of Lantern Hill: streets, stairs, alley, canal, harbour, buildings, signs,
lights and the gameplay data (start, checkpoints, autopilot routes, minimap).

Run: Blender -b --factory-startup --python Art/build_city.py
Writes Art/Export/SM_City_*.fbx (chunked geometry) and Art/Export/level.json (Unreal coordinates, cm).

Blender space: metres, X east, Y north, Z up. Unreal: (x, -y, z) * 100.
"""
import math
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector, Matrix
from mc import kit

FONT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Content", "Courier", "Fonts", "Anton-Regular.ttf")
rnd = random.Random(1987)

ROAD_HW = 4.5        # road half width
WALK = 3.5           # sidewalk width
CURB = 0.15


def ue(p):
    return [round(p[0] * 100, 1), round(-p[1] * 100, 1), round(p[2] * 100, 1)]


def ue_yaw(dx, dy):
    return round(math.degrees(math.atan2(-dy, dx)), 2)


# =========================================================================================================
# Paths
# =========================================================================================================
class Path:
    """A centreline made of straight and arc commands, sampled every metre, with heights."""

    def __init__(self, x, y, heading_deg, z):
        self.pts = [Vector((x, y, z))]
        self.head = math.radians(heading_deg)
        self.marks = {}

    def line(self, length, z1, mark=None):
        p0 = self.pts[-1]
        n = max(1, int(round(length)))
        d = Vector((math.cos(self.head), math.sin(self.head), 0))
        for i in range(1, n + 1):
            t = i / n
            p = p0 + d * (length * t)
            p.z = p0.z + (z1 - p0.z) * t
            self.pts.append(p)
        if mark:
            self.marks[mark] = len(self.pts) - 1
        return self

    def arc(self, radius, angle_deg, z1, mark=None):
        """Positive angle = left turn."""
        p0 = self.pts[-1]
        sgn = 1 if angle_deg > 0 else -1
        left = Vector((-math.sin(self.head), math.cos(self.head), 0))
        c = p0 + left * radius * sgn
        a0 = math.atan2(p0.y - c.y, p0.x - c.x)
        total = math.radians(abs(angle_deg)) * sgn
        n = max(2, int(round(abs(total) * radius)))
        for i in range(1, n + 1):
            t = i / n
            a = a0 + total * t
            p = Vector((c.x + math.cos(a) * radius, c.y + math.sin(a) * radius, p0.z + (z1 - p0.z) * t))
            self.pts.append(p)
        self.head += total
        if mark:
            self.marks[mark] = len(self.pts) - 1
        return self

    def smooth_z(self, window=9, passes=3):
        z = np.array([p.z for p in self.pts])
        k = np.ones(window) / window
        for _ in range(passes):
            pad = np.pad(z, (window // 2, window // 2), mode="edge")
            z = np.convolve(pad, k, mode="valid")
        for p, v in zip(self.pts, z):
            p.z = float(v)

    def frames(self):
        """Per-sample (position, tangent, left normal)."""
        out = []
        n = len(self.pts)
        for i, p in enumerate(self.pts):
            a = self.pts[max(0, i - 1)]
            b = self.pts[min(n - 1, i + 1)]
            t = Vector((b.x - a.x, b.y - a.y, 0)).normalized()
            out.append((p, t, Vector((-t.y, t.x, 0))))
        return out

    def length_at(self, i):
        return sum((self.pts[k + 1].xy - self.pts[k].xy).length for k in range(i))


# =========================================================================================================
# Occupancy (what's road / water / building) and street heights on a 0.5 m grid
# =========================================================================================================
X0, X1, Y0, Y1 = -320.0, 280.0, -700.0, 140.0
RES = 0.5
NX, NY = int((X1 - X0) / RES), int((Y1 - Y0) / RES)
occ = np.zeros((NY, NX), dtype=np.uint8)          # 0 free, 1 corridor, 2 building
street_z = np.full((NY, NX), np.nan, dtype=np.float32)


def cell(x, y):
    return int((y - Y0) / RES), int((x - X0) / RES)


def paint_disc(x, y, r, z=None, value=1):
    i0, j0 = cell(x - r, y - r)
    i1, j1 = cell(x + r, y + r)
    i0, j0 = max(i0, 0), max(j0, 0)
    i1, j1 = min(i1 + 1, NY), min(j1 + 1, NX)
    if i0 >= i1 or j0 >= j1:
        return
    ys = Y0 + (np.arange(i0, i1) + 0.5) * RES
    xs = X0 + (np.arange(j0, j1) + 0.5) * RES
    XX, YY = np.meshgrid(xs, ys)
    m = (XX - x) ** 2 + (YY - y) ** 2 <= r * r
    sub = occ[i0:i1, j0:j1]
    sub[m] = np.maximum(sub[m], value)
    if z is not None:
        zs = street_z[i0:i1, j0:j1]
        zs[m] = np.where(np.isnan(zs[m]), z, np.minimum(zs[m], z))


def paint_poly(poly, z=None, value=1):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    i0, j0 = cell(min(xs), min(ys))
    i1, j1 = cell(max(xs), max(ys))
    i0, j0 = max(i0, 0), max(j0, 0)
    i1, j1 = min(i1 + 1, NY), min(j1 + 1, NX)
    yy = Y0 + (np.arange(i0, i1) + 0.5) * RES
    xx = X0 + (np.arange(j0, j1) + 0.5) * RES
    XX, YY = np.meshgrid(xx, yy)
    inside = np.zeros(XX.shape, dtype=bool)
    n = len(poly)
    for k in range(n):
        xa, ya = poly[k]
        xb, yb = poly[(k + 1) % n]
        cond = ((ya > YY) != (yb > YY)) & (XX < (xb - xa) * (YY - ya) / (yb - ya + 1e-12) + xa)
        inside ^= cond
    sub = occ[i0:i1, j0:j1]
    sub[inside] = np.maximum(sub[inside], value)
    if z is not None:
        zs = street_z[i0:i1, j0:j1]
        zs[inside] = np.where(np.isnan(zs[inside]), z, np.minimum(zs[inside], z))
    return inside


def poly_free(poly, margin_value=1):
    """True when no cell under the polygon is already occupied."""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    i0, j0 = cell(min(xs), min(ys))
    i1, j1 = cell(max(xs), max(ys))
    if i0 < 0 or j0 < 0 or i1 >= NY or j1 >= NX:
        return False
    yy = Y0 + (np.arange(i0, i1 + 1) + 0.5) * RES
    xx = X0 + (np.arange(j0, j1 + 1) + 0.5) * RES
    XX, YY = np.meshgrid(xx, yy)
    inside = np.zeros(XX.shape, dtype=bool)
    n = len(poly)
    for k in range(n):
        xa, ya = poly[k]
        xb, yb = poly[(k + 1) % n]
        cond = ((ya > YY) != (yb > YY)) & (XX < (xb - xa) * (YY - ya) / (yb - ya + 1e-12) + xa)
        inside ^= cond
    return not np.any(occ[i0:i1 + 1, j0:j1 + 1][inside] >= margin_value)


def ground_near(x, y, radius=30.0):
    """Lowest street height near a point (for building bases)."""
    i0, j0 = cell(x - radius, y - radius)
    i1, j1 = cell(x + radius, y + radius)
    i0, j0, i1, j1 = max(i0, 0), max(j0, 0), min(i1, NY - 1), min(j1, NX - 1)
    win = street_z[i0:i1 + 1, j0:j1 + 1]
    if np.all(np.isnan(win)):
        return None
    return float(np.nanmin(win))


def street_at(x, y, radius=12.0):
    i0, j0 = cell(x - radius, y - radius)
    i1, j1 = cell(x + radius, y + radius)
    i0, j0, i1, j1 = max(i0, 0), max(j0, 0), min(i1, NY - 1), min(j1, NX - 1)
    win = street_z[i0:i1 + 1, j0:j1 + 1]
    if np.all(np.isnan(win)):
        return None
    # nearest painted cell
    idx = np.argwhere(~np.isnan(win))
    ci, cj = cell(x, y)
    d = (idx[:, 0] + i0 - ci) ** 2 + (idx[:, 1] + j0 - cj) ** 2
    k = idx[np.argmin(d)]
    return float(win[k[0], k[1]])


# =========================================================================================================
# Chunked output
# =========================================================================================================
CHUNK = 100.0
chunks = {}       # (cx, cy, kind) -> MeshBuilder ; kind "s" solid (collision) or "d" deco (no collision)


def chunk_for(x, y, kind="s"):
    key = (int(math.floor(x / CHUNK)), int(math.floor(y / CHUNK)), kind)
    if key not in chunks:
        chunks[key] = kit.MeshBuilder(f"SM_City_{'S' if kind == 's' else 'D'}_{key[0] + 5}_{key[1] + 10}")
    return chunks[key]


lights = []
props_text = []


def add_light(kind, pos, color, intensity, radius, shadow=False, rot=None, cone=None, size=None, fog=1.0, source=None):
    L = {"kind": kind, "pos": ue(pos), "color": [round(c, 3) for c in color], "intensity": intensity, "radius": radius, "shadow": shadow, "fog": fog}
    if rot is not None:
        L["rot"] = rot
    if cone is not None:
        L["cone"] = cone
    if size is not None:
        L["size"] = size
    if source is not None:
        L["source"] = source
    lights.append(L)


# =========================================================================================================
# Streets
# =========================================================================================================
def build_street(path, hw=ROAD_HW, walk=WALK, gaps=(), paint=True, name="street", markings=True, skirt=4.0):
    """Road + kerbs + sidewalks + side skirts for a path. gaps: list of (i0, i1, side) where side -1 right,
    +1 left, in sample indices: no kerb or sidewalk there (the road meets a plaza at road level)."""
    fr = path.frames()
    n = len(fr)

    def gapped(i, side):
        for a, b, s in gaps:
            if s == side and a <= i <= b:
                return True
        return False

    for i in range(n - 1):
        p0, t0, l0 = fr[i]
        p1, t1, l1 = fr[i + 1]
        mid = (p0 + p1) * 0.5
        B = chunk_for(mid.x, mid.y)
        UP = (0, 0, 1)
        # road
        a = p0 + l0 * hw
        b = p0 - l0 * hw
        c = p1 - l1 * hw
        d = p1 + l1 * hw
        B.poly_facing([b, c, d, a], UP, "M_Road")
        for side in (1, -1):
            e0 = p0 + l0 * hw * side
            e1 = p1 + l1 * hw * side
            o0 = p0 + l0 * (hw + walk) * side
            o1 = p1 + l1 * (hw + walk) * side
            up = Vector((0, 0, CURB))
            toward_road = -(l0 * side)
            outward = l0 * side
            if gapped(i, side):
                # flush sidewalk: no kerb, level with the road, so plazas and alleys open straight onto it
                B.poly_facing([e0, e1, o1, o0], UP, "M_Cobble")
                B.poly_facing([o0, o1, o1 - Vector((0, 0, skirt)), o0 - Vector((0, 0, skirt))], outward, "M_Concrete")
                continue
            # kerb face (toward the road), kerb top, sidewalk, outer skirt
            B.poly_facing([e0, e1, e1 + up, e0 + up], toward_road, "M_Curb")
            k0 = p0 + l0 * (hw + 0.25) * side + up
            k1 = p1 + l1 * (hw + 0.25) * side + up
            B.poly_facing([e0 + up, e1 + up, k1, k0], UP, "M_Curb")
            B.poly_facing([k0, k1, o1 + up, o0 + up], UP, "M_Sidewalk")
            B.poly_facing([o0 + up, o1 + up, o1 - Vector((0, 0, skirt)), o0 - Vector((0, 0, skirt))], outward, "M_Concrete")
    # markings (deco)
    if markings:
        s = 0.0
        for i in range(n - 1):
            p0, t0, l0 = fr[i]
            p1, t1, l1 = fr[i + 1]
            seg = (p1.xy - p0.xy).length
            on = (s % 6.0) < 3.0
            s += seg
            D = chunk_for(p0.x, p0.y, "d")
            lift = Vector((0, 0, 0.012))
            if on:
                for off in (-0.08, 0.08):
                    q = [p0 + l0 * (off - 0.05) + lift, p1 + l1 * (off - 0.05) + lift, p1 + l1 * (off + 0.05) + lift, p0 + l0 * (off + 0.05) + lift]
                    D.poly_facing(q, (0, 0, 1), "M_Paint", (0.85, 0.6, 0.1, 1))
            for side in (1, -1):
                o = hw - 0.35
                q = [p0 + l0 * (o - 0.06) * side + lift, p1 + l1 * (o - 0.06) * side + lift, p1 + l1 * (o + 0.06) * side + lift, p0 + l0 * (o + 0.06) * side + lift]
                D.poly_facing(q, (0, 0, 1), "M_Paint", (0.75, 0.75, 0.72, 1))
    # occupancy + heights
    for p, t, l in fr:
        paint_disc(p.x, p.y, hw + walk + 0.2, p.z)


def street_point(path, i):
    return path.pts[max(0, min(len(path.pts) - 1, i))]


def nearest_index(path, x, y):
    best, bi = 1e18, 0
    for i, p in enumerate(path.pts):
        d = (p.x - x) ** 2 + (p.y - y) ** 2
        if d < best:
            best, bi = d, i
    return bi


# =========================================================================================================
# The main route
# =========================================================================================================
main = Path(0.0, 52.0, -90.0, 66.3)
main.line(28, 66.0, "start_flat")
main.line(164, 55.0, "crown_end")               # Crown Street
main.arc(15, 90, 54.2, "c1")                    # corner into Kiln Road
main.line(80, 51.0, "kiln_upper")
main.arc(25, -180, 47.0, "hairpin")
main.line(80, 43.2, "kiln_lower")
main.arc(15, 90, 42.4, "c2")
main.line(80, 37.0, "market_end")               # Market Street
main.arc(12, -90, 36.6, "c3")
main.line(86, 33.0, "tanner_end")               # Tanner Row
main.arc(12, 90, 32.5, "c4")
main.line(126, 17.6, "lamp_end")                # Lamp Hill
main.arc(12, 90, 17.4, "c5")
main.line(51, 17.2, "canal_end")                # Canal Walk
main.arc(12, -90, 17.3, "c6")
main.line(12, 17.3, "bridge_end")               # Gull Bridge
main.arc(12, -90, 17.0, "c7")
main.line(51, 16.4, "quay_end")                 # Quay Road
main.arc(12, 90, 16.0, "c8")
main.line(74, 3.0, "pier_end")                  # Pier Lane
main.line(10, 2.6, "end")
main.smooth_z(9, 3)

# Sidewalk gaps where plazas meet the road at road level (indices found by position).
def gap_near(x, y, span, side):
    i = nearest_index(main, x, y)
    return (i - span, i + span, side)

GAPS = [
    gap_near(-110.0, -462.0, 14, -1),  # outside of the Lamp Hill bottom corner (kicker plaza)
    gap_near(-110.0, -498.0, 14, -1),  # outside of the Quay Road corner (landing plaza)
    gap_near(-1.5, -313.0, 3, -1),     # alley mouth outside the Market corner
]
build_street(main, gaps=GAPS)

ZQ_N = street_at(-110.0, -458.0)        # road height at the kicker plaza
ZQ_S = street_at(-110.0, -500.0)        # road height at the landing plaza

# =========================================================================================================
# Lantern Steps (four flights between the two Kiln Road corners)
# =========================================================================================================
STAIR_X = 2.0
STAIR_HW = 2.6


def build_stairs():
    y_top, y_bot = -153.5, -206.0
    z_top = street_at(STAIR_X, -150.0) + CURB
    z_bot = street_at(STAIR_X, -210.0) + CURB
    flights = 4
    drop = z_top - z_bot
    steps = 17
    rise = drop / (flights * steps)
    run = 0.30
    flight_len = steps * run
    total = y_top - y_bot
    apron_top = 4.0
    landing = (total - apron_top - flights * flight_len - 3.0) / (flights - 1)
    y = y_top
    z = z_top
    segs = []   # (y0, y1, z) flats and stairs
    B = None
    x0, x1 = STAIR_X - STAIR_HW, STAIR_X + STAIR_HW

    def slab(ya, yb, zt):
        B = chunk_for(STAIR_X, (ya + yb) / 2)
        B.box((STAIR_X, (ya + yb) / 2, zt - 2.0), (STAIR_HW * 2, abs(ya - yb), 4.0), "M_Stairs", faces=("+z", "-y", "+y"))

    slab(y, y - apron_top - 0.2, z)
    y -= apron_top
    route = [(STAIR_X, y_top + 2.0, z_top)]
    for f in range(flights):
        for s in range(steps):
            zt = z - rise * (s + 1)
            ya = y - run * s
            yb = ya - run
            Bc = chunk_for(STAIR_X, ya)
            Bc.box((STAIR_X, (ya + yb) / 2, zt - 0.6), (STAIR_HW * 2, run + 0.002, 1.2), "M_Stairs", faces=("+z", "+y"))
            # nosing strip (pale) at each step edge
            Bc.box((STAIR_X, ya - 0.025, zt + 0.004), (STAIR_HW * 2, 0.05, 0.008), "M_Paint", (0.7, 0.68, 0.6, 1), faces=("+z",))
        y -= flight_len
        z -= rise * steps
        route.append((STAIR_X, y, z))
        L = landing if f < flights - 1 else 3.0
        slab(y, y - L - 0.2, z)
        if f < flights - 1:
            route.append((STAIR_X, y - L * 0.5, z))
        y -= L
    # parapet walls: follow the stair profile, a metre above it, with a rail on top
    prof_y = [y_top]
    prof_z = [z_top]
    yy, zz = y_top - apron_top, z_top
    prof_y.append(yy); prof_z.append(zz)
    for f in range(flights):
        yy -= flight_len; zz -= rise * steps
        prof_y.append(yy); prof_z.append(zz)
        L = landing if f < flights - 1 else 3.0
        yy -= L
        prof_y.append(yy); prof_z.append(zz)
    for side in (-1, 1):
        xw = STAIR_X + side * (STAIR_HW + 0.2)
        for k in range(len(prof_y) - 1):
            ya, yb = prof_y[k], prof_y[k + 1]
            za, zb = prof_z[k] + 1.0, prof_z[k + 1] + 1.0
            Bc = chunk_for(xw, ya)
            inner = xw - side * 0.2
            outer = xw + side * 0.2
            bot = min(za, zb) - 6.0
            Bc.poly_facing([(inner, ya, bot), (inner, yb, bot), (inner, yb, zb), (inner, ya, za)], (-side, 0, 0), "M_Concrete")
            Bc.poly_facing([(outer, ya, bot), (outer, yb, bot), (outer, yb, zb), (outer, ya, za)], (side, 0, 0), "M_Concrete")
            Bc.poly_facing([(inner, ya, za), (inner, yb, zb), (outer, yb, zb), (outer, ya, za)], (0, 0, 1), "M_Concrete")
            Bc.cylinder((inner + side * 0.05, ya, za + 0.1), (inner + side * 0.05, yb, zb + 0.1), 0.035, "M_VCMetal", (0.5, 0.42, 0.2, 0.25), seg=6)
    for k, (rx, ry, rz) in enumerate(route[1:-1]):
        for side in (-1, 1):
            lamp_post(STAIR_X + side * (STAIR_HW - 0.2), ry, rz, 0.0 if side < 0 else 180.0, 3.6, warm=True, shadow=(k % 2 == 0 and side < 0), arm=0.5, power=0.3)
    # strings of lanterns across the steps
    for k in range(7):
        yy = y_top - 3 - k * 7.0
        zz = np.interp(-yy, [-y_top, -y_bot], [z_top, z_bot]) + 4.6
        lantern_string(Vector((STAIR_X - 4.0, yy, zz)), Vector((STAIR_X + 4.0, yy - 1.0, zz + 0.3)), 0.5, 9, palette=[(1.0, 0.3, 0.1), (1.0, 0.6, 0.15)])
    for yy in np.arange(y_top, y_bot, -0.5):
        zz = float(np.interp(-yy, [-p for p in prof_y], prof_z))
        paint_disc(STAIR_X, yy, STAIR_HW + 0.5, zz)
    return route, (z_top, z_bot)


# =========================================================================================================
# Street furniture
# =========================================================================================================
def lamp_post(x, y, z, yaw_deg, height=6.0, warm=True, shadow=False, arm=1.4, power=1.0):
    B = chunk_for(x, y)
    D = chunk_for(x, y, "d")
    B.cylinder((x, y, z - 0.2), (x, y, z + height), 0.07, "M_VCMetal", (0.08, 0.085, 0.09, 0.45), r1=0.05, seg=8)
    B.cylinder((x, y, z), (x, y, z + 0.5), 0.12, "M_VCMetal", (0.08, 0.085, 0.09, 0.45), seg=8)
    yaw = math.radians(yaw_deg)
    d = Vector((math.cos(yaw), math.sin(yaw), 0))
    top = Vector((x, y, z + height))
    head = top + d * arm
    D.cylinder(top, head + Vector((0, 0, 0.1)), 0.04, "M_VCMetal", (0.08, 0.085, 0.09, 0.45), seg=6)
    D.box(head + Vector((0, 0, 0.0)), (0.55, 0.3, 0.16), "M_VCMetal", (0.07, 0.07, 0.075, 0.4), rot=Matrix.Rotation(yaw, 3, 'Z'))
    col = (1.0, 0.62, 0.3) if warm else (0.75, 0.85, 1.0)
    D.box(head + Vector((0, 0, -0.09)), (0.45, 0.22, 0.03), "M_Lamp", (col[0], col[1], col[2], 1), rot=Matrix.Rotation(yaw, 3, 'Z'))
    add_light("spot", head + Vector((0, 0, -0.15)), col, (1800.0 if warm else 1500.0) * power, 1700.0, shadow=shadow,
              rot=[-90.0, 0.0, 0.0], cone=[28.0, 62.0], fog=1.6)


CAR_PAINT = [(0.55, 0.05, 0.05, 0.25), (0.06, 0.1, 0.2, 0.25), (0.75, 0.75, 0.72, 0.25), (0.05, 0.05, 0.05, 0.25), (0.1, 0.3, 0.25, 0.25), (0.8, 0.6, 0.1, 0.25)]


def parked_car(p, yaw, z):
    """A small hatchback. Solid (you can hit it)."""
    B = chunk_for(p.x, p.y)
    D = chunk_for(p.x, p.y, "d")
    R = Matrix.Rotation(yaw, 3, 'Z')
    f = Vector((math.cos(yaw), math.sin(yaw), 0))
    sd = Vector((-f.y, f.x, 0))
    col = rnd.choice(CAR_PAINT)
    c = Vector((p.x, p.y, z))
    B.box(c + Vector((0, 0, 0.55)), (3.9, 1.75, 0.6), "M_VCMetal", col, rot=R)
    B.box(c + f * 0.35 + Vector((0, 0, 0.42)), (4.0, 1.72, 0.35), "M_VCMetal", col, rot=R)
    B.box(c - f * 0.25 + Vector((0, 0, 1.08)), (2.2, 1.55, 0.5), "M_VCMetal", (0.02, 0.025, 0.03, 0.03), rot=R)
    B.box(c - f * 0.25 + Vector((0, 0, 1.35)), (2.0, 1.5, 0.06), "M_VCMetal", col, rot=R)
    for sx in (-1, 1):
        for sy in (-1, 1):
            w = c + f * (1.25 * sx) + sd * (0.82 * sy) + Vector((0, 0, 0.32))
            B.cylinder(w - sd * 0.12, w + sd * 0.12, 0.32, "M_VC", (0.03, 0.03, 0.03, 0.8), seg=12)
    for sy in (-1, 1):
        D.box(c + f * 2.0 + sd * (0.62 * sy) + Vector((0, 0, 0.65)), (0.05, 0.3, 0.12), "M_Glow", (0.9, 0.85, 0.7, 1), rot=R)
        D.box(c - f * 1.96 + sd * (0.65 * sy) + Vector((0, 0, 0.7)), (0.05, 0.25, 0.14), "M_Glow", (0.6, 0.02, 0.02, 1), rot=R)
    paint_disc(p.x, p.y, 2.0, None, 1)


def street_tree(p, z):
    B = chunk_for(p.x, p.y)
    D = chunk_for(p.x, p.y, "d")
    B.box((p.x, p.y, z + 0.25), (1.1, 1.1, 0.5), "M_Concrete")
    B.cylinder((p.x, p.y, z), (p.x, p.y, z + 2.8), 0.1, "M_Wood", r1=0.07, seg=8)
    rr = random.Random(int(abs(p.x) * 13 + abs(p.y) * 7))
    for k in range(7):
        o = Vector((rr.uniform(-1, 1), rr.uniform(-1, 1), rr.uniform(0, 1.2)))
        D.sphere((p.x + o.x, p.y + o.y, z + 3.2 + o.z), rr.uniform(0.8, 1.2), "M_VC", (0.06 + rr.random() * 0.04, 0.13 + rr.random() * 0.06, 0.06, 0.75), seg=10, rings=6)


def street_clutter(p, side_dir, z):
    """Bins, hydrants, bollards, newspaper boxes on the sidewalk."""
    B = chunk_for(p.x, p.y)
    k = rnd.random()
    if k < 0.3:
        B.cylinder((p.x, p.y, z), (p.x, p.y, z + 0.95), 0.28, "M_VCMetal", (0.1, 0.22, 0.12, 0.5), seg=12)
        B.cylinder((p.x, p.y, z + 0.95), (p.x, p.y, z + 1.0), 0.3, "M_VCMetal", (0.06, 0.06, 0.06, 0.5), seg=12)
    elif k < 0.5:
        B.cylinder((p.x, p.y, z), (p.x, p.y, z + 0.6), 0.13, "M_VCMetal", (0.7, 0.08, 0.05, 0.4), seg=10)
        B.sphere((p.x, p.y, z + 0.62), 0.13, "M_VCMetal", (0.7, 0.08, 0.05, 0.4), seg=10, rings=5, zmin=0.0)
        B.cylinder((p.x - 0.18, p.y, z + 0.4), (p.x + 0.18, p.y, z + 0.4), 0.05, "M_VCMetal", (0.7, 0.08, 0.05, 0.4), seg=6)
    elif k < 0.75:
        for q in range(3):
            o = side_dir * (q * 1.2)
            B.cylinder((p.x + o.x, p.y + o.y, z), (p.x + o.x, p.y + o.y, z + 0.9), 0.09, "M_VCMetal", (0.08, 0.08, 0.09, 0.4), seg=8)
            B.box((p.x + o.x, p.y + o.y, z + 0.75), (0.2, 0.2, 0.05), "M_Glow", (0.8, 0.6, 0.2, 1))
    else:
        B.box((p.x, p.y, z + 0.55), (0.5, 0.45, 1.1), "M_VCMetal", rnd.choice([(0.1, 0.25, 0.6, 0.4), (0.7, 0.1, 0.1, 0.4), (0.8, 0.7, 0.1, 0.4)]))
        chunk_for(p.x, p.y, "d").box((p.x, p.y, z + 0.85), (0.52, 0.47, 0.25), "M_Shop", (0.8, 0.85, 0.9, 1))


def overhead_cable(a, b, sag):
    D = chunk_for((a.x + b.x) / 2, (a.y + b.y) / 2, "d")
    prev = None
    for k in range(11):
        tt = k / 10
        q = a.lerp(b, tt)
        q.z -= sag * 4 * tt * (1 - tt)
        if prev is not None:
            D.cylinder(prev, q, 0.012, "M_VC", (0.01, 0.01, 0.01, 0.8), seg=4, caps=False)
        prev = q


def lantern_string(a, b, sag, count, palette, light=True):
    D = chunk_for((a.x + b.x) / 2, (a.y + b.y) / 2, "d")
    prev = None
    for k in range(count + 1):
        t = k / count
        p = a.lerp(b, t)
        p.z -= sag * 4 * t * (1 - t)
        if prev is not None:
            D.cylinder(prev, p, 0.008, "M_VC", (0.02, 0.02, 0.02, 0.8), seg=4, caps=False)
        if 0 < k < count:
            c = palette[k % len(palette)]
            D.sphere(p - Vector((0, 0, 0.12)), 0.09, "M_Lamp", (c[0] * 0.18, c[1] * 0.18, c[2] * 0.18, 1), seg=8, rings=5, scale=(1, 1, 1.3))
        prev = p
    if light:
        m = a.lerp(b, 0.5)
        m.z -= sag + 0.3
        c = palette[0]
        add_light("point", m, c, 35.0, 650.0, fog=0.8, source=40.0)


WORDS = ["NOODLES", "RAMEN", "BAR", "KARAOKE", "PHARMACY", "24H", "LAUNDRY", "CAFE", "DUMPLINGS", "TATTOO", "PAWN",
         "LIQUOR", "ARCADE", "BOOKS", "RECORDS", "PHO", "SUSHI", "PIZZA", "MOTEL", "CINEMA", "DINER", "OPEN", "REPAIR",
         "TAXI", "JAZZ", "LUCKY", "GOLD", "TEA", "BBQ", "NAILS", "DELI", "VIDEO", "POOL", "BAKERY", "FLOWERS"]
NEON = [(1.0, 0.12, 0.5), (0.1, 0.85, 1.0), (1.0, 0.5, 0.08), (0.25, 1.0, 0.4), (1.0, 0.12, 0.08), (0.65, 0.25, 1.0), (0.85, 0.9, 1.0)]


def neon_sign(base, normal, z_street, word=None, color=None, vertical=None, height=None):
    """A sign on a facade. base = point on the wall (xy), normal = outward unit vector."""
    word = word or rnd.choice(WORDS)
    color = color or rnd.choice(NEON)
    vertical = (rnd.random() < 0.45) if vertical is None else vertical
    yaw = math.atan2(normal.y, normal.x)
    D = chunk_for(base.x, base.y, "d")
    board = (0.04, 0.04, 0.045, 0.6)
    if vertical and len(word) <= 8:
        h = len(word) * 0.62 + 0.4
        z0 = z_street + (height or rnd.uniform(4.0, 6.0))
        out = base + normal * 0.8
        R = Matrix.Rotation(yaw, 3, 'Z')
        D.box(out + Vector((0, 0, z0 + h / 2)), (1.2, 0.16, h), "M_VCMetal", board, rot=R)
        D.cylinder(base + Vector((0, 0, z0 + h - 0.2)), out + Vector((0, 0, z0 + h - 0.2)), 0.03, "M_VCMetal", board, seg=6)
        D.cylinder(base + Vector((0, 0, z0 + 0.2)), out + Vector((0, 0, z0 + 0.2)), 0.03, "M_VCMetal", board, seg=6)
        tang = Vector((-normal.y, normal.x, 0))
        for side in (-1, 1):
            for k, ch in enumerate(word):
                p = out + tang * (0.085 * side) + Vector((0, 0, z0 + h - 0.5 - k * 0.62))
                M = Matrix.Translation(p) @ Matrix.Rotation(yaw + (math.pi if side > 0 else 0.0), 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
                kit.add_text(D, ch, 0.55, 0.02, M, "M_Neon", (color[0], color[1], color[2], 1), FONT)
        add_light("point", out + normal * 0.9 + Vector((0, 0, z0 + h / 2)), color, 160.0, 1100.0, fog=1.2, source=30.0)
    else:
        size = 0.75
        z0 = z_street + (height or rnd.uniform(3.6, 4.6))
        w = len(word) * size * 0.55 + 0.6
        R = Matrix.Rotation(yaw, 3, 'Z')
        p = base + normal * 0.1
        D.box(p + Vector((0, 0, z0)), (0.1, w, size + 0.3), "M_VCMetal", board, rot=R)
        M = Matrix.Translation(p + normal * 0.07 + Vector((0, 0, z0))) @ Matrix.Rotation(yaw + math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
        kit.add_text(D, word, size, 0.03, M, "M_Neon", (color[0], color[1], color[2], 1), FONT)
        add_light("point", p + normal * 1.2 + Vector((0, 0, z0)), color, 140.0, 1000.0, fog=1.2, source=50.0)


def awning(base, tangent, normal, width, z, color):
    D = chunk_for(base.x, base.y, "d")
    a = base + Vector((0, 0, z))
    b = base + normal * 1.6 + Vector((0, 0, z - 0.6))
    hw = tangent * (width / 2)
    D.poly([a - hw, a + hw, b + hw, b - hw], "M_VC", color)
    D.poly([b - hw, b + hw, a + hw, a - hw], "M_VC", color)
    # scalloped front valance
    D.poly([b - hw, b + hw, b + hw - Vector((0, 0, 0.25)), b - hw - Vector((0, 0, 0.25))], "M_VC", color)
    D.poly([b - hw - Vector((0, 0, 0.25)), b + hw - Vector((0, 0, 0.25)), b + hw, b - hw], "M_VC", color)


# =========================================================================================================
# Buildings
# =========================================================================================================
buildings = []   # footprints for later decoration


STONE = (0.42, 0.4, 0.37, 0.5)
IRON = (0.05, 0.05, 0.055, 0.45)


def facade_details(a, b, top_z, zs, style, seed, u0, kind):
    """Relief that lines up with the procedural windows of M_Facade: string courses, sills, lintels, a roof
    cornice, AC units, a drainpipe, the odd balcony; fire escapes on alley walls. Decoration only (no collision)."""
    d = b - a
    L = d.length
    t = d / L
    n = Vector((t.y, -t.x, 0))                      # outward
    yaw = math.atan2(t.y, t.x)
    R = Matrix.Rotation(yaw, 3, 'Z')
    mid = (a + b) * 0.5
    D = chunk_for(mid.x, mid.y, "d")
    r = random.Random(int(seed * 1e6) + int(abs(a.x) * 31 + abs(a.y) * 17))
    colW = 2.4 + (3.6 - 2.4) * ((style * 7.31) % 1.0)
    floorH = 3.0 + (3.6 - 3.0) * ((style * 3.17) % 1.0)
    mx = 0.18 + (0.32 - 0.18) * ((style * 5.7) % 1.0)
    height = top_z - zs
    floors = int((height - 0.6) / floorH)

    def at(s_, v, out):
        return a + t * s_ + n * out + Vector((0, 0, zs + v))

    # ground-floor band and string courses
    D.box(at(L / 2, 4.45, 0.09), (L, 0.18, 0.3), "M_VC", STONE, rot=R)
    for k in range(2, floors + 1):
        v = 0.6 + k * floorH
        if v > height - 1.0:
            break
        D.box(at(L / 2, v - 0.02, 0.05), (L, 0.1, 0.1), "M_VC", STONE, rot=R)
    # roof cornice
    D.box(at(L / 2, height - 0.35, 0.16), (L + 0.3, 0.32, 0.22), "M_VC", STONE, rot=R)
    D.box(at(L / 2, height - 0.15, 0.24), (L + 0.45, 0.48, 0.12), "M_VC", STONE, rot=R)
    # sills and lintels per window
    balcony = r.random() < 0.22 and kind == "front"
    c0 = int(math.floor(u0 / colW))
    c1 = int(math.floor((u0 + L) / colW))
    for c in range(c0, c1 + 1):
        x0 = (c + mx) * colW - u0
        x1 = (c + 1 - mx) * colW - u0
        if x0 < 0.25 or x1 > L - 0.25:
            continue
        sc = (x0 + x1) / 2
        w = x1 - x0
        for k in range(floors):
            vb = 0.6 + k * floorH + 0.28 * floorH
            vt = 0.6 + k * floorH + 0.88 * floorH
            if vb < 4.5 or vt > height - 0.6:
                continue
            D.box(at(sc, vb - 0.05, 0.07), (w + 0.2, 0.14, 0.08), "M_VC", STONE, rot=R)
            D.box(at(sc, vt + 0.06, 0.04), (w + 0.12, 0.08, 0.12), "M_VC", STONE, rot=R)
            roll = r.random()
            if roll < 0.07:
                # window AC unit
                D.box(at(sc, vb - 0.35, 0.28), (0.75, 0.5, 0.45), "M_VCMetal", (0.55, 0.56, 0.55, 0.5), rot=R)
                D.box(at(sc, vb - 0.35, 0.54), (0.6, 0.02, 0.32), "M_VCMetal", (0.2, 0.2, 0.2, 0.5), rot=R)
            elif balcony and k >= 2 and k % 2 == 0:
                D.box(at(sc, vb - 0.1, 0.45), (w + 0.6, 0.9, 0.12), "M_VC", STONE, rot=R)
                for q in range(7):
                    px = sc - (w + 0.5) / 2 + q * (w + 0.5) / 6
                    D.box(at(px, vb + 0.4, 0.86), (0.03, 0.03, 0.9), "M_VCMetal", IRON, rot=R)
                D.box(at(sc, vb + 0.86, 0.86), (w + 0.55, 0.05, 0.05), "M_VCMetal", IRON, rot=R)
    # drainpipe at one end
    pe = a + t * 0.25 + n * 0.1
    D.cylinder((pe.x, pe.y, zs), (pe.x, pe.y, zs + height - 0.4), 0.05, "M_VCMetal", (0.12, 0.12, 0.13, 0.4), seg=8)
    # fire escape on alley walls
    if kind == "alley" and L > 6 and r.random() < 0.55:
        fx = L * r.uniform(0.3, 0.7)
        for k in range(1, min(floors, 5)):
            v = 0.6 + k * floorH
            if v > height - 1.5:
                break
            D.box(at(fx, v, 0.55), (3.0, 1.1, 0.06), "M_VCMetal", IRON, rot=R)
            for q in range(6):
                D.box(at(fx - 1.5 + q * 0.6, v + 0.45, 1.08), (0.03, 0.03, 0.9), "M_VCMetal", IRON, rot=R)
            D.box(at(fx, v + 0.9, 1.08), (3.0, 0.04, 0.04), "M_VCMetal", IRON, rot=R)
            # stair flight to the next landing
            p0 = at(fx - 1.2, v, 0.55)
            p1 = at(fx + 1.2, v + floorH, 0.55)
            D.cylinder(p0, p1, 0.03, "M_VCMetal", IRON, seg=4)
            D.cylinder(p0 + n * 0.4, p1 + n * 0.4, 0.03, "M_VCMetal", IRON, seg=4)


def building(poly, base_z, top_z, street_z_val, style=None, seed=None, shop=False, facing=None, roof_detail=True, kind="front"):
    """Extruded footprint (CCW). Facade UVs: u along each wall, v above the street. UV1 = (seed, style)."""
    style = rnd.random() if style is None else style
    seed = rnd.random() if seed is None else seed
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    B = chunk_for(cx, cy)
    n = len(poly)
    for k in range(n):
        a = Vector((poly[k][0], poly[k][1], 0))
        b = Vector((poly[(k + 1) % n][0], poly[(k + 1) % n][1], 0))
        L = (b - a).length
        if L < 0.01:
            continue
        mat = "M_Facade"
        v0 = base_z - street_z_val
        v1 = top_z - street_z_val
        uv1 = (seed, style)
        q = [a + Vector((0, 0, base_z)), b + Vector((0, 0, base_z)), b + Vector((0, 0, top_z)), a + Vector((0, 0, top_z))]
        u0 = rnd.uniform(0, 3)
        B.poly(q, mat, (1, 1, 1, 1), [(u0, v0), (u0 + L, v0), (u0 + L, v1), (u0, v1)], [uv1] * 4)
        if kind in ("front", "alley", "stairs", "hotel") and L > 3.0:
            facade_details(a, b, top_z, street_z_val, style, seed, u0, kind)
    # roof + parapet
    B.poly_facing([(p[0], p[1], top_z) for p in poly], (0, 0, 1), "M_Roof")
    if roof_detail:
        for k in range(n):
            a = Vector((poly[k][0], poly[k][1], top_z))
            b = Vector((poly[(k + 1) % n][0], poly[(k + 1) % n][1], top_z))
            d = (b - a)
            if d.length < 0.5:
                continue
            nrm = Vector((d.y, -d.x, 0)).normalized()
            mid = (a + b) / 2
            B.box(mid + Vector((0, 0, 0.45)) - nrm * 0.15, (d.length + 0.3, 0.3, 0.9), "M_Concrete", rot=Matrix.Rotation(math.atan2(d.y, d.x), 3, 'Z'))
        # rooftop clutter
        for _ in range(rnd.randint(0, 3)):
            px = cx + rnd.uniform(-2.5, 2.5)
            py = cy + rnd.uniform(-2.5, 2.5)
            kind_r = rnd.random()
            if kind_r < 0.35:
                # water tank
                B.cylinder((px, py, top_z), (px, py, top_z + 2.2), 0.08, "M_Wood", seg=4, caps=False)
                B.cylinder((px, py, top_z + 2.0), (px, py, top_z + 4.4), 1.3, "M_Wood", seg=12)
                B.cylinder((px, py, top_z + 4.4), (px, py, top_z + 5.2), 1.35, "M_VCMetal", (0.12, 0.12, 0.13, 0.5), r1=0.1, seg=12)
            elif kind_r < 0.8:
                B.box((px, py, top_z + 0.6), (rnd.uniform(1.2, 2.5), rnd.uniform(1.0, 2.0), 1.2), "M_VCMetal", (0.35, 0.36, 0.37, 0.5))
            else:
                ht = rnd.uniform(4, 9)
                B.cylinder((px, py, top_z), (px, py, top_z + ht), 0.05, "M_VCMetal", (0.2, 0.2, 0.2, 0.5), seg=5)
                B.sphere((px, py, top_z + ht), 0.15, "M_Glow", (1.0, 0.05, 0.03, 1), seg=6, rings=4)
    paint_poly(poly, None, 2)
    buildings.append((poly, base_z, top_z, street_z_val, kind))


def offset_line(path, side, dist):
    """Polyline offset to one side of a path (left = +1)."""
    out = []
    for p, t, l in path.frames():
        out.append((Vector((p.x, p.y, p.z)) + l * dist * side, t, l * side))
    return out


def frontage(edge, depth_range=(10, 16), width_range=(7, 15), h_range=(9, 24), shops=True, signs=0.5, z_ref=None, kind="front", awnings=0.35):
    """Walk along an edge (list of (point, tangent, outward normal pointing AWAY from the street)) placing
    buildings back to back."""
    i = 0
    n = len(edge)
    while i < n - 2:
        w = rnd.uniform(*width_range)
        j = i
        acc = 0.0
        while j < n - 1 and acc < w:
            acc += (edge[j + 1][0].xy - edge[j][0].xy).length
            j += 1
        if acc < 3.0:
            break
        p0, t0, o0 = edge[i]
        p1, t1, o1 = edge[j]
        placed = False
        for depth in (rnd.uniform(*depth_range), 7.0, 4.0):
            poly = [(p0.x, p0.y), (p1.x, p1.y), (p1.x + o1.x * depth, p1.y + o1.y * depth), (p0.x + o0.x * depth, p0.y + o0.y * depth)]
            # CCW check
            area = 0.0
            for k in range(4):
                area += poly[k][0] * poly[(k + 1) % 4][1] - poly[(k + 1) % 4][0] * poly[k][1]
            if area < 0:
                poly = list(reversed(poly))
            # shrink the footprint a hair for the occupancy test (neighbours share edges)
            cxp = sum(q[0] for q in poly) / 4
            cyp = sum(q[1] for q in poly) / 4
            test = [(cxp + (q[0] - cxp) * 0.9, cyp + (q[1] - cyp) * 0.9) for q in poly]
            if poly_free(test):
                zs = (min(p0.z, p1.z) + (CURB if kind == "front" else 0.0)) if z_ref is None else z_ref
                base = (ground_near(cxp, cyp, 25.0) or zs) - 6.0
                top = max(p0.z, p1.z) + rnd.uniform(*h_range)
                building(poly, base, top, zs, shop=shops, kind=kind)
                mid = (p0 + p1) * 0.5
                tang = (p1 - p0).normalized()
                outward = -(o0 + o1).normalized()      # toward the street
                if shops:
                    shopfront(mid, tang, outward, acc, min(p0.z, p1.z) + (CURB if kind == "front" else 0.0))
                if rnd.random() < signs:
                    neon_sign(mid + tang * rnd.uniform(-acc * 0.3, acc * 0.3), outward, min(p0.z, p1.z))
                placed = True
                break
        i = j
    return


def shopfront(mid, tangent, outward, width, z_street):
    if width < 4.0:
        return
    D = chunk_for(mid.x, mid.y, "d")
    B = chunk_for(mid.x, mid.y)
    w = width * rnd.uniform(0.55, 0.8)
    hw = tangent * (w / 2)
    face = mid + outward * 0.06
    z0 = z_street + 0.45
    z1 = z_street + 3.1
    tint = rnd.choice([(1.0, 0.72, 0.45), (0.8, 0.9, 1.0), (1.0, 0.55, 0.35), (0.6, 1.0, 0.85), (1.0, 0.85, 0.6), (1.0, 0.45, 0.6)])
    seed = rnd.random()
    q = [face - hw + Vector((0, 0, z0)), face + hw + Vector((0, 0, z0)), face + hw + Vector((0, 0, z1)), face - hw + Vector((0, 0, z1))]
    D.poly_facing(q, outward, "M_Shop", (tint[0], tint[1], tint[2], 1), [(0, 0), (w, 0), (w, z1 - z0), (0, z1 - z0)], [(seed, 0)] * 4)
    # frame + mullions + sill
    yaw = math.atan2(tangent.y, tangent.x)
    R = Matrix.Rotation(yaw, 3, 'Z')
    dark = (0.03, 0.03, 0.035, 0.4)
    B.box(face + Vector((0, 0, z0 - 0.25)), (w + 0.3, 0.3, 0.5), "M_VCMetal", dark, rot=R)
    D.box(face + Vector((0, 0, z1 + 0.08)), (w + 0.3, 0.16, 0.16), "M_VCMetal", dark, rot=R)
    for k in range(int(w / 1.6) + 1):
        px = face - hw + tangent * (k * w / max(1, int(w / 1.6)))
        D.box(px + Vector((0, 0, (z0 + z1) / 2)), (0.08, 0.1, z1 - z0), "M_VCMetal", dark, rot=R)
    if rnd.random() < 0.4:
        awning(mid + outward * 0.1, tangent, outward, w + 0.6, z_street + 3.6, rnd.choice([(0.5, 0.06, 0.05, 0.6), (0.05, 0.25, 0.2, 0.6), (0.6, 0.45, 0.1, 0.6), (0.12, 0.1, 0.3, 0.6)]))
    # spill light from the window onto the wet sidewalk
    if rnd.random() < 0.22:
        add_light("rect", face + outward * 0.25 + Vector((0, 0, z_street + 1.8)), tint, 22.0, 900.0, rot=[0.0, ue_yaw(outward.x, outward.y), 0.0], size=[w * 80, 220], fog=0.5)


def filler():
    """Fill every free cell of the map with buildings: runs of 6 m cells along each row."""
    C = 6.0
    ys = np.arange(Y0 + 20, Y1 - 20, C)
    xs = np.arange(X0 + 20, X1 - 20, C)

    def emit(xa, xb, y):
        cx, cy = (xa + xb) / 2, y + C / 2
        g = ground_near(cx, cy, 40.0)
        if g is None:
            g = 5.0
        building([(xa, y), (xb, y), (xb, y + C), (xa, y + C)], g - 8.0, g + rnd.uniform(10, 34), g + 1.0,
                 roof_detail=rnd.random() < 0.3, kind="fill")

    for y in ys:
        start = None
        target = rnd.uniform(12, 30)
        for x in xs:
            free = poly_free([(x, y), (x + C, y), (x + C, y + C), (x, y + C)])
            if free and start is None:
                start = x
            if start is not None and (not free or x + C - start >= target):
                end = x if not free else x + C
                if end > start:
                    emit(start, end, y)
                start = x + C if free else None
                target = rnd.uniform(12, 30)
        if start is not None and xs[-1] + C > start:
            emit(start, xs[-1] + C, y)


# =========================================================================================================
# Water: canal + harbour + quays + bridge dressing
# =========================================================================================================
CANAL_N, CANAL_S = -474.0, -486.0
WATER_CANAL = 11.0
HARBOUR_Y = -606.0
PROMENADE_Z = 2.6


def build_water():
    # canal water strip
    for xa in np.arange(X0, X1, 50.0):
        B = chunk_for(xa + 25, (CANAL_N + CANAL_S) / 2)
        B.poly_facing([(xa, CANAL_S, WATER_CANAL), (xa + 50, CANAL_S, WATER_CANAL), (xa + 50, CANAL_N, WATER_CANAL), (xa, CANAL_N, WATER_CANAL)], (0, 0, 1), "M_Water")
    # quay walls (vertical, stone) on both banks, from the quay top down into the water
    for xa in np.arange(X0, X1, 10.0):
        for y, side in ((CANAL_N, -1), (CANAL_S, 1)):
            zt = (street_at(xa + 5, y + (8 if side < 0 else -8), 20.0) or (17.0 if side < 0 else 16.4)) + CURB
            B = chunk_for(xa + 5, y)
            q = [(xa, y, WATER_CANAL - 1.0), (xa + 10, y, WATER_CANAL - 1.0), (xa + 10, y, zt), (xa, y, zt)]
            q = [Vector(v) for v in q]
            B.poly(q if side < 0 else list(reversed(q)), "M_Concrete")
    # quay strips (paved) between the canal and the streets, at road height + kerb
    for xa in np.arange(X0, X1, 10.0):
        for y0, y1 in ((CANAL_N, CANAL_N + 4.0), (CANAL_S - 4.0, CANAL_S)):
            yc = (y0 + y1) / 2
            north = y0 >= CANAL_N
            zs = street_at(xa + 5, yc + (6 if north else -6), 20.0)
            if zs is None:
                zs = 17.0 if north else 16.4
            zt = zs + CURB
            # railing along the water, except at the dock jump and where the bridge crosses
            if not (-128.0 < xa + 5 < -92.0) and not (-47.0 < xa + 5 < -23.0):
                yr = CANAL_N + 0.35 if north else CANAL_S - 0.35
                Bq = chunk_for(xa + 5, yr)
                Bq.box((xa + 5, yr, zt + 0.5), (10.0, 0.1, 1.0), "M_VCMetal", (0.08, 0.09, 0.1, 0.4), faces=("+y", "-y", "+z"))
                Bq.cylinder((xa, yr, zt + 1.05), (xa + 10, yr, zt + 1.05), 0.04, "M_VCMetal", (0.1, 0.11, 0.12, 0.4), seg=6)
            poly = [(xa, y0), (xa + 10, y0), (xa + 10, y1), (xa, y1)]
            B = chunk_for(xa + 5, yc)
            B.poly_facing([(p[0], p[1], zt - 0.01) for p in poly], (0, 0, 1), "M_Cobble")
    paint_poly([(X0, CANAL_S - 4.0), (X1, CANAL_S - 4.0), (X1, CANAL_N + 4.0), (X0, CANAL_N + 4.0)], None, 1)
    # harbour: huge water plane and the promenade wall
    B = chunk_for(-50, HARBOUR_Y - 50)
    for xa in np.arange(-1600, 1600, 400.0):
        for ya in np.arange(HARBOUR_Y - 2400, HARBOUR_Y, 400.0):
            Bc = chunk_for(max(X0, min(X1 - 1, xa + 200)), HARBOUR_Y - 10)
            Bc.poly_facing([(xa, ya, 0.0), (xa + 400, ya, 0.0), (xa + 400, min(ya + 400, HARBOUR_Y), 0.0), (xa, min(ya + 400, HARBOUR_Y), 0.0)], (0, 0, 1), "M_Water")
    paint_poly([(X0, Y0), (X1, Y0), (X1, HARBOUR_Y + 12.0), (X0, HARBOUR_Y + 12.0)], None, 1)


def build_promenade():
    y0, y1 = HARBOUR_Y, HARBOUR_Y + 12.0
    z = PROMENADE_Z
    for xa in np.arange(-220, 160, 10.0):
        B = chunk_for(xa + 5, (y0 + y1) / 2)
        B.poly_facing([(xa, y0, z), (xa + 10, y0, z), (xa + 10, y1, z), (xa, y1, z)], (0, 0, 1), "M_Cobble")
        B.poly([Vector((xa + 10, y0, z)), Vector((xa, y0, z)), Vector((xa, y0, -1.0)), Vector((xa + 10, y0, -1.0))], "M_Concrete")
        # railing posts + rail
        for k in range(5):
            px = xa + k * 2.0
            B.cylinder((px, y0 + 0.3, z), (px, y0 + 0.3, z + 1.1), 0.035, "M_VCMetal", (0.1, 0.11, 0.12, 0.4), seg=6)
        B.cylinder((xa, y0 + 0.3, z + 1.1), (xa + 10, y0 + 0.3, z + 1.1), 0.04, "M_VCMetal", (0.1, 0.11, 0.12, 0.4), seg=6)
    # an invisible-ish low wall for collision along the railing
    for xa in np.arange(-220, 160, 20.0):
        B = chunk_for(xa + 10, y0)
        B.box((xa + 10, y0 + 0.3, z + 0.5), (20.0, 0.12, 1.0), "M_VCMetal", (0.1, 0.11, 0.12, 0.4), faces=("+y", "-y", "+z"))
    for xa in np.arange(-210, 150, 24.0):
        lamp_post(xa, y0 + 1.0, z, 90.0, 5.0, warm=False, shadow=False, arm=0.8)
    paint_poly([(-230, y0), (170, y0), (170, y1), (-230, y1)], z, 1)


def build_bridge():
    x = -35.0
    z = street_at(x, -480.0) + CURB
    B = chunk_for(x, -480)
    # arched underside facing the canal
    for side in (-1, 1):
        xw = x + side * (ROAD_HW + WALK)
        for k in range(12):
            ya = CANAL_N + 1.0 - k * (CANAL_N - CANAL_S + 2.0) / 12
            yb = CANAL_N + 1.0 - (k + 1) * (CANAL_N - CANAL_S + 2.0) / 12
            t0 = (k) / 12
            t1 = (k + 1) / 12
            za = z - 0.6 - 3.5 * (1 - (2 * t0 - 1) ** 2)
            zb = z - 0.6 - 3.5 * (1 - (2 * t1 - 1) ** 2)
            q = [Vector((xw, ya, z - 0.2)), Vector((xw, yb, z - 0.2)), Vector((xw, yb, zb + 3.6)), Vector((xw, ya, za + 3.6))]
        B.box((xw, (CANAL_N + CANAL_S) / 2, z + 0.55), (0.35, CANAL_N - CANAL_S + 8, 1.1), "M_Concrete")
        for k in range(3):
            lamp_post(xw - side * 0.1, CANAL_N + 2 - k * 7.0, z, 0.0 if side < 0 else 180.0, 4.5, warm=True, shadow=(k == 1), arm=0.6)
    # arch ribs under the deck
    for k in range(13):
        ya = CANAL_N - k
        t = k / 12
        zz = z - 0.8 - 3.0 * (1 - (2 * t - 1) ** 2) * 0.6
        B.box((x, ya, zz), (2 * (ROAD_HW + WALK), 1.0, 1.0), "M_Concrete")


def build_plazas():
    # Kicker plaza north of the canal, landing plaza south of it (both at road level).
    zN = ZQ_N - 0.02
    zS = ZQ_S - 0.02
    north = [(-126.0, CANAL_N), (-94.0, CANAL_N), (-94.0, -458.0), (-126.0, -458.0)]
    south = [(-126.0, -500.0), (-94.0, -500.0), (-94.0, CANAL_S), (-126.0, CANAL_S)]
    # Plazas follow the street they open onto (no lip where they meet it), sitting 2 cm under the road.
    for poly, z in ((north, zN), (south, zS)):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        xa, xb, ya, yb = min(xs), max(xs), min(ys), max(ys)
        step = 1.0
        nx_, ny_ = int(round((xb - xa) / step)), int(round((yb - ya) / step))
        H = np.zeros((ny_ + 1, nx_ + 1))
        for jy in range(ny_ + 1):
            for jx in range(nx_ + 1):
                H[jy, jx] = (street_at(xa + jx * step, ya + jy * step, 25.0) or z) - 0.02
        B = chunk_for(-110, poly[0][1])
        for jy in range(ny_):
            for jx in range(nx_):
                x0, y0 = xa + jx * step, ya + jy * step
                B.poly_facing([(x0, y0, H[jy, jx]), (x0 + step, y0, H[jy, jx + 1]), (x0 + step, y0 + step, H[jy + 1, jx + 1]), (x0, y0 + step, H[jy + 1, jx])], (0, 0, 1), "M_Cobble")
        paint_poly(poly, z, 1)
    # the kicker: dock boards on a curved frame, lip 1.05 m over the plaza
    y0, y1 = -464.5, -473.5
    lip = 1.8
    B = chunk_for(-110, -468)
    n = 10
    W = 4.2
    prev = None
    for k in range(n + 1):
        t = k / n
        y = y0 + (y1 - y0) * t
        zz = zN + lip * (t ** 2.4)
        if prev is not None:
            py, pz = prev
            for side in (-1, 1):
                pass
            B.poly_facing([(-110 - W / 2, py, pz), (-110 + W / 2, py, pz), (-110 + W / 2, y, zz), (-110 - W / 2, y, zz)], (0, 0, 1), "M_Wood")
            for side in (-1, 1):
                xs = -110 + side * W / 2
                B.poly_facing([(xs, py, zN), (xs, y, zN), (xs, y, zz), (xs, py, pz)], (side, 0, 0), "M_Wood")
        prev = (y, zz)
    B.poly_facing([(-110 - W / 2, y1, zN), (-110 + W / 2, y1, zN), (-110 + W / 2, y1, zN + lip), (-110 - W / 2, y1, zN + lip)], (0, -1, 0), "M_Wood")
    # hazard stripes on the lip, a crate stack and a work light that tempts you
    D = chunk_for(-110, -468, "d")
    for k in range(8):
        x = -110 - W / 2 + (k + 0.5) * W / 8
        c = (0.9, 0.7, 0.05, 1) if k % 2 == 0 else (0.03, 0.03, 0.03, 1)
        D.box((x, y1 + 0.08, zN + lip - 0.02), (W / 8, 0.16, 0.04), "M_Paint", c, faces=("+z",))
    for k, (dx, dz) in enumerate(((3.6, 0.45), (4.6, 0.45), (4.1, 1.35))):
        B.box((-110 + dx, -469 + rnd.uniform(-0.5, 0.5), zN + dz), (0.9, 0.9, 0.9), "M_Wood")
    add_light("spot", Vector((-104.0, -466.0, zN + 4.5)), (1.0, 0.85, 0.6), 2600.0, 2200.0, shadow=True, rot=[-55.0, 90.0 + 20.0, 0.0], cone=[18.0, 40.0], fog=2.0)
    D.cylinder((-104.0, -466.0, zN), (-104.0, -466.0, zN + 4.5), 0.06, "M_VCMetal", (0.1, 0.1, 0.1, 0.5), seg=6)
    D.box((-104.0, -466.2, zN + 4.6), (0.4, 0.3, 0.3), "M_Lamp", (1.0, 0.85, 0.6, 1))
    return (-110.0, y1, zN + lip)


# =========================================================================================================
# Needle Alley
# =========================================================================================================
def build_alley():
    zs = street_at(1.5, -314.0) + CURB
    ze = street_at(-104.0, -427.0) + CURB
    pts = [(2.0, -313.0), (2.0, -338.0), (-14.0, -352.0), (-24.0, -364.0), (-28.0, -371.0), (-46.0, -385.0),
           (-60.0, -393.0), (-65.0, -405.0), (-69.0, -412.0), (-76.0, -417.0), (-88.0, -420.0), (-98.0, -421.5), (-103.0, -427.0)]
    # cumulative distance
    d = [0.0]
    for k in range(1, len(pts)):
        d.append(d[-1] + math.dist(pts[k], pts[k - 1]))
    total = d[-1]
    stairs = [(3, 4, 1.7), (7, 8, 2.1)]    # (from point, to point, drop)
    stair_drop = sum(s[2] for s in stairs)
    ramp = (zs - ze - stair_drop)
    ramp_len = total - sum(d[b] - d[a] for a, b, _ in stairs)
    z = [zs]
    for k in range(1, len(pts)):
        seg = d[k] - d[k - 1]
        st = [s for s in stairs if s[1] == k]
        z.append(z[-1] - (st[0][2] if st else ramp * seg / ramp_len))
    HW_BASE = 1.7

    def seg_hw(k):
        return 2.8 if k >= len(pts) - 3 else HW_BASE
    path_pts = []
    for k in range(len(pts) - 1):
        HW = seg_hw(k)
        a = Vector((pts[k][0], pts[k][1], z[k]))
        b = Vector((pts[k + 1][0], pts[k + 1][1], z[k + 1]))
        dirv = (b - a)
        L = dirv.xy.length
        t = Vector((dirv.x, dirv.y, 0)).normalized()
        l = Vector((-t.y, t.x, 0))
        is_stair = any(s[0] == k for s in stairs)
        B = chunk_for((a.x + b.x) / 2, (a.y + b.y) / 2)
        if is_stair:
            steps = max(4, int(round((a.z - b.z) / 0.17)))
            rise = (a.z - b.z) / steps
            # flat lead-in then the steps occupy the rest
            lead = L - steps * 0.3
            if lead > 0:
                p0, p1 = a, a + t * lead
                B.poly_facing([p0 - l * HW, p1 - l * HW, p1 + l * HW, p0 + l * HW], (0, 0, 1), "M_Cobble")
            for s_ in range(steps):
                ca = a + t * (max(lead, 0) + s_ * 0.3)
                cb = ca + t * 0.3
                zt = a.z - rise * (s_ + 1)
                ctr = (ca + cb) / 2
                B.box((ctr.x, ctr.y, zt - 0.5), (0.302, HW * 2, 1.0), "M_Stairs", rot=Matrix.Rotation(math.atan2(t.y, t.x), 3, 'Z'), faces=("+z", "-x", "+x"))
            path_pts.append((a, True))
        else:
            n = max(1, int(L))
            for s_ in range(n):
                p0 = a.lerp(b, s_ / n)
                p1 = a.lerp(b, (s_ + 1) / n)
                Bs = chunk_for(p0.x, p0.y)
                Bs.poly_facing([p0 - l * HW, p1 - l * HW, p1 + l * HW, p0 + l * HW], (0, 0, 1), "M_Cobble")
                # skirts
                for side in (-1, 1):
                    e0, e1 = p0 + l * HW * side, p1 + l * HW * side
                    q = [e0, e1, e1 - Vector((0, 0, 3)), e0 - Vector((0, 0, 3))]
                    Bs.poly(q if side < 0 else list(reversed(q)), "M_Concrete")
            path_pts.append((a, False))
        for s_ in np.arange(0, L + 0.01, 0.5):
            p = a + t * s_
            paint_disc(p.x, p.y, HW + 0.2, a.z + (b.z - a.z) * s_ / max(L, 1e-3))
    path_pts.append((Vector((pts[-1][0], pts[-1][1], z[-1])), False))
    # walls: buildings hugging both sides of the alley, built from offset polylines
    for side in (1, -1):
        edge = []
        for k in range(len(pts) - 1):
            HW = seg_hw(k)
            a = Vector((pts[k][0], pts[k][1], z[k]))
            b = Vector((pts[k + 1][0], pts[k + 1][1], z[k + 1]))
            t = Vector(((b - a).x, (b - a).y, 0)).normalized()
            l = Vector((-t.y, t.x, 0))
            L = (b - a).xy.length
            for s_ in np.arange(0, L, 1.0):
                p = a.lerp(b, s_ / max(L, 1e-3)) + l * (HW + 0.25) * side
                edge.append((p, t, l * side))
        frontage(edge, depth_range=(6, 11), width_range=(5, 10), h_range=(8, 18), shops=False, signs=0.0, kind="alley")
    # dressing: dumpsters, crates, AC units, bulbs over back doors, laundry lines, pipes
    for k in range(1, len(pts) - 1):
        a = Vector((pts[k][0], pts[k][1], z[k]))
        b = Vector((pts[k + 1][0], pts[k + 1][1], z[k + 1]))
        if any(s[0] == k for s in stairs):
            continue
        t = Vector(((b - a).x, (b - a).y, 0)).normalized()
        l = Vector((-t.y, t.x, 0))
        L = (b - a).xy.length
        side = 1 if k % 2 == 0 else -1
        R = Matrix.Rotation(math.atan2(t.y, t.x), 3, 'Z')
        B = chunk_for(a.x, a.y)
        D = chunk_for(a.x, a.y, "d")
        HW = seg_hw(k)
        if L > 8:
            p = a + t * (L * 0.5) + l * (HW - 0.65) * side
            B.box((p.x, p.y, a.z + (b.z - a.z) * 0.5 + 0.65), (1.8, 1.0, 1.3), "M_VCMetal", (0.08, 0.2, 0.12, 0.5), rot=R)   # dumpster
            B.box((p.x, p.y, a.z + (b.z - a.z) * 0.5 + 1.33), (1.9, 1.05, 0.08), "M_VCMetal", (0.04, 0.05, 0.05, 0.5), rot=R)
        if L > 5:
            p = a + t * (L * 0.25) - l * (HW - 0.45) * side
            zz = a.z + (b.z - a.z) * 0.25
            for c in range(rnd.randint(1, 3)):
                B.box((p.x + rnd.uniform(-0.1, 0.1), p.y + rnd.uniform(-0.1, 0.1), zz + 0.3 + c * 0.6), (0.6, 0.6, 0.6), "M_Wood", rot=R)
        # bulb over a door
        p = a + t * (L * 0.7) + l * (HW + 0.2) * (-side)
        zz = a.z + (b.z - a.z) * 0.7
        D.box((p.x, p.y, zz + 1.1), (1.0, 0.1, 2.2), "M_VCMetal", (0.12, 0.08, 0.06, 0.6), rot=R)
        D.sphere((p.x - l.x * 0.25 * side, p.y - l.y * 0.25 * side, zz + 2.6), 0.1, "M_Lamp", (1.0, 0.7, 0.35, 1), seg=8, rings=5)
        add_light("point", Vector((p.x, p.y, zz + 2.5)) - l * 0.6 * (-side), (1.0, 0.62, 0.3), 30.0, 700.0, shadow=(k % 3 == 0), fog=1.5, source=5.0)
        # laundry / wires across
        if k % 2 == 1:
            m = a + t * (L * 0.4)
            lantern_string(m + l * (HW + 0.3) + Vector((0, 0, 4.6)), m - l * (HW + 0.3) + Vector((0, 0, 4.9)), 0.4, 6, palette=[(0.9, 0.3, 0.2), (0.2, 0.6, 0.9), (0.9, 0.85, 0.7)], light=False)
    return path_pts, (zs, ze)


# =========================================================================================================
# Ground fill: every leftover gap gets a floor just below the nearest street, so nothing opens onto the void
# =========================================================================================================
def ground_fill():
    K = 4                                       # coarse block = 2 m
    ny, nx = NY // K, NX // K
    zc = street_z[: ny * K, : nx * K].reshape(ny, K, nx, K)
    with np.errstate(all="ignore"):
        G = np.nanmin(np.nanmin(zc, axis=3), axis=1)
        for _ in range(800):
            nan = np.isnan(G)
            if not nan.any():
                break
            P = np.pad(G, 1, mode="edge")
            stack = np.stack([P[:-2, 1:-1], P[2:, 1:-1], P[1:-1, :-2], P[1:-1, 2:]])
            m = np.nanmean(stack, axis=0)
            G[nan] = m[nan]
    G = np.nan_to_num(G, nan=5.0)
    ys = Y0 + (np.arange(NY) + 0.5) * RES
    water = (ys[:, None] >= CANAL_S) & (ys[:, None] <= CANAL_N) | (ys[:, None] < HARBOUR_Y + 0.5)
    fill = (occ == 0) & ~np.broadcast_to(water, occ.shape)
    count = 0
    for i in range(NY):
        row = fill[i]
        y0 = Y0 + i * RES
        j = 0
        while j < NX:
            if not row[j]:
                j += 1
                continue
            gi = min(i // K, ny - 1)
            z = round(float(G[gi, min(j // K, nx - 1)]) * 4) / 4 - 0.3
            k = j
            while k < NX and row[k] and k - j < 40 and round(float(G[gi, min(k // K, nx - 1)]) * 4) / 4 - 0.3 == z:
                k += 1
            x0 = X0 + j * RES
            x1 = X0 + k * RES
            B = chunk_for((x0 + x1) / 2, y0)
            B.poly_facing([(x0, y0, z), (x1, y0, z), (x1, y0 + RES, z), (x0, y0 + RES, z)], (0, 0, 1), "M_Concrete")
            count += 1
            j = k
    print("MC_FILL quads", count)


# =========================================================================================================
# Distant skyline and far shore
# =========================================================================================================
def skyline():
    for k in range(70):
        a = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(520, 900)
        cx, cy = -40 + math.cos(a) * r, -260 + math.sin(a) * r * 1.2
        if cy < HARBOUR_Y - 100:
            continue
        w, d = rnd.uniform(18, 45), rnd.uniform(18, 45)
        h = rnd.uniform(40, 140)
        g = 20.0 if cy > -200 else 6.0
        poly = [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]
        B = chunk_for(max(X0 + 1, min(X1 - 1, cx)), max(Y0 + 1, min(Y1 - 1, cy)), "d")
        style, seed = rnd.random(), rnd.random()
        for kk in range(4):
            a_ = Vector((poly[kk][0], poly[kk][1], 0))
            b_ = Vector((poly[(kk + 1) % 4][0], poly[(kk + 1) % 4][1], 0))
            L = (b_ - a_).length
            B.poly([a_ + Vector((0, 0, g - 10)), b_ + Vector((0, 0, g - 10)), b_ + Vector((0, 0, g + h)), a_ + Vector((0, 0, g + h))], "M_Facade", (1, 1, 1, 1),
                   [(0, -10), (L, -10), (L, h), (0, h)], [(seed, style)] * 4)
        B.poly_facing([(p[0], p[1], g + h) for p in poly], (0, 0, 1), "M_Roof")
        B.box((cx, cy, g + h + 1.5), (0.6, 0.6, 3.0), "M_Glow", (1.0, 0.05, 0.03, 1))
    # far shore: a strip of low lights across the bay
    D = chunk_for(-40, Y0 + 5, "d")
    for k in range(260):
        x = rnd.uniform(-1500, 1400)
        y = HARBOUR_Y - rnd.uniform(900, 1300)
        h = rnd.uniform(2, 30)
        c = rnd.choice([(1.0, 0.65, 0.35), (0.8, 0.9, 1.0), (1.0, 0.4, 0.3)])
        D.box((x, y, h), (rnd.uniform(1, 4), 0.5, rnd.uniform(0.6, 2)), "M_Lamp", (c[0] * 0.3, c[1] * 0.3, c[2] * 0.3, 1))
    # far shore silhouettes
    for k in range(40):
        x = -1500 + k * 75 + rnd.uniform(-20, 20)
        y = HARBOUR_Y - rnd.uniform(1000, 1400)
        h = rnd.uniform(15, 70)
        D.box((x, y, h / 2 - 5), (rnd.uniform(30, 70), 30, h + 10), "M_Roof")


def boats():
    for k in range(9):
        x = rnd.uniform(-200, 120)
        y = HARBOUR_Y - rnd.uniform(15, 70)
        L = rnd.uniform(8, 16)
        yaw = rnd.uniform(-0.4, 0.4)
        D = chunk_for(max(X0 + 1, x), HARBOUR_Y - 5, "d")
        R = Matrix.Rotation(yaw, 3, 'Z')
        D.box((x, y, 0.5), (L, L * 0.3, 1.6), "M_VC", rnd.choice([(0.6, 0.6, 0.62, 0.5), (0.1, 0.2, 0.35, 0.5), (0.5, 0.1, 0.08, 0.5)]), rot=R)
        D.box((x - L * 0.1, y, 2.0), (L * 0.35, L * 0.22, 1.4), "M_VC", (0.8, 0.8, 0.78, 0.5), rot=R)
        D.box((x - L * 0.1, y, 2.2), (L * 0.33, L * 0.23, 0.4), "M_Lamp", (0.6, 0.45, 0.25, 1), rot=R)
        D.cylinder((x, y, 2.6), (x, y, 2.6 + L * 0.6), 0.06, "M_VCMetal", (0.2, 0.2, 0.2, 0.5), seg=5)
        D.sphere((x, y, 2.6 + L * 0.6), 0.12, "M_Glow", (0.2, 1.0, 0.3, 1), seg=6, rings=4)
    # canal boats
    for k in range(5):
        x = rnd.uniform(-260, 200)
        if -60 < x < 0 or -130 < x < -90:
            continue
        y = (CANAL_N + CANAL_S) / 2 + rnd.uniform(-2.5, 2.5)
        D = chunk_for(x, y, "d")
        D.box((x, y, WATER_CANAL + 0.4), (7.0, 2.2, 1.0), "M_Wood")
        D.box((x - 0.8, y, WATER_CANAL + 1.2), (3.0, 1.8, 0.8), "M_VC", (0.15, 0.25, 0.2, 0.6))


# =========================================================================================================
# Main
# =========================================================================================================
def main_build():
    kit.reset_scene()
    stairs_route, stairs_z = build_stairs()
    kicker = build_plazas()
    alley_route, alley_z = build_alley()
    build_water()
    build_promenade()
    build_bridge()

    # The hotel (drop-off): west side at the bottom of Pier Lane, with a canopy and a doorman light.
    goal = Vector((-110.0, -581.0, street_at(-110.0, -581.0)))
    zh = goal.z
    hotel = [(-141.0, -592.0), (-118.5, -592.0), (-118.5, -560.0), (-141.0, -560.0)]
    building(hotel, zh - 8, zh + 30, zh, style=0.43, seed=0.77, kind="hotel")
    D = chunk_for(-118, -581, "d")
    B = chunk_for(-118, -581)
    D.box((-116.5, -581.0, zh + 3.4), (3.4, 6.0, 0.25), "M_VCMetal", (0.25, 0.05, 0.05, 0.3))       # canopy
    D.box((-116.5, -581.0, zh + 3.25), (3.2, 5.8, 0.05), "M_Lamp", (1.0, 0.75, 0.45, 1))
    for yy in (-578.4, -583.6):
        B.cylinder((-115.0, yy, zh), (-115.0, yy, zh + 3.4), 0.06, "M_VCMetal", (0.6, 0.5, 0.2, 0.2), seg=8)
    D.box((-118.45, -581.0, zh + 1.4), (0.1, 2.4, 2.8), "M_Shop", (1.0, 0.8, 0.55, 1))
    M = Matrix.Translation((-118.35, -581.0, zh + 6.5)) @ Matrix.Rotation(-math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
    M = Matrix.Translation((-118.3, -581.0, zh + 6.6)) @ Matrix.Rotation(math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
    kit.add_text(D, "HOTEL MARLOWE", 1.3, 0.05, M, "M_Neon", (1.0, 0.55, 0.15, 1), FONT)
    add_light("point", Vector((-115.5, -581.0, zh + 6.6)), (1.0, 0.55, 0.15), 420.0, 1600.0, fog=1.5, source=150.0)
    add_light("spot", Vector((-115.5, -581.0, zh + 3.1)), (1.0, 0.75, 0.45), 900.0, 900.0, rot=[-90.0, 0.0, 0.0], cone=[30.0, 70.0], fog=1.0)

    # The pickup: Lucky Lantern Noodles at the top of Crown Street (east side).
    start = Vector((2.0, 30.0, street_at(2.0, 30.0)))
    ztop = street_at(0.0, 52.0)
    B = chunk_for(0.0, 56.0)
    B.poly_facing([(-8.0, 51.5, ztop + CURB), (8.0, 51.5, ztop + CURB), (8.0, 61.0, ztop + CURB), (-8.0, 61.0, ztop + CURB)], (0, 0, 1), "M_Sidewalk")
    paint_poly([(-8.0, 51.5), (8.0, 51.5), (8.0, 61.0), (-8.0, 61.0)], ztop, 1)
    building([(-16.0, 61.0), (16.0, 61.0), (16.0, 76.0), (-16.0, 76.0)], ztop - 6, ztop + 22, ztop + CURB, kind="front")

    # Parked cars, trees and clutter along the straight stretches (before buildings, so they keep clear).
    frs = main.frames()
    curv_ok = []
    for i in range(len(frs)):
        a_ = frs[max(0, i - 4)][1]
        b_ = frs[min(len(frs) - 1, i + 4)][1]
        curv_ok.append(a_.dot(b_) > 0.995)
    i = 12
    while i < len(frs) - 12:
        p, t, l = frs[i]
        near_gap = any(g[0] - 10 <= i <= g[1] + 10 for g in GAPS)
        if curv_ok[i] and curv_ok[i + 4] and not near_gap and not (-312 < p.y < -205 and abs(p.x) < 4) and p.y > -560:
            side = 1 if (i // 7) % 2 else -1
            if rnd.random() < 0.38:
                q = p + l * (ROAD_HW - 1.05) * side
                parked_car(q, math.atan2(t.y, t.x) + (0 if side > 0 else 0), p.z)
                i += 9
                continue
            if rnd.random() < 0.3:
                q = p + l * (ROAD_HW + WALK - 0.9) * side
                street_tree(q, p.z + CURB)
            elif rnd.random() < 0.5:
                q = p + l * (ROAD_HW + 0.7) * side
                street_clutter(q, t, p.z + CURB)
        i += 7
    # overhead cables across the streets
    for i in range(20, len(frs) - 20, 31):
        p, t, l = frs[i]
        overhead_cable(p + l * (ROAD_HW + WALK + 0.3) + Vector((0, 0, 7.5 + rnd.uniform(0, 2))), p - l * (ROAD_HW + WALK + 0.3) + Vector((0, 0, 7.5 + rnd.uniform(0, 2))), 0.6)
    # promenade benches
    for xb in np.arange(-190, 140, 18.0):
        Bb = chunk_for(xb, HARBOUR_Y + 2)
        Bb.box((xb, HARBOUR_Y + 2.0, PROMENADE_Z + 0.45), (1.8, 0.5, 0.06), "M_Wood")
        Bb.box((xb, HARBOUR_Y + 1.8, PROMENADE_Z + 0.75), (1.8, 0.06, 0.4), "M_Wood")
        for sx in (-0.8, 0.8):
            Bb.box((xb + sx, HARBOUR_Y + 2.0, PROMENADE_Z + 0.22), (0.06, 0.5, 0.45), "M_VCMetal", IRON)

    # Buildings along every street side (signs + shops), then fill the blocks behind.
    for side in (1, -1):
        edge = []
        for p, t, l in offset_line(main, side, ROAD_HW + WALK + 0.25):
            edge.append((p, t, l))
        frontage(edge, signs=0.5)
    # Lantern Steps walls
    for side in (1, -1):
        edge = []
        for yy in np.arange(-152.0, -208.0, -1.0):
            zz = float(np.interp(-yy, [152, 208], [stairs_z[0], stairs_z[1]]))
            edge.append((Vector((STAIR_X + side * (STAIR_HW + 0.45), yy, zz)), Vector((0, -1, 0)), Vector((side, 0, 0))))
        frontage(edge, depth_range=(6, 10), width_range=(6, 10), h_range=(8, 16), shops=False, signs=0.25, kind="stairs")
    filler()

    # Street furniture along the main route: lamps alternate sides every ~24 m.
    fr = main.frames()
    for i in range(6, len(fr) - 4, 24):
        p, t, l = fr[i]
        side = 1 if (i // 24) % 2 == 0 else -1
        q = p + l * (ROAD_HW + 0.6) * side
        yaw = math.degrees(math.atan2(-l.y * side, -l.x * side))
        lamp_post(q.x, q.y, p.z + CURB, yaw, 6.2, warm=(i // 24) % 3 != 2, shadow=(i // 24) % 3 == 0)

    # Market Street: strings of lights across the street, crates of produce on the sidewalk.
    i0 = main.marks["c2"]
    i1 = main.marks["market_end"]
    for i in range(i0 + 6, i1 - 2, 9):
        p, t, l = fr[i]
        a = p + l * (ROAD_HW + WALK) + Vector((0, 0, 6.0))
        b = p - l * (ROAD_HW + WALK) + Vector((0, 0, 6.3))
        lantern_string(a, b, 0.9, 12, palette=[(1.0, 0.25, 0.15), (1.0, 0.65, 0.2), (0.95, 0.85, 0.5)], light=(i - i0) % 18 == 6)
        for side in (1, -1):
            if rnd.random() < 0.6:
                q = p + l * (ROAD_HW + WALK - 1.2) * side
                B = chunk_for(q.x, q.y)
                for c in range(rnd.randint(2, 4)):
                    col = rnd.choice([(0.8, 0.3, 0.05, 0.6), (0.5, 0.65, 0.1, 0.6), (0.85, 0.75, 0.1, 0.6), (0.6, 0.08, 0.1, 0.6)])
                    off = t * rnd.uniform(-2.0, 2.0)
                    B.box((q.x + off.x, q.y + off.y, p.z + CURB + 0.35), (0.7, 0.5, 0.5), "M_Wood")
                    B.box((q.x + off.x, q.y + off.y, p.z + CURB + 0.62), (0.62, 0.42, 0.08), "M_VC", col)

    # Neon signposting for the shortcuts
    neon_sign(Vector((STAIR_X - STAIR_HW - 0.5, -158.0, 0)), Vector((1, 0, 0)), stairs_z[0], word="STEPS", color=(1.0, 0.15, 0.4), vertical=True, height=2.8)
    neon_sign(Vector((4.5, -320.0, 0)), Vector((-1, 0, 0)), alley_z[0], word="NEEDLE", color=(0.15, 0.9, 1.0), vertical=True, height=2.5)
    neon_sign(Vector((-127.0, -470.0, 0)), Vector((1, 0, 0)), ZQ_N, word="DOCK", color=(1.0, 0.6, 0.1), vertical=True, height=2.0)
    neon_sign(Vector((-7.5, 40.0, 0)), Vector((1, 0, 0)), start.z, word="LUCKY LANTERN", color=(1.0, 0.2, 0.15), vertical=False, height=4.2)
    add_light("point", start + Vector((-4.0, 0, 3.0)), (1.0, 0.45, 0.25), 200.0, 1400.0, fog=1.0)

    skyline()
    boats()
    ground_fill()

    # Ground slab far below everything (falling through a gap ends in the "water" check).
    B = chunk_for(0, 0)
    B.poly_facing([(X0, Y0, -6.0), (X1, Y0, -6.0), (X1, Y1, -6.0), (X0, Y1, -6.0)], (0, 0, 1), "M_Concrete")

    # ---- export geometry --------------------------------------------------------------------------------
    chunk_list = []
    for key, b in sorted(chunks.items()):
        if not b.faces:
            continue
        obj = b.build()
        kit.shade_flat(obj)
        kit.export_fbx([obj], b.name + ".fbx")
        kit.export_glb([obj], b.name)
        bpy_remove(obj)
        chunk_list.append({"mesh": b.name, "collide": key[2] == "s", "shadow": True})
        print("MC_CHUNK", b.name, len(b.verts), len(b.faces), len(b.materials))

    # ---- gameplay data ----------------------------------------------------------------------------------
    def route_main():
        pts = []
        fr2 = main.frames()
        speeds = []
        marks = main.marks
        for i, (p, t, l) in enumerate(fr2):
            if i % 6 and i != len(fr2) - 1:
                continue
            # curvature-based target speed
            a = fr2[max(0, i - 6)][1]
            b = fr2[min(len(fr2) - 1, i + 6)][1]
            turn = math.acos(max(-1.0, min(1.0, a.dot(b))))
            curv = turn / 12.0
            v = 15.0 if curv < 1e-3 else min(15.0, math.sqrt(4.2 / curv))
            pts.append([*ue(p), round(v, 1), 0])
        # final approach: slow to a stop at the hotel
        out = []
        for q in pts:
            d = math.dist((q[0], q[1]), (goal.x * 100, -goal.y * 100)) / 100.0
            q[3] = round(min(q[3], max(1.5, d * 0.45)), 1)
            out.append(q)
            if d < 1.0:
                break
        return out

    def splice(prefix_until_y, mid, suffix_from_xy, pts_main):
        return None

    main_pts = route_main()

    # Shortcut route: Crown St -> Lantern Steps -> Market -> Needle Alley -> Lamp Hill -> kicker -> Pier Lane.
    short = []
    for q in main_pts:
        if -q[1] / 100.0 > -150.0:
            short.append(q)
    for (x, y, z_) in stairs_route:
        short.append([*ue((x, y, z_ + 0.1)), 7.0, 1])
    for q in main_pts:
        yb = -q[1] / 100.0
        xb = q[0] / 100.0
        if -300.0 < yb < -208.0 and abs(xb) < 3:
            short.append(q)
    for (p, is_stair) in alley_route:
        short.append([*ue(p), 6.0 if is_stair else 7.5, 1 if is_stair else 0])
    lamp_x = -110.0
    for yb in (-442.0, -452.0, -460.0, -466.0):
        short.append([*ue((lamp_x, yb, street_at(lamp_x, yb) or 18.0)), 16.0, 0])
    short.append([*ue((lamp_x, -490.0, ZQ_S)), 13.0, 1])
    short.append([*ue((lamp_x, -500.0, ZQ_S)), 11.0, 0])
    for q in main_pts:
        if -q[1] / 100.0 < -505.0:
            short.append(q)

    cps = [
        {"name": "Market Street", "pos": ue((0.0, -232.0, street_at(0.0, -232.0))), "yaw": 90.0, "radius": 900.0},
        {"name": "Lamp Hill", "pos": ue((-110.0, -444.0, street_at(-110.0, -444.0))), "yaw": 90.0, "radius": 900.0},
        {"name": "Pier Lane", "pos": ue((-110.0, -522.0, street_at(-110.0, -522.0))), "yaw": 90.0, "radius": 900.0},
        {"name": "Hotel Marlowe", "pos": ue(goal), "yaw": 90.0, "radius": 450.0},
    ]

    # Minimap strokes (UE cm, XY only).
    def stroke(points, kind):
        return {"kind": kind, "pts": [[round(p[0] * 100), round(-p[1] * 100)] for p in points]}
    mp = [stroke([(p.x, p.y) for p in main.pts[::3]], 0)]
    mp.append(stroke([(STAIR_X, -153.5), (STAIR_X, -206.0)], 1))
    mp.append(stroke([(p.x, p.y) for p, _ in alley_route], 2))
    mp.append(stroke([(-110.0, -458.0), (-110.0, -500.0)], 4))
    mp.append(stroke([(X0, CANAL_N), (X1, CANAL_N)], 3))
    mp.append(stroke([(X0, CANAL_S), (X1, CANAL_S)], 3))
    mp.append(stroke([(-230, HARBOUR_Y), (170, HARBOUR_Y)], 3))

    level = {
        "water": [
            [X0 * 100, -CANAL_N * 100, X1 * 100, -CANAL_S * 100, WATER_CANAL * 100],
            [-3000 * 100, -HARBOUR_Y * 100, 3000 * 100, 300000, 0.0],
        ],
        "start": {"pos": ue((start.x, start.y, start.z)), "yaw": 90.0},
        "checkpoints": cps,
        "chunks": chunk_list,
        "props": [],
        "lights": lights,
        "routes": {"main": main_pts, "short": short},
        "map": mp,
        "kicker": ue(kicker),
    }
    kit.write_json(os.path.join(kit.EXPORT_DIR, "level.json"), level)
    kinds = {}
    for L in lights:
        kinds[L["kind"]] = kinds.get(L["kind"], 0) + 1
    print("MC_LIGHTS", kinds, "shadowed", sum(1 for L in lights if L["shadow"]))
    print("MC_LEVEL lights", len(lights), "chunks", len(chunk_list), "buildings", len(buildings), "main pts", len(main_pts), "short pts", len(short))
    print("MC_HEIGHTS stairs", stairs_z, "alley", alley_z, "kickerN", ZQ_N, "landS", ZQ_S, "goal", tuple(goal))


def bpy_remove(obj):
    import bpy
    me = obj.data
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(me)


if __name__ == "__main__":
    main_build()
