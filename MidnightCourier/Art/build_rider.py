"""The courier: one skinned character (body, clothes, helmet, harness) with a small skeleton that the game
poses every frame (AMcBike::UpdateRider drives each bone from two-bone IK to the pedals and grips).

The body is grown from a joint graph with Blender's Skin modifier, subdivided and smoothed, then painted by
region (vertex colour, alpha = roughness). Modelled in the riding rest pose, in the bike frame's space
(origin between the hubs, X forward, Z up, +Y = rider's left).

Run: Blender -b --factory-startup --python Art/build_rider.py   -> Art/Export/SK_Rider.fbx
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mc import kit

# ---- rest pose (metres, frame space) — mirrors the constants in AMcBike::UpdateRider -------------------
SEAT = Vector((-0.20, 0.0, 0.58))
BARS = Vector((0.44, 0.0, 0.64))
BB = Vector((0.02, 0.0, -0.18))
CRANK = 0.17
THIGH, SHIN, UPPER, FORE, TORSO = 0.44, 0.44, 0.30, 0.28, 0.56

HIP = SEAT + Vector((0, 0, 0.06))
LEAN = math.radians(38.0)
TDIR = Vector((math.cos(LEAN), 0, math.sin(LEAN)))
NECK = HIP + TDIR * TORSO
BACK = TDIR.cross(Vector((0, 1, 0))).normalized()      # points up-and-back (the rider's back)


def ik(a, target, l1, l2, hint):
    d = target - a
    dist = max(min(d.length, (l1 + l2) * 0.999), abs(l1 - l2) + 0.01)
    dn = d.normalized()
    cos_a = max(-1, min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)))
    sin_a = math.sqrt(1 - cos_a * cos_a)
    perp = (hint - dn * hint.dot(dn)).normalized()
    return a + dn * (cos_a * l1) + perp * (sin_a * l1)


J = {}
J["root"] = Vector((0, 0, 0))
J["pelvis"] = HIP
J["spine"] = HIP + TDIR * 0.20
J["chest"] = HIP + TDIR * 0.38
J["neck"] = NECK - TDIR * 0.02
J["head"] = NECK + TDIR * 0.04 + Vector((0, 0, 0.05))
J["head_end"] = J["head"] + Vector((0.03, 0, 0.22))
for side, s in (("l", 1), ("r", -1)):
    # crank level: left pedal forward, right pedal back
    pedal = BB + Vector((CRANK * s, 0.11 * s, 0.0))
    foot = pedal + Vector((-0.03, 0.02 * s, 0.05))
    hip = HIP + Vector((0, 0.10 * s, 0))
    knee = ik(hip, foot, THIGH, SHIN, Vector((1, 0.15 * s, 0.4)))
    J[f"thigh_{side}"] = hip
    J[f"shin_{side}"] = knee
    J[f"foot_{side}"] = foot
    J[f"toe_{side}"] = foot + Vector((0.16, 0, -0.04))
    sh = NECK - TDIR * 0.05 + Vector((0, 0.18 * s, 0))
    grip = BARS + Vector((0, 0.27 * s, 0))
    elbow = ik(sh, grip, UPPER, FORE, Vector((-0.3, 0.8 * s, -0.5)))
    J[f"upperarm_{side}"] = sh
    J[f"forearm_{side}"] = elbow
    J[f"hand_{side}"] = grip
    J[f"hand_end_{side}"] = grip + Vector((0.09, 0, -0.01))

# Bones: (name, head joint, tail joint, parent)
BONES = [
    ("root", "root", None, None),
    ("pelvis", "pelvis", "spine", "root"),
    ("spine", "spine", "chest", "pelvis"),
    ("chest", "chest", "neck", "spine"),
    ("neck", "neck", "head", "chest"),
    ("head", "head", "head_end", "neck"),
]
for side in ("l", "r"):
    BONES += [
        (f"thigh_{side}", f"thigh_{side}", f"shin_{side}", "pelvis"),
        (f"shin_{side}", f"shin_{side}", f"foot_{side}", f"thigh_{side}"),
        (f"foot_{side}", f"foot_{side}", f"toe_{side}", f"shin_{side}"),
        (f"upperarm_{side}", f"upperarm_{side}", f"forearm_{side}", "chest"),
        (f"forearm_{side}", f"forearm_{side}", f"hand_{side}", f"upperarm_{side}"),
        (f"hand_{side}", f"hand_{side}", f"hand_end_{side}", f"forearm_{side}"),
    ]

# ---- palette (sRGB, alpha = roughness) --------------------------------------------------------------
JACKET = (0.96, 0.67, 0.06, 0.38)
JACKET_SHADOW = (0.78, 0.5, 0.03, 0.42)
STRIPE = (0.86, 0.88, 0.92, 0.12)
PANTS = (0.07, 0.08, 0.11, 0.72)
PANTS_SEAM = (0.04, 0.045, 0.06, 0.75)
SHOE = (0.16, 0.16, 0.18, 0.55)
SOLE = (0.88, 0.86, 0.82, 0.7)
ACCENT = (0.0, 0.7, 0.65, 0.4)
GLOVE = (0.04, 0.04, 0.045, 0.6)
SKIN = (0.62, 0.42, 0.31, 0.55)
HELMET = (0.92, 0.92, 0.94, 0.18)
HELMET_DARK = (0.06, 0.06, 0.07, 0.35)
VISOR = (0.02, 0.025, 0.03, 0.04)
STRAP = (0.03, 0.03, 0.035, 0.6)


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length, t


def body_mesh():
    """Skin-modifier body from the joint graph."""
    verts, edges, radii = [], [], []

    def v(p, r):
        verts.append(Vector(p))
        radii.append(r)
        return len(verts) - 1

    pel = v(J["pelvis"] + BACK * 0.01, (0.15, 0.17))
    spi = v(J["spine"], (0.135, 0.15))
    che = v(J["chest"], (0.15, 0.19))
    upc = v(J["chest"] + TDIR * 0.1, (0.12, 0.19))
    nek = v(J["neck"] + TDIR * 0.03, (0.055, 0.06))
    hed = v(J["head"] + Vector((0.02, 0, 0.09)), (0.1, 0.085))
    top = v(J["head"] + Vector((0.035, 0, 0.19)), (0.06, 0.05))
    edges += [(pel, spi), (spi, che), (che, upc), (upc, nek), (nek, hed), (hed, top)]
    for side in ("l", "r"):
        s = 1 if side == "l" else -1
        hp = v(J[f"thigh_{side}"] + Vector((0, 0, -0.03)), (0.095, 0.095))
        mt = v(J[f"thigh_{side}"].lerp(J[f"shin_{side}"], 0.5), (0.075, 0.08))
        kn = v(J[f"shin_{side}"], (0.06, 0.065))
        mc = v(J[f"shin_{side}"].lerp(J[f"foot_{side}"], 0.45), (0.058, 0.06))
        an = v(J[f"foot_{side}"] + Vector((0, 0, 0.03)), (0.048, 0.05))
        hl = v(J[f"foot_{side}"] + Vector((-0.04, 0, -0.04)), (0.05, 0.048))
        to = v(J[f"toe_{side}"] + Vector((0, 0, -0.005)), (0.046, 0.038))
        edges += [(pel, hp), (hp, mt), (mt, kn), (kn, mc), (mc, an), (an, hl), (hl, to)]
        sh = v(J[f"upperarm_{side}"], (0.065, 0.065))
        mu = v(J[f"upperarm_{side}"].lerp(J[f"forearm_{side}"], 0.5), (0.055, 0.055))
        el = v(J[f"forearm_{side}"], (0.048, 0.048))
        mf = v(J[f"forearm_{side}"].lerp(J[f"hand_{side}"], 0.55), (0.048, 0.044))
        wr = v(J[f"hand_{side}"] - Vector((0.03, 0, 0)), (0.036, 0.04))
        hd = v(J[f"hand_end_{side}"], (0.04, 0.032))
        edges += [(upc, sh), (sh, mu), (mu, el), (el, mf), (mf, wr), (wr, hd)]

    me = bpy.data.meshes.new("Body")
    me.from_pydata([tuple(p) for p in verts], edges, [])
    ob = bpy.data.objects.new("Body", me)
    bpy.context.scene.collection.objects.link(ob)
    skin = ob.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    skin.branch_smoothing = 0.6
    for i, r in enumerate(radii):
        ob.data.skin_vertices[0].data[i].radius = r
    ob.data.skin_vertices[0].data[0].use_root = True
    sub = ob.modifiers.new("Sub", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Skin")
    bpy.ops.object.modifier_apply(modifier="Sub")
    return ob


def paint_body(ob):
    """Region colours from the nearest bone segment."""
    me = ob.data
    segs = []
    for name, h, t, parent in BONES:
        if t:
            segs.append((name, J[h], J[t]))
    col = me.color_attributes.new("Col", 'BYTE_COLOR', 'CORNER')
    vcol = []
    for v in me.vertices:
        p = v.co
        best, bname, bt = 1e9, None, 0.0
        for name, a, b in segs:
            d, t = seg_dist(p, a, b)
            if d < best:
                best, bname, bt = d, name, t
        c = JACKET
        if bname.startswith(("thigh", "shin")):
            c = PANTS
            # cargo pocket + seam darker bands
            if bname.startswith("thigh") and 0.45 < bt < 0.75 and (p.y * (1 if bname.endswith("l") else -1)) > 0.0:
                c = PANTS_SEAM
            if bname.startswith("shin") and bt > 0.88:
                c = PANTS_SEAM
        elif bname.startswith("foot"):
            side = 1 if bname.endswith("l") else -1
            c = SHOE
            if p.z < J[f"foot_{'l' if side > 0 else 'r'}"].z - 0.055:
                c = SOLE
            elif 0.3 < bt < 0.5:
                c = ACCENT
        elif bname.startswith("hand"):
            c = GLOVE
        elif bname.startswith("forearm"):
            c = JACKET if bt < 0.8 else GLOVE
            if 0.25 < bt < 0.36:
                c = STRIPE
        elif bname.startswith("upperarm"):
            c = JACKET_SHADOW if bt < 0.12 else JACKET
            if 0.55 < bt < 0.66:
                c = STRIPE
        elif bname in ("neck",):
            c = SKIN if (p - J["neck"]).dot(Vector((1, 0, 0))) > 0.0 else JACKET_SHADOW
        elif bname == "head":
            c = SKIN
        elif bname in ("spine", "chest"):
            # reflective bands round the torso
            along = (p - HIP).dot(TDIR)
            c = STRIPE if (0.30 < along < 0.335 or 0.41 < along < 0.445) else JACKET
        elif bname == "pelvis":
            along = (p - HIP).dot(TDIR)
            c = PANTS if along < 0.07 else JACKET
        vcol.append(c)
    data = []
    for poly in me.polygons:
        for li in poly.loop_indices:
            data.extend(vcol[me.loops[li].vertex_index])
    col.data.foreach_set("color", data)
    me.materials.append(bpy.data.materials.get("M_VC") or bpy.data.materials.new("M_VC"))


def accessories():
    """Helmet, glasses, hood, harness straps, cuffs, a jacket hem — weighted rigidly later."""
    parts = []
    # helmet
    b = kit.MeshBuilder("Helmet")
    hc = J["head"] + Vector((0.02, 0, 0.12))
    b.sphere(hc, 0.142, "M_VC", HELMET, seg=28, rings=16, scale=(1.18, 0.98, 0.86), zmin=-0.2)
    b.sphere(hc + Vector((-0.01, 0, -0.005)), 0.146, "M_VC", HELMET_DARK, seg=28, rings=3, scale=(1.18, 0.98, 0.25), zmin=-0.55)  # rim band
    for k in range(5):
        y = -0.05 + 0.025 * k
        b.box(hc + Vector((0.0, y, 0.115)), (0.17, 0.012, 0.03), "M_VC", HELMET_DARK)
    b.box(hc + Vector((-0.16, 0, -0.01)), (0.02, 0.06, 0.025), "M_Glow", (1.0, 0.08, 0.04, 1))
    # wrap glasses
    b.sphere(J["head"] + Vector((0.07, 0, 0.11)), 0.1, "M_VC", VISOR, seg=20, rings=6, scale=(0.75, 1.0, 0.3))
    b.box(J["head"] + Vector((0.02, 0, 0.05)), (0.03, 0.12, 0.012), "M_VC", STRAP)   # chin strap
    parts.append(("head", b))
    # hood bunched behind the neck, a teal neck gaiter pulled up over the nose
    b = kit.MeshBuilder("Hood")
    b.sphere(J["neck"] + BACK * 0.075 + TDIR * 0.015, 0.085, "M_VC", JACKET_SHADOW, seg=16, rings=8, scale=(0.85, 1.25, 0.6))
    parts.append(("chest", b))
    b = kit.MeshBuilder("Gaiter")
    hc = J["head"] + Vector((0.035, 0, 0.035))
    b.sphere(hc, 0.083, "M_VC", (0.05, 0.42, 0.42, 0.7), seg=20, rings=10, scale=(1.05, 1.0, 0.75))
    for k in range(3):
        b.torus(hc + Vector((0, 0, -0.03 + 0.025 * k)), (0, 0, 1), 0.08 - 0.004 * k, 0.006, "M_VC", (0.03, 0.32, 0.32, 0.7), seg=20, tube=5)
    parts.append(("head", b))
    # harness: flat shoulder straps hugging the jacket, down to the carrier frame
    b = kit.MeshBuilder("Harness")
    for s in (1, -1):
        pts = [J["spine"] + Vector((0, 0.1 * s, 0)) - BACK * 0.128,
               J["chest"] + TDIR * 0.08 + Vector((0, 0.11 * s, 0)) - BACK * 0.14,
               J["chest"] + TDIR * 0.2 + Vector((0, 0.115 * s, 0)) - BACK * 0.02,
               J["chest"] + TDIR * 0.17 + Vector((0, 0.11 * s, 0)) + BACK * 0.13]
        for k in range(len(pts) - 1):
            b.cylinder(pts[k], pts[k + 1], 0.016, "M_VC", STRAP, seg=8)
    parts.append(("chest", b))
    # jacket hem flaring over the hips
    b = kit.MeshBuilder("Hem")
    b.torus(HIP + TDIR * 0.07, TDIR, 0.155, 0.025, "M_VC", JACKET_SHADOW, seg=24, tube=6)
    parts.append(("pelvis", b))
    # glove cuffs, ankle cuffs
    for side in ("l", "r"):
        b = kit.MeshBuilder(f"Cuff_{side}")
        d = (J[f"hand_{side}"] - J[f"forearm_{side}"]).normalized()
        b.torus(J[f"hand_{side}"] - d * 0.06, d, 0.04, 0.012, "M_VC", GLOVE, seg=14, tube=6)
        parts.append((f"forearm_{side}", b))
        b = kit.MeshBuilder(f"Lace_{side}")
        f = J[f"foot_{side}"]
        for k in range(3):
            b.box(f + Vector((0.04 + 0.03 * k, 0, 0.0)), (0.012, 0.05, 0.008), "M_VC", SOLE)
        parts.append((f"foot_{side}", b))
    return parts


def build():
    kit.reset_scene()
    for m in ("M_VC", "M_VCMetal", "M_Glow"):
        bpy.data.materials.new(m)
    body = body_mesh()
    paint_body(body)
    for p in body.data.polygons:
        p.use_smooth = True

    # Armature
    arm_data = bpy.data.armatures.new("RiderSkel")
    arm = bpy.data.objects.new("SK_Rider", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    for name, h, t, parent in BONES:
        b = eb.new(name)
        b.head = J[h]
        b.tail = J[t] if t else J[h] + Vector((0, 0, 0.1))
        if name == "root":
            b.tail = Vector((0, 0, 0.1))
        b.roll = 0.0
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')

    # Skin the body with heat weights.
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    root_group = body.vertex_groups.get("root")
    if root_group:
        body.vertex_groups.remove(root_group)
    bad = sum(1 for v in body.data.vertices if not v.groups)
    print("MC_RIDER verts", len(body.data.vertices), "unweighted", bad)

    # Rigid accessories: each fully weighted to one bone, then joined into the body.
    objs = []
    for bone, builder in accessories():
        o = builder.build()
        for p in o.data.polygons:
            p.use_smooth = True
        vg = o.vertex_groups.new(name=bone)
        vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
        objs.append(o)
    # Unweighted body verts (if heat failed somewhere) go to the nearest bone.
    if bad:
        for v in body.data.vertices:
            if v.groups:
                continue
            best, bn = 1e9, "pelvis"
            for name, h, t, parent in BONES:
                if not t:
                    continue
                d, _ = seg_dist(v.co, J[h], J[t])
                if d < best:
                    best, bn = d, name
            g = body.vertex_groups.get(bn) or body.vertex_groups.new(name=bn)
            g.add([v.index], 1.0, 'REPLACE')
    # The accessory builder makes its own colour layer "Col" and UV layers; give the body matching UVs.
    body.data.uv_layers.new(name="UV0")
    body.data.uv_layers.new(name="UV1")
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    mod = body.modifiers.get("Armature") or body.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    body.parent = None          # scale each object on its own (a parented child would be scaled twice)
    body.name = "SK_Rider_Mesh"

    # The browser version takes the same skinned rider as glTF, in metres.
    body.parent = arm
    kit.export_glb([arm, body], "SK_Rider")
    body.parent = None

    # Unreal wants centimetre-scale bones: scale x100 and apply, scene unit 0.01, FBX_SCALE_ALL on export.
    scene = bpy.context.scene
    scene.unit_settings.scale_length = 0.01
    for o in (arm, body):
        o.scale = (100, 100, 100)
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    body.parent = arm
    os.makedirs(kit.EXPORT_DIR, exist_ok=True)
    path = os.path.join(kit.EXPORT_DIR, "SK_Rider.fbx")
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={'ARMATURE', 'MESH'},
                             mesh_smooth_type='FACE', use_tspace=False, add_leaf_bones=False,
                             primary_bone_axis='Y', secondary_bone_axis='X', bake_anim=False,
                             colors_type='SRGB', apply_scale_options='FBX_SCALE_ALL', apply_unit_scale=True,
                             global_scale=1.0, axis_forward='-Z', axis_up='Y', use_mesh_modifiers=False,
                             use_armature_deform_only=False)
    print("MC_RIDER exported", path, "tris~", len(body.data.polygons))


if __name__ == "__main__":
    build()
