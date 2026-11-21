"""Mesh-building kit for Midnight Courier's Blender scripts.

Geometry is accumulated in a MeshBuilder (vertices, faces, per-corner colours and UVs, material slots)
and turned into a Blender mesh only at the end, which keeps big generated meshes (the city) fast.
Units are metres; X forward, Y left, Z up (Blender). Unreal sees (x, -y, z) in centimetres.
"""
import math
import os
import json
import random

import bpy
from mathutils import Vector, Matrix

ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_DIR = os.path.join(ART, "Export")


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class MeshBuilder:
    """Collects polygons. Colours are stored as given (treated as sRGB by the exporter)."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []          # (vertex indices, material slot, colour, [uv0 per corner], [uv1 per corner])
        self.materials = []

    def slot(self, mat):
        if mat not in self.materials:
            self.materials.append(mat)
        return self.materials.index(mat)

    def add_verts(self, pts):
        base = len(self.verts)
        self.verts.extend(Vector(p) for p in pts)
        return list(range(base, base + len(pts)))

    def face(self, idx, mat, color=(1, 1, 1, 1), uv0=None, uv1=None):
        if len(color) == 3:
            color = (color[0], color[1], color[2], 1.0)
        self.faces.append((list(idx), self.slot(mat), color, uv0, uv1))

    def poly_facing(self, pts, normal, mat, color=(1, 1, 1, 1), uv0=None, uv1=None):
        """Like poly, but flips the winding so the face normal points along `normal`."""
        P = [Vector(p) for p in pts]
        n = (P[1] - P[0]).cross(P[2] - P[0])
        if n.dot(Vector(normal)) < 0:
            P = list(reversed(P))
            uv0 = list(reversed(uv0)) if uv0 else None
            uv1 = list(reversed(uv1)) if uv1 else None
        return self.poly(P, mat, color, uv0, uv1)

    def poly(self, pts, mat, color=(1, 1, 1, 1), uv0=None, uv1=None):
        idx = self.add_verts(pts)
        self.face(idx, mat, color, uv0, uv1)
        return idx

    # ---- primitives ---------------------------------------------------------------------------------
    def box(self, center, size, mat, color=(1, 1, 1, 1), rot=None, uv1=None, faces="all", uvmode="world"):
        """Axis box (optionally rotated by a 3x3 Matrix) centred at `center` with full extents `size`."""
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        c = Vector(center)
        R = rot if rot is not None else Matrix.Identity(3)
        corners = [Vector((sx * hx, sy * hy, sz * hz)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        P = [c + R @ v for v in corners]
        # index = (sx>0)*4 + (sy>0)*2 + (sz>0)
        quads = {
            "-x": (0, 1, 3, 2), "+x": (4, 6, 7, 5),
            "-y": (0, 4, 5, 1), "+y": (2, 3, 7, 6),
            "-z": (0, 2, 6, 4), "+z": (1, 5, 7, 3),
        }
        for k, q in quads.items():
            if faces != "all" and k not in faces:
                continue
            pts = [P[i] for i in q]
            uv0 = self.world_uv(pts) if uvmode == "world" else None
            self.poly(pts, mat, color, uv0, [uv1] * 4 if uv1 else None)

    def world_uv(self, pts):
        """Box-projected UVs in metres (dominant axis of the face normal)."""
        n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        ax = max(range(3), key=lambda i: abs(n[i]))
        if ax == 2:
            return [(p.x, p.y) for p in pts]
        if ax == 0:
            return [(p.y, p.z) for p in pts]
        return [(p.x, p.z) for p in pts]

    def cylinder(self, a, b, r0, mat, color=(1, 1, 1, 1), r1=None, seg=10, caps=True):
        a, b = Vector(a), Vector(b)
        r1 = r0 if r1 is None else r1
        axis = (b - a)
        L = axis.length
        if L < 1e-6:
            return
        z = axis / L
        x = z.orthogonal().normalized()
        y = z.cross(x)
        ring0, ring1 = [], []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            d = x * math.cos(t) + y * math.sin(t)
            ring0.append(a + d * r0)
            ring1.append(b + d * r1)
        i0 = self.add_verts(ring0)
        i1 = self.add_verts(ring1)
        for i in range(seg):
            j = (i + 1) % seg
            u0, u1 = i / seg, (i + 1) / seg
            self.face([i0[i], i0[j], i1[j], i1[i]], mat, color, [(u0, 0), (u1, 0), (u1, L), (u0, L)])
        if caps:
            self.face(list(reversed(i0)), mat, color)
            self.face(i1, mat, color)

    def sphere(self, c, r, mat, color=(1, 1, 1, 1), seg=12, rings=8, scale=(1, 1, 1), zmin=-1.0):
        c = Vector(c)
        grid = []
        for j in range(rings + 1):
            v = -math.pi / 2 + math.pi * j / rings
            if math.sin(v) < zmin - 1e-6:
                v = math.asin(zmin)
            row = []
            for i in range(seg):
                u = 2 * math.pi * i / seg
                p = Vector((math.cos(v) * math.cos(u) * r * scale[0], math.cos(v) * math.sin(u) * r * scale[1], math.sin(v) * r * scale[2]))
                row.append(c + p)
            grid.append(self.add_verts(row))
        for j in range(rings):
            for i in range(seg):
                k = (i + 1) % seg
                self.face([grid[j][i], grid[j][k], grid[j + 1][k], grid[j + 1][i]], mat, color)
        if zmin > -1.0:
            self.face(list(reversed(grid[0])), mat, color)

    def torus(self, c, axis, R, r, mat, color=(1, 1, 1, 1), seg=32, tube=8):
        c = Vector(c)
        z = Vector(axis).normalized()
        x = z.orthogonal().normalized()
        y = z.cross(x)
        grid = []
        for i in range(seg):
            u = 2 * math.pi * i / seg
            d = x * math.cos(u) + y * math.sin(u)
            row = []
            for j in range(tube):
                v = 2 * math.pi * j / tube
                row.append(c + d * (R + r * math.cos(v)) + z * (r * math.sin(v)))
            grid.append(self.add_verts(row))
        for i in range(seg):
            k = (i + 1) % seg
            for j in range(tube):
                m = (j + 1) % tube
                self.face([grid[i][j], grid[k][j], grid[k][m], grid[i][m]], mat, color)

    def prism(self, outline, z0, z1, mat, color=(1, 1, 1, 1), top=True, bottom=False, side_uv=None):
        """Extrude a 2D outline (counter-clockwise, XY) between heights."""
        n = len(outline)
        lo = self.add_verts([(p[0], p[1], z0) for p in outline])
        hi = self.add_verts([(p[0], p[1], z1) for p in outline])
        acc = 0.0
        for i in range(n):
            j = (i + 1) % n
            seglen = (Vector(outline[j]) - Vector(outline[i])).length
            uv = [(acc, z0), (acc + seglen, z0), (acc + seglen, z1), (acc, z1)]
            self.face([lo[i], lo[j], hi[j], hi[i]], mat, color, uv)
            acc += seglen
        if top:
            self.face(hi, mat, color, [(p[0], p[1]) for p in outline])
        if bottom:
            self.face(list(reversed(lo)), mat, color)

    def merge(self, other, matrix=None):
        base = len(self.verts)
        M = matrix if matrix is not None else Matrix.Identity(4)
        self.verts.extend(M @ v for v in other.verts)
        for idx, slot, col, uv0, uv1 in other.faces:
            self.faces.append(([i + base for i in idx], self.slot(other.materials[slot]), col, uv0, uv1))

    def transform(self, matrix):
        self.verts = [matrix @ v for v in self.verts]

    # ---- output --------------------------------------------------------------------------------------
    def build(self, uv1_default=(0.0, 0.0)):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata([tuple(v) for v in self.verts], [], [f[0] for f in self.faces])
        me.update()
        for m in self.materials:
            mat = bpy.data.materials.get(m) or bpy.data.materials.new(m)
            me.materials.append(mat)
        me.polygons.foreach_set("material_index", [f[1] for f in self.faces])
        col = me.color_attributes.new("Col", 'BYTE_COLOR', 'CORNER')
        uv0 = me.uv_layers.new(name="UV0")
        uv1 = me.uv_layers.new(name="UV1")
        li = 0
        cdata, u0, u1 = [], [], []
        for idx, slot, c, a, b in self.faces:
            for k in range(len(idx)):
                cdata.extend(c)
                if a:
                    u0.extend(a[k])
                else:
                    p = self.verts[idx[k]]
                    u0.extend((p.x, p.y))
                u1.extend(b[k] if b else uv1_default)
        col.data.foreach_set("color", cdata)
        uv0.data.foreach_set("uv", u0)
        uv1.data.foreach_set("uv", u1)
        me.validate(clean_customdata=False)
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def shade_flat(obj):
    for p in obj.data.polygons:
        p.use_smooth = False


def shade_smooth(obj, angle=40.0):
    for p in obj.data.polygons:
        p.use_smooth = True
    try:
        obj.data.set_sharp_from_angle(angle=math.radians(angle))
    except Exception:
        pass


def export_fbx(objs, filename):
    os.makedirs(EXPORT_DIR, exist_ok=True)
    path = os.path.join(EXPORT_DIR, filename)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={'MESH'},
                             mesh_smooth_type='FACE', use_tspace=False, add_leaf_bones=False,
                             bake_anim=False, colors_type='SRGB', apply_scale_options='FBX_SCALE_NONE',
                             apply_unit_scale=True, global_scale=1.0, axis_forward='-Z', axis_up='Y',
                             use_mesh_modifiers=False)
    return path


def export_glb(objs, name):
    """Same geometry for the browser version (Art/Export/web/<name>.glb): vertex colours, two UV sets,
    material names kept as the M_* slot names."""
    path = os.path.join(EXPORT_DIR, "web", name + ".glb")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_texcoords=True, export_normals=True, export_materials='EXPORT')
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    except TypeError:
        try:
            bpy.ops.export_scene.gltf(**kw, export_colors=True)
        except TypeError:
            bpy.ops.export_scene.gltf(**kw)
    return path


def export_mesh(builder, filename=None, smooth=None):
    obj = builder.build()
    if smooth:
        shade_smooth(obj, smooth)
    else:
        shade_flat(obj)
    path = export_fbx([obj], (filename or builder.name) + ".fbx")
    export_glb([obj], filename or builder.name)
    bpy.data.objects.remove(obj)
    return path


def text_mesh(text, size, extrude, font_path=None):
    """Blender text -> mesh vertices/faces (in XY, centred), returned as a MeshBuilder-ready list of polys."""
    curve = bpy.data.curves.new(type="FONT", name="t")
    curve.body = text
    curve.size = size
    curve.extrude = extrude
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    if font_path and os.path.exists(font_path):
        curve.font = bpy.data.fonts.load(font_path)
    obj = bpy.data.objects.new("t", curve)
    bpy.context.scene.collection.objects.link(obj)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    verts = [v.co.copy() for v in me.vertices]
    polys = [list(p.vertices) for p in me.polygons]
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)
    bpy.data.meshes.remove(me)
    return verts, polys


def add_text(builder, text, size, extrude, matrix, mat, color, font_path=None):
    verts, polys = text_mesh(text, size, extrude, font_path)
    base = builder.add_verts([matrix @ v for v in verts])
    for p in polys:
        builder.face([base[i] for i in p], mat, color)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
