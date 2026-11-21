"""Bike, rider parts, the package, and a few effect meshes (rain streaks, goal beacon).

Run: Blender -b --factory-startup --python Art/build_bike.py
Every part is modelled around the pivot the game animates it about (see AMcBike::UpdateRider):
limbs extend along +X from their proximal joint, the frame is centred between the wheel hubs.
Vertex colour alpha carries roughness for the M_VC / M_VCMetal materials.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector, Matrix
from mc import kit

FONT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Content", "Courier", "Fonts", "Anton-Regular.ttf")

# Bike geometry (metres, frame space; must match AMcBike's constants)
HUB_Z = -0.075           # hubs sit (Ext - Sag) below the body centre
HALF_BASE = 0.525
WHEEL_R = 0.34
BB = Vector((0.02, 0.0, -0.18))
SEAT = Vector((-0.20, 0.0, 0.58))
BARS = Vector((0.44, 0.0, 0.64))
HEAD_TOP = Vector((0.36, 0.0, 0.44))
HEAD_BOT = Vector((0.40, 0.0, 0.26))
SEAT_CLUSTER = Vector((-0.15, 0.0, 0.42))
REAR_HUB = Vector((-HALF_BASE, 0.0, HUB_Z))
FRONT_HUB = Vector((HALF_BASE, 0.0, HUB_Z))

PAINT = (0.62, 0.07, 0.05, 0.3)
PAINT_DARK = (0.18, 0.02, 0.02, 0.4)
BLACK = (0.025, 0.025, 0.028, 0.75)
RUBBER = (0.03, 0.03, 0.03, 0.85)
STEEL = (0.62, 0.62, 0.65, 0.25)
CHROME = (0.8, 0.8, 0.82, 0.12)
SADDLE = (0.05, 0.045, 0.04, 0.55)
REFLECT = (0.9, 0.85, 0.6, 0.35)

JACKET = (0.95, 0.66, 0.05, 0.42)
JACKET_DARK = (0.7, 0.45, 0.03, 0.5)
STRIPE = (0.85, 0.87, 0.9, 0.15)
PANTS = (0.05, 0.055, 0.07, 0.7)
SHOE = (0.1, 0.1, 0.11, 0.6)
SOLE = (0.85, 0.85, 0.85, 0.7)
GLOVE = (0.03, 0.03, 0.03, 0.6)
HELMET = (0.9, 0.9, 0.92, 0.2)
VISOR = (0.02, 0.02, 0.025, 0.05)
SKIN = (0.55, 0.37, 0.26, 0.6)

CARD = (0.58, 0.4, 0.21, 0.85)
CARD_DARK = (0.45, 0.3, 0.15, 0.85)
TAPE = (0.78, 0.06, 0.04, 0.35)
INK = (0.04, 0.03, 0.03, 0.8)


def tube(b, a, c, r, color=PAINT, mat="M_VC", seg=16, r1=None):
    b.cylinder(a, c, r, mat, color, seg=seg, r1=r1)


def build_frame():
    b = kit.MeshBuilder("SM_BikeFrame")
    tube(b, BB, SEAT_CLUSTER, 0.018)                         # seat tube
    tube(b, SEAT_CLUSTER, HEAD_TOP, 0.017)                   # top tube
    tube(b, BB, HEAD_BOT, 0.024, r1=0.021)                   # down tube (tapered)
    for j in (BB, SEAT_CLUSTER, HEAD_TOP, HEAD_BOT):
        b.sphere(j, 0.024, "M_VC", PAINT, seg=12, rings=8)  # welds
    tube(b, HEAD_BOT + Vector((0.01, 0, -0.03)), HEAD_TOP + Vector((-0.01, 0, 0.03)), 0.022, PAINT_DARK)  # head tube
    for side in (-1, 1):
        y = Vector((0, 0.055 * side, 0))
        tube(b, BB + y * 0.5, REAR_HUB + y, 0.011)            # chain stays
        tube(b, SEAT_CLUSTER + y * 0.4, REAR_HUB + y, 0.01)   # seat stays
    b.cylinder(BB + Vector((0, -0.045, 0)), BB + Vector((0, 0.045, 0)), 0.024, "M_VCMetal", STEEL, seg=12)  # BB shell
    # seat post + saddle
    tube(b, SEAT_CLUSTER, SEAT + Vector((0.01, 0, -0.02)), 0.0135, STEEL, "M_VCMetal")
    b.sphere(SEAT + Vector((0.03, 0, 0.0)), 0.06, "M_VC", SADDLE, seg=16, rings=8, scale=(2.2, 0.75, 0.42))   # nose
    b.sphere(SEAT + Vector((-0.06, 0, 0.005)), 0.075, "M_VC", SADDLE, seg=16, rings=8, scale=(1.0, 1.0, 0.4))  # rear
    b.box(SEAT + Vector((-0.02, 0, -0.03)), (0.14, 0.03, 0.02), "M_VCMetal", STEEL)                           # rails
    # rear mudguard (rain!) and tail light
    seg = 14
    for i in range(seg):
        a0 = math.radians(20 + 120 * i / seg)
        a1 = math.radians(20 + 120 * (i + 1) / seg)
        R = WHEEL_R + 0.035
        p0 = REAR_HUB + Vector((-math.cos(a0) * R, 0, math.sin(a0) * R))
        p1 = REAR_HUB + Vector((-math.cos(a1) * R, 0, math.sin(a1) * R))
        w = Vector((0, 0.03, 0))
        b.poly([p0 - w, p1 - w, p1 + w, p0 + w], "M_VC", BLACK)
        b.poly([p0 + w, p1 + w, p1 - w, p0 - w], "M_VC", BLACK)
    b.box(Vector((-0.62, 0, 0.30 + HUB_Z + 0.075)), (0.03, 0.05, 0.035), "M_Glow", (1.0, 0.04, 0.02, 1))
    b.box(Vector((-0.605, 0, 0.30 + HUB_Z + 0.075)), (0.02, 0.06, 0.05), "M_VC", BLACK)
    # chainring guard + chain line
    b.cylinder(REAR_HUB + Vector((0, -0.06, 0)), REAR_HUB + Vector((0, -0.07, 0)), 0.045, "M_VCMetal", STEEL, seg=14)
    for side in (1, -1):
        top = 0.10 if side > 0 else -0.10
        tube(b, BB + Vector((0, -0.06, top)), REAR_HUB + Vector((0, -0.065, top * 0.45)), 0.004, BLACK, "M_VCMetal", 6)
    # chain: links around the chainring and the rear cog
    ring_c, ring_r = BB + Vector((0, -0.07, 0)), 0.10
    cog_c, cog_r = REAR_HUB + Vector((0, -0.065, 0)), 0.04
    def chain_pt(t):
        # perimeter of the two circles joined by tangent lines (approximation: top and bottom runs)
        top0 = ring_c + Vector((0, 0, ring_r))
        top1 = cog_c + Vector((0, 0, cog_r))
        bot1 = cog_c - Vector((0, 0, cog_r))
        bot0 = ring_c - Vector((0, 0, ring_r))
        segs = [(top0, top1), (bot1, bot0)]
        return segs
    for (pa, pb) in chain_pt(0):
        n = int((pb - pa).length / 0.0127)
        for k in range(n):
            q = pa.lerp(pb, (k + 0.5) / n)
            b.box(q, (0.0127, 0.008, 0.007), "M_VCMetal", (0.35, 0.33, 0.3, 0.3), rot=Matrix.Rotation(math.atan2(pb.z - pa.z, pb.x - pa.x) * -1, 3, 'Y'))
    for c, r in ((ring_c, ring_r), (cog_c, cog_r)):
        n = int(2 * math.pi * r / 0.0127)
        for k in range(n):
            a = 2 * math.pi * k / n
            if c is ring_c and math.cos(a) > 0.2 or c is cog_c and math.cos(a) < -0.2:
                continue
            b.box(c + Vector((math.cos(a) * r, 0, math.sin(a) * r)), (0.0127, 0.008, 0.007), "M_VCMetal", (0.35, 0.33, 0.3, 0.3))
    # rear derailleur + rim brake caliper + cables
    b.box(REAR_HUB + Vector((0.0, -0.075, -0.06)), (0.03, 0.02, 0.07), "M_VCMetal", BLACK)
    b.box(REAR_HUB + Vector((-0.02, 0.0, WHEEL_R - 0.005)), (0.04, 0.09, 0.035), "M_VCMetal", STEEL)
    b.cylinder(HEAD_TOP + Vector((0.0, 0.02, 0.02)), SEAT_CLUSTER + Vector((0.02, 0.02, 0.01)), 0.003, "M_VC", BLACK, seg=5)
    b.cylinder(SEAT_CLUSTER + Vector((-0.03, 0.02, 0.0)), REAR_HUB + Vector((-0.02, 0.02, WHEEL_R)), 0.003, "M_VC", BLACK, seg=5)
    # water bottle
    tube(b, BB + Vector((0.14, 0, 0.16)), BB + Vector((0.24, 0, 0.32)), 0.035, (0.1, 0.5, 0.55, 0.3))
    return b


def build_fork():
    """Origin at the front hub. Fork, headset, stem, flat bars, light, mudguard."""
    b = kit.MeshBuilder("SM_BikeFork")
    hb = HEAD_BOT - FRONT_HUB      # head tube bottom relative to the hub
    bars = BARS - FRONT_HUB
    for side in (-1, 1):
        y = Vector((0, 0.05 * side, 0))
        crown = hb + Vector((0, 0.04 * side, -0.02))
        tube(b, y, crown, 0.013, PAINT)
    b.box(hb + Vector((0, 0, -0.02)), (0.05, 0.12, 0.03), "M_VC", PAINT)
    steer_top = HEAD_TOP - FRONT_HUB + Vector((-0.01, 0, 0.05))
    tube(b, hb, steer_top, 0.015, STEEL, "M_VCMetal")
    tube(b, steer_top, bars + Vector((-0.02, 0, -0.01)), 0.016, BLACK, "M_VCMetal")
    tube(b, bars + Vector((0, -0.30, 0)), bars + Vector((0, 0.30, 0)), 0.012, BLACK, "M_VCMetal")
    for side in (-1, 1):
        tube(b, bars + Vector((0, 0.19 * side, 0)), bars + Vector((0, 0.31 * side, 0)), 0.017, RUBBER)   # grips
        tube(b, bars + Vector((0.0, 0.17 * side, 0.0)), bars + Vector((0.09, 0.2 * side, -0.02)), 0.005, STEEL, "M_VCMetal", 6)  # levers
    # front caliper and a bell
    b.box(Vector((0.0, 0.0, WHEEL_R + 0.01)), (0.04, 0.09, 0.035), "M_VCMetal", STEEL)
    b.cylinder(bars + Vector((-0.01, 0.13, 0.0)), bars + Vector((-0.01, 0.13, 0.035)), 0.026, "M_VCMetal", CHROME, r1=0.012, seg=14)
    b.cylinder(steer_top + Vector((0, 0, 0.01)), bars + Vector((-0.02, -0.18, 0.0)), 0.003, "M_VC", BLACK, seg=5)
    b.cylinder(steer_top + Vector((0, 0, 0.01)), bars + Vector((-0.02, 0.18, 0.0)), 0.003, "M_VC", BLACK, seg=5)
    # headlight on the fork crown
    lamp = hb + Vector((0.06, 0, 0.12))
    b.cylinder(lamp, lamp + Vector((0.06, 0, -0.005)), 0.032, "M_VC", BLACK, seg=14)
    b.cylinder(lamp + Vector((0.06, 0, -0.005)), lamp + Vector((0.064, 0, -0.005)), 0.028, "M_Glow", (1.0, 0.95, 0.85, 1), seg=14)
    # front mudguard
    seg = 12
    for i in range(seg):
        a0 = math.radians(30 + 100 * i / seg)
        a1 = math.radians(30 + 100 * (i + 1) / seg)
        R = WHEEL_R + 0.035
        p0 = Vector((math.cos(a0) * R * -1 + 0.0, 0, math.sin(a0) * R))
        p1 = Vector((math.cos(a1) * R * -1 + 0.0, 0, math.sin(a1) * R))
        p0.x, p1.x = -p0.x, -p1.x
        w = Vector((0, 0.03, 0))
        b.poly([p0 - w, p1 - w, p1 + w, p0 + w], "M_VC", BLACK)
        b.poly([p0 + w, p1 + w, p1 - w, p0 - w], "M_VC", BLACK)
    # hub
    b.cylinder((0, -0.05, 0), (0, 0.05, 0), 0.012, "M_VCMetal", STEEL, seg=8)
    return b


def build_wheel():
    """Origin at the hub, wheel in the XZ plane."""
    b = kit.MeshBuilder("SM_BikeWheel")
    Y = Vector((0, 1, 0))
    b.torus((0, 0, 0), Y, WHEEL_R - 0.018, 0.018, "M_VC", RUBBER, seg=64, tube=12)
    for k in range(56):
        a = 2 * math.pi * k / 56
        for side in (-1, 1):
            p = Vector((math.cos(a) * (WHEEL_R - 0.002), side * 0.008 * (1 if k % 2 else 0.4), math.sin(a) * (WHEEL_R - 0.002)))
            b.box(p, (0.012, 0.008, 0.006), "M_VC", RUBBER, rot=Matrix.Rotation(-a + math.pi / 2, 3, 'Y'))
    b.torus((0, 0, 0), Y, WHEEL_R - 0.042, 0.011, "M_VCMetal", CHROME, seg=64, tube=8)
    b.torus((0, 0, 0), Y, WHEEL_R - 0.052, 0.008, "M_VCMetal", (0.12, 0.12, 0.13, 0.3), seg=64, tube=6)
    b.torus((0, 0, 0), Y, WHEEL_R - 0.024, 0.0035, "M_VC", REFLECT, seg=40, tube=4)   # reflective sidewall band
    b.cylinder((0, -0.04, 0), (0, 0.04, 0), 0.016, "M_VCMetal", STEEL, seg=14)
    for side in (-1, 1):
        b.cylinder((0, side * 0.03, 0), (0, side * 0.038, 0), 0.03, "M_VCMetal", STEEL, seg=16)   # hub flanges
    n = 28
    for i in range(n):
        a = 2 * math.pi * i / n
        side = 0.035 if i % 2 == 0 else -0.035
        hub = Vector((math.cos(a + 0.2) * 0.02, side, math.sin(a + 0.2) * 0.02))
        rim = Vector((math.cos(a) * (WHEEL_R - 0.045), 0.0, math.sin(a) * (WHEEL_R - 0.045)))
        b.cylinder(hub, rim, 0.0018, "M_VCMetal", STEEL, seg=4, caps=False)
    # a single bright valve reflector so the spin reads
    b.box((0, 0.012, WHEEL_R - 0.07), (0.02, 0.006, 0.035), "M_Glow", (0.9, 0.5, 0.05, 1))
    return b


def build_crank():
    """Origin at the bottom bracket, rotates about Y. Arm toward +Z on the left (Blender +Y)."""
    b = kit.MeshBuilder("SM_BikeCrank")
    L = 0.17
    b.cylinder((0, -0.075, 0), (0, -0.065, 0), 0.10, "M_VCMetal", STEEL, seg=24)       # chainring (drive side)
    b.cylinder((0, -0.078, 0), (0, -0.062, 0), 0.04, "M_VCMetal", BLACK, seg=12)
    b.box((0, 0.10, L / 2), (0.03, 0.012, L), "M_VCMetal", CHROME)
    b.box((0, -0.10, -L / 2), (0.03, 0.012, L), "M_VCMetal", CHROME)
    b.cylinder((0, -0.105, 0), (0, 0.105, 0), 0.014, "M_VCMetal", STEEL, seg=8)
    return b


def build_pedal():
    b = kit.MeshBuilder("SM_BikePedal")
    b.box((0, 0, 0), (0.1, 0.09, 0.022), "M_VC", BLACK)
    b.box((-0.05, 0, 0), (0.008, 0.07, 0.016), "M_Glow", (0.9, 0.55, 0.05, 1))
    return b


# ---------------------------------------------------------------------------------------------------------
# Rider (rigid parts, posed in code)
# ---------------------------------------------------------------------------------------------------------
def limb(name, length, r0, r1, color, end=None):
    b = kit.MeshBuilder(name)
    b.cylinder((0, 0, 0), (length, 0, 0), r0, "M_VC", color, r1=r1, seg=12)
    b.sphere((0, 0, 0), r0 * 1.02, "M_VC", color, seg=10, rings=6)
    if end:
        end(b)
    return b


def build_torso():
    """Origin at the hip centre; +X up the spine (0.56 m to the neck); +Z out of the back, -Z the chest."""
    b = kit.MeshBuilder("SM_RiderTorso")
    # A stack of elliptical rings: hips -> waist -> chest -> shoulders.
    rings = [(0.00, 0.15, 0.105), (0.10, 0.14, 0.10), (0.22, 0.155, 0.115), (0.36, 0.18, 0.125), (0.47, 0.2, 0.12), (0.53, 0.16, 0.09), (0.58, 0.07, 0.06)]
    seg = 16
    ids = []
    for x, hw, hd in rings:
        pts = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            pts.append((x, math.cos(a) * hw, math.sin(a) * hd))
        ids.append(b.add_verts(pts))
    for j in range(len(rings) - 1):
        for i in range(seg):
            k = (i + 1) % seg
            col = JACKET if j < 5 else JACKET_DARK
            b.face([ids[j][i], ids[j][k], ids[j + 1][k], ids[j + 1][i]], "M_VC", col)
    b.face(list(reversed(ids[0])), "M_VC", PANTS)
    b.face(ids[-1], "M_VC", JACKET_DARK)
    # reflective chest + back stripes (catch the headlights of the city)
    for x in (0.27, 0.37):
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            hw = 0.17 + 0.012 * (x - 0.27) * 10
            ring.append((x, math.cos(a) * (hw + 0.004), math.sin(a) * (0.122 + 0.004)))
        r0 = b.add_verts(ring)
        r1 = b.add_verts([(p[0] + 0.03, p[1] * 1.01, p[2] * 1.01) for p in ring])
        for i in range(seg):
            k = (i + 1) % seg
            b.face([r0[i], r0[k], r1[k], r1[i]], "M_VC", STRIPE)
    # hood bunched at the neck, belt/pelvis wedge
    b.sphere((0.55, 0, 0.06), 0.09, "M_VC", JACKET_DARK, seg=10, rings=6, scale=(0.8, 1.4, 0.7))
    b.sphere((0.0, 0, 0.0), 0.13, "M_VC", PANTS, seg=12, rings=6, scale=(0.9, 1.2, 0.85))
    # harness straps to the package frame
    for side in (-1, 1):
        b.box((0.32, 0.1 * side, 0.0), (0.42, 0.035, 0.27), "M_VC", BLACK)
    return b


def build_pelvis():
    b = kit.MeshBuilder("SM_RiderPelvis")
    b.box((0.02, 0, -0.02), (0.06, 0.24, 0.12), "M_VC", PANTS)
    return b


def build_head():
    """Origin at the top of the neck. +X forward, +Z up."""
    b = kit.MeshBuilder("SM_RiderHead")
    b.cylinder((0, 0, -0.04), (0.02, 0, 0.07), 0.05, "M_VC", SKIN, seg=10)            # neck
    b.sphere((0.03, 0, 0.12), 0.095, "M_VC", SKIN, seg=14, rings=8, scale=(1.05, 0.9, 1.1))  # head
    b.sphere((0.02, 0, 0.15), 0.135, "M_VC", HELMET, seg=18, rings=10, scale=(1.15, 0.95, 0.85), zmin=-0.15)   # helmet shell
    b.box((0.13, 0, 0.13), (0.03, 0.17, 0.06), "M_VC", VISOR)                           # glasses / visor band
    b.box((-0.12, 0, 0.17), (0.02, 0.06, 0.02), "M_Glow", (1, 0.08, 0.04, 1))          # rear blinker on the helmet
    for i in range(5):
        y = -0.06 + 0.03 * i
        b.box((0.0, y, 0.245), (0.16, 0.01, 0.01), "M_VC", (0.2, 0.2, 0.22, 0.4))      # vents
    return b


def build_limbs():
    out = []
    out.append(limb("SM_RiderThigh", 0.44, 0.078, 0.058, PANTS))
    def ankle(b):
        b.box((0.44, 0, 0.0), (0.05, 0.11, 0.1), "M_VC", PANTS)
    out.append(limb("SM_RiderShin", 0.44, 0.056, 0.044, PANTS, ankle))
    foot = kit.MeshBuilder("SM_RiderFoot")
    foot.box((0.05, 0, -0.04), (0.25, 0.1, 0.08), "M_VC", SHOE)
    foot.box((0.05, 0, -0.085), (0.26, 0.105, 0.02), "M_VC", SOLE)
    foot.box((-0.02, 0, 0.0), (0.09, 0.09, 0.06), "M_VC", PANTS)
    out.append(foot)
    def shoulder(b):
        b.sphere((0, 0, 0), 0.068, "M_VC", JACKET, seg=10, rings=6)
        b.box((0.17, 0, 0.0), (0.04, 0.104, 0.104), "M_VC", STRIPE)
    out.append(limb("SM_RiderUpperArm", 0.30, 0.058, 0.048, JACKET, shoulder))
    def glove(b):
        b.sphere((0.29, 0, 0), 0.045, "M_VC", GLOVE, seg=10, rings=6, scale=(1.3, 0.9, 1.0))
        b.cylinder((0.22, 0, 0), (0.26, 0, 0), 0.046, "M_VC", JACKET_DARK, seg=10)
    out.append(limb("SM_RiderForeArm", 0.28, 0.046, 0.038, JACKET, glove))
    return out


def build_package():
    """Origin at the box centre. +X along the spine, +Z away from the back. A box in a carrier frame."""
    b = kit.MeshBuilder("SM_Package")
    L, Wd, D = 0.42, 0.44, 0.32       # along spine, width, depth
    bv = 0.012
    b.box((0, 0, 0.0), (L - 2 * bv, Wd - 2 * bv, D), "M_VC", CARD)
    b.box((0, 0, 0.0), (L, Wd - 2 * bv, D - 2 * bv), "M_VC", CARD)
    b.box((0, 0, 0.0), (L - 2 * bv, Wd, D - 2 * bv), "M_VC", CARD)
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.cylinder((sx * (L / 2 - bv), sy * (Wd / 2 - bv), -D / 2 + bv), (sx * (L / 2 - bv), sy * (Wd / 2 - bv), D / 2 - bv), bv, "M_VC", CARD, seg=6)
    # shipping label with a barcode on the outward face
    lab = Vector((-0.09, 0.1, D / 2 + 0.0025))
    b.box(lab, (0.12, 0.09, 0.002), "M_VC", (0.9, 0.9, 0.86, 0.6))
    for k in range(18):
        w = 0.002 + 0.002 * ((k * 7) % 3)
        b.box(lab + Vector((-0.045 + k * 0.005, -0.02, 0.0015)), (w, 0.035, 0.001), "M_VC", INK)
    for k in range(3):
        b.box(lab + Vector((-0.02 + 0.0, 0.022 - k * 0.012 + 0.0, 0.0015)), (0.07, 0.004, 0.001), "M_VC", (0.3, 0.3, 0.3, 0.7))
    # tape crosses
    b.box((0, 0, 0.0), (L + 0.004, 0.07, D + 0.004), "M_VC", TAPE, faces=("+z", "-z", "+x", "-x"))
    b.box((0, 0, 0.0), (0.07, Wd + 0.004, D + 0.004), "M_VC", TAPE, faces=("+z", "-z", "+y", "-y"))
    # carrier frame
    for side in (-1, 1):
        b.box((0, side * (Wd / 2 + 0.012), -D / 2 + 0.02), (L + 0.06, 0.02, 0.03), "M_VCMetal", BLACK)
        b.box((side * (L / 2 + 0.012), 0, -D / 2 + 0.02), (0.02, Wd + 0.04, 0.03), "M_VCMetal", BLACK)
    b.box((0, 0, D / 2 + 0.03), (0.04, Wd + 0.05, 0.02), "M_VC", BLACK)   # strap over the top
    # FRAGILE labels on the outward face and both sides
    M = Matrix.Translation((0.0, 0.0, D / 2 + 0.003)) @ Matrix.Rotation(math.radians(-90), 4, 'Z')
    kit.add_text(b, "FRAGILE", 0.09, 0.0015, M, "M_VC", TAPE, FONT)
    for side in (-1, 1):
        M = Matrix.Translation((0.0, side * (Wd / 2 + 0.003), 0.03)) @ Matrix.Rotation(math.radians(90 * side), 4, 'X') @ Matrix.Rotation(math.radians(-90 if side > 0 else 90), 4, 'Z')
        kit.add_text(b, "FRAGILE", 0.075, 0.0015, M, "M_VC", TAPE, FONT)
    # a little stemmed-glass icon on the top face
    g = Vector((0.12, 0.0, D / 2 + 0.004))
    b.box(g + Vector((0.0, 0, 0)), (0.008, 0.008, 0.002), "M_VC", INK)
    b.box(g + Vector((0.025, 0, 0)), (0.05, 0.004, 0.002), "M_VC", INK)
    b.box(g + Vector((0.06, 0, 0)), (0.025, 0.04, 0.002), "M_VC", INK)
    b.box(g + Vector((-0.012, 0, 0)), (0.004, 0.04, 0.002), "M_VC", INK)
    # "this way up" arrows
    for side in (-1, 1):
        a = Vector((-0.12, side * (Wd / 2 + 0.004), -0.05))
        b.box(a, (0.12, 0.002, 0.012), "M_VC", INK)
        b.box(a + Vector((0.06, 0, 0.02)), (0.04, 0.002, 0.012), "M_VC", INK, rot=Matrix.Rotation(math.radians(45 * side), 3, 'Y'))
    return b


def build_rain():
    """Rain: thousands of degenerate quads (all corners at the streak's anchor). The material expands each
    into a falling, camera-facing streak and wraps it inside a box that follows the camera."""
    b = kit.MeshBuilder("SM_RainStreaks")
    rnd = random.Random(7)
    N = 6000
    BX, BZ = 34.0, 18.0
    for _ in range(N):
        p = Vector((rnd.uniform(-BX / 2, BX / 2), rnd.uniform(-BX / 2, BX / 2), rnd.uniform(-BZ / 2, BZ / 2)))
        seed = rnd.random()
        # Small real quad (4 x 8 cm) so the importer keeps it; the material subtracts this offset again.
        corners = [(-0.5, 0), (0.5, 0), (0.5, 1), (-0.5, 1)]
        idx = b.add_verts([p + Vector((u * 0.04, 0, v * 0.08)) for u, v in corners])
        b.face(idx, "M_Rain", (seed, rnd.random(), 0, 1), uv0=corners)
    return b


def build_beacon():
    """An open tube of light rising from the drop-off. UV0.y = 0 at the ground, 1 at the top."""
    b = kit.MeshBuilder("SM_Beacon")
    seg = 24
    R, H = 1.4, 140.0
    lo = b.add_verts([(math.cos(2 * math.pi * i / seg) * R, math.sin(2 * math.pi * i / seg) * R, 0.0) for i in range(seg)])
    hi = b.add_verts([(math.cos(2 * math.pi * i / seg) * R * 1.6, math.sin(2 * math.pi * i / seg) * R * 1.6, H) for i in range(seg)])
    for i in range(seg):
        j = (i + 1) % seg
        u0, u1 = i / seg, (i + 1) / seg
        b.face([lo[i], lo[j], hi[j], hi[i]], "M_Beacon", (1, 1, 1, 1), uv0=[(u0, 0), (u1, 0), (u1, 1), (u0, 1)])
        b.face([hi[i], hi[j], lo[j], lo[i]], "M_Beacon", (1, 1, 1, 1), uv0=[(u0, 1), (u1, 1), (u1, 0), (u0, 0)])
    # ground ring
    rin = b.add_verts([(math.cos(2 * math.pi * i / seg) * 3.6, math.sin(2 * math.pi * i / seg) * 3.6, 0.03) for i in range(seg)])
    rout = b.add_verts([(math.cos(2 * math.pi * i / seg) * 4.0, math.sin(2 * math.pi * i / seg) * 4.0, 0.03) for i in range(seg)])
    for i in range(seg):
        j = (i + 1) % seg
        b.face([rin[i], rout[i], rout[j], rin[j]], "M_Beacon", (1, 1, 1, 1), uv0=[(0, 0.02)] * 4)
    return b


def main():
    kit.reset_scene()
    smooth_parts = []
    for builder, smooth in [
        (build_frame(), 35), (build_fork(), 35), (build_wheel(), 35), (build_crank(), 30), (build_pedal(), None),
        (build_torso(), 50), (build_pelvis(), None), (build_head(), 45), (build_package(), None),
        (build_rain(), None), (build_beacon(), 60),
    ] + [(l, 50) for l in build_limbs()]:
        kit.export_mesh(builder, smooth=smooth)
        print("MC_EXPORT", builder.name, len(builder.verts), len(builder.faces))


if __name__ == "__main__":
    main()
