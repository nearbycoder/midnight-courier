"""Builds Midnight Courier's Unreal content: materials (all procedural), meshes from Art/Export, audio, data.

Run headlessly:  Scripts/dev.sh py "$PWD/Scripts/import_assets.py"
Set MC_ONLY=materials,meshes,city,audio,data to rebuild just some groups.
"""
import os
import shutil

import unreal

PROJECT = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
EXPORT = os.path.join(PROJECT, "Art", "Export")
ROOT = "/Game/Courier"
ONLY = [s for s in os.environ.get("MC_ONLY", "").split(",") if s]

tools = unreal.AssetToolsHelpers.get_asset_tools()
mel = unreal.MaterialEditingLibrary
eal = unreal.EditorAssetLibrary
ME = unreal.MaterialProperty


def want(group):
    return not ONLY or group in ONLY


def log(msg):
    unreal.log("MC_" + msg)


# ======================================================================================================
# Material graph helper
# ======================================================================================================
F1 = unreal.CustomMaterialOutputType.CMOT_FLOAT1
F2 = unreal.CustomMaterialOutputType.CMOT_FLOAT2
F3 = unreal.CustomMaterialOutputType.CMOT_FLOAT3
F4 = unreal.CustomMaterialOutputType.CMOT_FLOAT4

# Shared HLSL helpers, prepended to custom nodes (struct trick: functions inside a struct).
LIB = r"""
struct MCLib
{
    float h21(float2 p) { p = frac(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return frac(p.x * p.y); }
    float h31(float3 p) { return h21(p.xy + p.z * 17.13); }
    float n2(float2 p)
    {
        float2 i = floor(p); float2 f = frac(p); float2 u = f * f * (3.0 - 2.0 * f);
        return lerp(lerp(h21(i), h21(i + float2(1, 0)), u.x), lerp(h21(i + float2(0, 1)), h21(i + float2(1, 1)), u.x), u.y);
    }
    float fbm(float2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++) { s += a * n2(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
    // One layer of rain ripples: returns slope (xy) and ring brightness (z). p in metres.
    float3 ripple(float2 p, float t, float seed)
    {
        float2 c = floor(p); float2 f = frac(p) - 0.5;
        float h = h21(c + seed); float h2 = h21(c + seed + 17.3);
        float2 o = (float2(h, h2) - 0.5) * 0.45;
        float ph = frac(t * 1.25 + h * 7.1);
        float2 d = f - o; float r = length(d); float R = ph * 0.32;
        float ring = exp(-pow((r - R) * 38.0, 2.0)) * (1.0 - ph) * (1.0 - ph);
        float2 n = r > 1e-4 ? d / r * ring * sin((r - R) * 70.0) : float2(0, 0);
        return float3(n, ring);
    }
    float3 ripples(float2 p, float t)
    {
        return ripple(p * 2.3, t, 0.0) + ripple(p * 2.3 + 0.5, t * 1.1 + 0.37, 5.0) + ripple(p * 1.7 + 0.21, t * 0.93 + 0.71, 9.0) * 0.8;
    }
    // Puddles: low-frequency mask in [0, 1].
    float puddle(float2 p, float amount) { float n = fbm(p * 0.18) * 0.7 + n2(p * 0.9) * 0.3; return smoothstep(0.58 - amount, 0.66 - amount, n); }
};
MCLib L;
"""


class Graph:
    """Creates (or rebuilds in place, so mesh references survive) a material and wires nodes into it."""

    def __init__(self, name, folder="Materials"):
        self.full = f"{ROOT}/{folder}/{name}"
        if eal.does_asset_exist(self.full):
            self.mat = unreal.load_asset(self.full)
            mel.delete_all_material_expressions(self.mat)
        else:
            self.mat = tools.create_asset(name, f"{ROOT}/{folder}", unreal.Material, unreal.MaterialFactoryNew())
        self.y = -800
        self.set("used_with_instanced_static_meshes", True)
        self.set("used_with_skeletal_mesh", True)

    def set(self, prop, value):
        self.mat.set_editor_property(prop, value)

    def node(self, cls, x=-900, **props):
        e = mel.create_material_expression(self.mat, cls, x, self.y)
        self.y += 140
        for k, v in props.items():
            e.set_editor_property(k, v)
        return e

    def scalar(self, name, default):
        return self.node(unreal.MaterialExpressionScalarParameter, x=-1400, parameter_name=name, default_value=default)

    def vector(self, name, rgb, a=1.0):
        return self.node(unreal.MaterialExpressionVectorParameter, x=-1400, parameter_name=name,
                         default_value=unreal.LinearColor(rgb[0], rgb[1], rgb[2], a))

    def const(self, v):
        return self.node(unreal.MaterialExpressionConstant, x=-200, r=v)

    def custom(self, code, inputs, out_type, lib=True, x=-500):
        """HLSL node. inputs: list of (pin name, node) or (pin name, node, output name)."""
        e = mel.create_material_expression(self.mat, unreal.MaterialExpressionCustom, x, self.y)
        self.y += 140
        pins = []
        for item in inputs:
            ci = unreal.CustomInput()
            ci.set_editor_property("input_name", item[0])
            pins.append(ci)
        e.set_editor_property("inputs", pins)
        e.set_editor_property("output_type", out_type)
        e.set_editor_property("code", (LIB if lib else "") + code)
        for item in inputs:
            if not mel.connect_material_expressions(item[1], item[2] if len(item) > 2 else "", e, item[0]):
                log(f"LINK_FAILED {self.full} pin {item[0]}")
        return e

    def mask(self, src, r=False, g=False, b=False, a=False):
        e = self.node(unreal.MaterialExpressionComponentMask, x=-250, r=r, g=g, b=b, a=a)
        self.link(src, e, "")
        return e

    def link(self, src, dst, pin, out=""):
        if not mel.connect_material_expressions(src, out, dst, pin):
            log(f"LINK_FAILED {self.full} pin {pin}")

    def out(self, src, prop, out=""):
        if not mel.connect_material_property(src, out, prop):
            log(f"OUT_FAILED {self.full} {prop}")

    def finish(self):
        mel.recompile_material(self.mat)
        eal.save_asset(self.full, only_if_is_dirty=False)
        log(f"MATERIAL {self.full}")
        return self.mat

    # Common inputs
    def world(self):
        return self.node(unreal.MaterialExpressionWorldPosition)

    def time(self):
        return self.node(unreal.MaterialExpressionTime)

    def vc(self):
        return self.node(unreal.MaterialExpressionVertexColor)

    def uv(self, index=0):
        return self.node(unreal.MaterialExpressionTextureCoordinate, coordinate_index=index)

    def vnormal(self):
        return self.node(unreal.MaterialExpressionVertexNormalWS)

    def camera(self):
        return self.node(unreal.MaterialExpressionCameraPositionWS)


def split4(g, packed):
    """float4 -> (rgb, a) via component masks."""
    return g.mask(packed, r=True, g=True, b=True), g.mask(packed, a=True)


# ======================================================================================================
# Materials
# ======================================================================================================
def mat_vc(name, metallic):
    g = Graph(name)
    vc = g.vc()
    wp = g.world()
    n = g.vnormal()
    # Everything is wet: up-facing surfaces get glossier; a faint fine grain breaks up the plastic look.
    packed = g.custom("""
        float grain = L.n2(W.xy * 0.05) * 0.5 + L.n2(W.yz * 0.07) * 0.5;
        float wet = saturate(N.z) * 0.35;
        float rough = saturate(A * (1.0 - wet) * (0.85 + 0.3 * grain));
        return float4(C.rgb, rough);
    """, [("C", vc), ("A", vc, "A"), ("W", wp), ("N", n)], F4)
    rgb, rough = split4(g, packed)
    g.out(rgb, ME.MP_BASE_COLOR)
    g.out(rough, ME.MP_ROUGHNESS)
    g.out(g.const(1.0 if metallic else 0.0), ME.MP_METALLIC)
    g.out(g.const(0.5), ME.MP_SPECULAR)
    g.finish()


def mat_glow():
    g = Graph("M_Glow")
    vc = g.vc()
    k = g.scalar("Glow", 14.0)
    e = g.custom("return C.rgb * K;", [("C", vc), ("K", k)], F3, lib=False)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.02, 0.02, 0.02, 1)), ME.MP_BASE_COLOR)
    g.out(g.const(0.3), ME.MP_ROUGHNESS)
    g.finish()


def mat_tint():
    g = Graph("M_Tint")
    c = g.vector("Color", (0.5, 0.5, 0.5))
    e = g.scalar("Emissive", 0.0)
    em = g.custom("return C.rgb * E;", [("C", c), ("E", e)], F3, lib=False)
    g.out(c, ME.MP_BASE_COLOR)
    g.out(em, ME.MP_EMISSIVE_COLOR)
    g.out(g.const(0.45), ME.MP_ROUGHNESS)
    g.finish()


def mat_ghost():
    g = Graph("M_Ghost")
    g.set("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    g.set("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    fres = g.node(unreal.MaterialExpressionFresnel, exponent=2.5, base_reflect_fraction=0.05)
    col = g.vector("Color", (0.15, 0.9, 1.0))
    wp = g.world()
    t = g.time()
    e = g.custom("""
        float scan = 0.7 + 0.3 * sin(W.z * 0.25 - T * 6.0);
        return C.rgb * (0.05 + F * 0.9) * scan * 1.6;
    """, [("F", fres), ("C", col), ("W", wp), ("T", t)], F3, lib=False)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.finish()


def mat_road():
    """Wet asphalt with puddles and rain ripples. World-space normal output."""
    g = Graph("M_Road")
    g.set("tangent_space_normal", False)
    wp = g.world()
    t = g.time()
    n = g.vnormal()
    vc = g.vc()
    wet = g.scalar("PuddleAmount", 0.12)
    common = """
        float2 p = W.xy * 0.01;                    // metres
        float pud = L.puddle(p, A) * saturate(N.z * 4.0 - 3.0);
        float grain = L.n2(p * 9.0) * 0.6 + L.n2(p * 31.0) * 0.4;
        float patch = L.fbm(p * 0.35);
    """
    packed = g.custom(common + """
        float3 base = lerp(float3(0.045, 0.046, 0.05), float3(0.07, 0.068, 0.066), patch) * (0.8 + 0.4 * grain);
        base *= C.rgb;
        float rough = lerp(0.32 + 0.18 * grain, 0.02, pud);
        base = lerp(base, base * 0.45, pud);
        return float4(base, rough);
    """, [("W", wp), ("A", wet), ("N", n), ("C", vc)], F4)
    nrm = g.custom(common + """
        float3 r = L.ripples(p, T);
        float2 bump = (float2(L.n2(p * 14.0), L.n2(p * 14.0 + 7.0)) - 0.5) * 0.18 * (1.0 - pud);
        float2 s = bump + r.xy * lerp(0.12, 0.5, pud);
        return normalize(N + float3(s, 0) * saturate(N.z));
    """, [("W", wp), ("A", wet), ("N", n), ("T", t)], F3)
    rgb, rough = split4(g, packed)
    g.out(rgb, ME.MP_BASE_COLOR)
    g.out(rough, ME.MP_ROUGHNESS)
    g.out(nrm, ME.MP_NORMAL)
    g.out(g.const(0.5), ME.MP_SPECULAR)
    g.finish()


def mat_stone(name, base_rgb, pavers=0.0, rough_base=0.38, puddles=0.05):
    """Concrete / paving / stone: world-aligned grain, optional paver grid, wet sheen, ripples on flats."""
    g = Graph(name)
    g.set("tangent_space_normal", False)
    wp = g.world()
    t = g.time()
    n = g.vnormal()
    vc = g.vc()
    b = g.vector("Base", base_rgb)
    params = f"float PAV = {pavers}; float RB = {rough_base}; float PA = {puddles};"
    common = params + """
        float3 q = W * 0.01;
        float2 p = abs(N.z) > 0.6 ? q.xy : (abs(N.x) > abs(N.y) ? q.yz : q.xz);
        float grain = L.n2(p * 7.0) * 0.5 + L.n2(p * 23.0) * 0.5;
        float stain = L.fbm(p * 0.6 + 3.1);
        float grout = 0.0;
        if (PAV > 0.0) { float2 f = abs(frac(p / PAV) - 0.5); grout = smoothstep(0.47, 0.5, max(f.x, f.y)); }
        float pud = L.puddle(q.xy * 1.3, PA) * saturate(N.z * 4.0 - 3.0);
        // rain streaks down vertical faces
        float streak = (1.0 - abs(N.z)) * L.n2(float2(p.x * 6.0, p.y * 0.4));
    """
    packed = g.custom(common + """
        float3 base = B.rgb * C.rgb * (0.75 + 0.35 * grain) * lerp(1.0, 0.7, stain * stain) * (1.0 - 0.45 * grout) * (1.0 - 0.25 * streak);
        base = lerp(base, base * 0.5, pud);
        float rough = lerp(RB + 0.2 * grain + 0.25 * grout, 0.03, pud);
        return float4(base, saturate(rough));
    """, [("W", wp), ("N", n), ("B", b), ("C", vc)], F4)
    nrm = g.custom(common + """
        float3 r = L.ripples(q.xy, T) * saturate(N.z * 4.0 - 3.0);
        float2 s = r.xy * lerp(0.1, 0.45, pud);
        return normalize(N + float3(s, 0));
    """, [("W", wp), ("N", n), ("T", t)], F3)
    rgb, rough = split4(g, packed)
    g.out(rgb, ME.MP_BASE_COLOR)
    g.out(rough, ME.MP_ROUGHNESS)
    g.out(nrm, ME.MP_NORMAL)
    g.finish()


def mat_paint():
    g = Graph("M_Paint")
    vc = g.vc()
    wp = g.world()
    packed = g.custom("""
        float2 p = W.xy * 0.01;
        float wear = L.n2(p * 3.0) * 0.6 + L.n2(p * 17.0) * 0.4;
        float3 c = lerp(C.rgb, float3(0.05, 0.05, 0.055), smoothstep(0.55, 0.85, wear) * 0.8);
        return float4(c, 0.25 + 0.2 * wear);
    """, [("C", vc), ("W", wp)], F4)
    rgb, rough = split4(g, packed)
    g.out(rgb, ME.MP_BASE_COLOR)
    g.out(rough, ME.MP_ROUGHNESS)
    g.finish()


def mat_facade():
    """Building walls with procedural windows. UV0 = (metres along the facade, metres above the street);
    UV1 = (building seed, style 0..1)."""
    g = Graph("M_Facade")
    uv0 = g.uv(0)
    uv1 = g.uv(1)
    t = g.time()
    wp = g.world()
    n = g.vnormal()
    lit = g.scalar("LitFraction", 0.34)
    common = """
        U.y = 1.0 - U.y;                                     // the FBX importer flips V
        float seed = S.x; float style = S.y;
        float colW = lerp(2.4, 3.6, frac(style * 7.31));
        float floorH = lerp(3.0, 3.6, frac(style * 3.17));
        float2 cell = float2(floor(U.x / colW), floor((U.y - 0.6) / floorH));
        float2 f = float2(frac(U.x / colW), frac((U.y - 0.6) / floorH));
        float ground = step(U.y, 4.4);                       // shop level: no upper windows
        float mx = lerp(0.18, 0.32, frac(style * 5.7)), my0 = 0.28, my1 = 0.12;
        float2 wf = float2((f.x - mx) / (1.0 - 2.0 * mx), (f.y - my0) / (1.0 - my0 - my1));
        float inWin = step(0.0, wf.x) * step(wf.x, 1.0) * step(0.0, wf.y) * step(wf.y, 1.0) * (1.0 - ground);
        float frame = inWin * (1.0 - step(0.05, wf.x) * step(wf.x, 0.95) * step(0.06, wf.y) * step(wf.y, 0.94));
        float sill = (1.0 - ground) * step(abs(f.y - my0 + 0.03), 0.03) * step(mx - 0.03, f.x) * step(f.x, 1.0 - mx + 0.03);
        float hc = L.h21(cell + seed * 113.0);
        float on = step(1.0 - Lit, hc) * inWin * (1.0 - frame);
        // style palette: brick, stucco, concrete, painted tile
        float sid = floor(frac(style * 2.71) * 4.0);
        float3 wall = sid < 1 ? float3(0.24, 0.1, 0.07) : sid < 2 ? float3(0.42, 0.38, 0.33) : sid < 3 ? float3(0.2, 0.2, 0.21) : float3(0.12, 0.2, 0.2);
        wall *= lerp(0.7, 1.15, L.h21(float2(seed, 3.3)));
    """
    packed = g.custom(common + """
        float2 wpos = U.xy;
        float grime = L.n2(float2(wpos.x * 2.0, wpos.y * 0.15)) * 0.5 + L.n2(wpos * 0.4) * 0.5;
        float brick = 0.0;
        if (sid < 1) { float2 bp = float2(wpos.x / 0.25 + floor(wpos.y / 0.075) * 0.5, wpos.y / 0.075); float2 bf = abs(frac(bp) - 0.5); brick = smoothstep(0.42, 0.5, max(bf.x * 0.5 + 0.25, bf.y)); }
        float3 base = wall * (0.75 + 0.4 * grime) * (1.0 - 0.35 * brick) * lerp(0.65, 1.0, saturate(wpos.y / 6.0));
        float rough = 0.55 + 0.25 * grime;
        // glass: dark and glossy; frames pale
        base = lerp(base, float3(0.02, 0.022, 0.026), inWin);
        rough = lerp(rough, 0.05, inWin * (1.0 - frame));
        base = lerp(base, float3(0.45, 0.43, 0.4), saturate(frame + sill));
        rough = lerp(rough, 0.4, saturate(frame + sill));
        return float4(base, rough);
    """, [("U", uv0), ("S", uv1), ("Lit", lit)], F4)
    emis = g.custom(common + """
        float3 warm = float3(1.0, 0.62, 0.32), cool = float3(0.55, 0.7, 1.0), tv = float3(0.35, 0.45, 1.0);
        float hk = L.h21(cell * 1.7 + seed * 31.0);
        float3 c = hk < 0.62 ? warm : (hk < 0.88 ? cool : tv);
        float flick = hk > 0.88 ? (0.6 + 0.4 * L.n2(float2(T * 6.0, hc * 50.0))) : 1.0;
        // interiors: blinds, a curtain edge, a lamp hotspot
        float blinds = L.h21(cell + 7.7) < 0.35 ? (0.55 + 0.45 * step(0.5, frac(wf.y * 9.0))) : 1.0;
        float curtain = L.h21(cell + 3.1) < 0.3 ? smoothstep(0.25, 0.45, abs(wf.x - 0.5) * 2.0) * 0.8 + 0.2 : 1.0;
        float hot = 0.6 + 0.8 * exp(-pow(length((wf - float2(0.5, 0.75)) * float2(1.2, 2.0)), 2.0) * 2.5);
        float level = lerp(0.6, 1.6, L.h21(cell * 3.3 + seed));
        return c * on * blinds * curtain * hot * level * 3.2 * flick;
    """, [("U", uv0), ("S", uv1), ("Lit", lit), ("T", t)], F3)
    rgb, rough = split4(g, packed)
    g.out(rgb, ME.MP_BASE_COLOR)
    g.out(rough, ME.MP_ROUGHNESS)
    g.out(emis, ME.MP_EMISSIVE_COLOR)
    g.finish()


def mat_shopfront():
    """Shop windows: an emissive interior with shelves and silhouettes behind glossy glass. UV0 = metres
    along the window and up from its sill; UV1.x = seed; vertex colour tints the light."""
    g = Graph("M_Shop")
    uv0 = g.uv(0)
    uv1 = g.uv(1)
    vc = g.vc()
    t = g.time()
    e = g.custom("""
        float2 p = float2(U.x, 1.0 - U.y);
        float seed = S.x;
        float shelves = 0.75 + 0.25 * step(0.5, frac(p.y * 2.2 + seed));
        float items = 0.7 + 0.3 * L.n2(float2(p.x * 6.0, floor(p.y * 2.2) * 3.0 + seed * 9.0));
        float vign = saturate(1.2 - abs(p.y - 1.2) * 0.5);
        float flick = 0.92 + 0.08 * L.n2(float2(T * 9.0, seed * 40.0));
        return C.rgb * shelves * items * vign * flick * 2.4;
    """, [("U", uv0), ("S", uv1), ("C", vc), ("T", t)], F3)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.01, 0.01, 0.012, 1)), ME.MP_BASE_COLOR)
    g.out(g.const(0.04), ME.MP_ROUGHNESS)
    g.finish()


def mat_neon():
    g = Graph("M_Neon")
    vc = g.vc()
    t = g.time()
    wp = g.world()
    k = g.scalar("Glow", 28.0)
    e = g.custom("""
        // A few signs buzz and stutter; the rest burn steady.
        float id = L.h21(floor(W.xy * 0.004) + floor(W.z * 0.004));
        float flick = 1.0;
        if (id > 0.82) { float s = L.n2(float2(T * 14.0, id * 99.0)); flick = s > 0.35 ? 1.0 : 0.08; }
        return C.rgb * K * flick;
    """, [("C", vc), ("T", t), ("W", wp), ("K", k)], F3)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.05, 0.05, 0.05, 1)), ME.MP_BASE_COLOR)
    g.out(g.const(0.2), ME.MP_ROUGHNESS)
    g.finish()


def mat_lamp():
    g = Graph("M_Lamp")
    vc = g.vc()
    k = g.scalar("Glow", 40.0)
    e = g.custom("return C.rgb * K;", [("C", vc), ("K", k)], F3, lib=False)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.out(g.const(0.2), ME.MP_ROUGHNESS)
    g.finish()


def mat_water():
    g = Graph("M_Water")
    g.set("tangent_space_normal", False)
    wp = g.world()
    t = g.time()
    nrm = g.custom("""
        float2 p = W.xy * 0.01;
        float2 a = float2(L.n2(p * 0.6 + T * 0.05), L.n2(p * 0.6 - T * 0.04 + 9.0)) - 0.5;
        float2 b = float2(L.n2(p * 2.1 - T * 0.12), L.n2(p * 2.1 + T * 0.1 + 3.0)) - 0.5;
        float3 r = L.ripples(p * 0.8, T);
        return normalize(float3((a * 0.35 + b * 0.18 + r.xy * 0.6), 1.0));
    """, [("W", wp), ("T", t)], F3)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.004, 0.007, 0.01, 1)), ME.MP_BASE_COLOR)
    g.out(g.const(0.02), ME.MP_ROUGHNESS)
    g.out(g.const(0.6), ME.MP_SPECULAR)
    g.out(nrm, ME.MP_NORMAL)
    g.finish()


def mat_roof():
    mat_stone("M_Roof", (0.07, 0.068, 0.065), 0.0, 0.7, 0.0)


def mat_rain():
    """GPU rain. The mesh is a cloud of tiny quads; this material wraps each streak into a box around the
    camera, drops it, stretches it along its velocity relative to the camera, and makes it glint in lights."""
    g = Graph("M_Rain")
    g.set("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    g.set("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    g.set("two_sided", True)
    g.set("used_with_instanced_static_meshes", True)
    loc = g.node(unreal.MaterialExpressionPreSkinnedPosition)
    uv0 = g.uv(0)
    vc = g.vc()
    t = g.time()
    cam = g.camera()
    wpos = g.node(unreal.MaterialExpressionWorldPosition, world_position_shader_offset=unreal.WorldPositionIncludedOffsets.WPT_EXCLUDE_ALL_SHADER_OFFSETS)
    rain_vel = g.vector("RainVel", (180.0, 90.0, -1100.0))
    cam_vel = g.vector("CamVel", (0.0, 0.0, 0.0))
    wpo = g.custom("""
        UV.y = 1.0 - UV.y;
        float3 anchor = P - float3(UV.x * 4.0, 0.0, UV.y * 8.0);
        float3 box = float3(3400.0, 3400.0, 1800.0);
        float speed = 0.85 + 0.3 * C.g;
        float3 p = anchor + RV.xyz * T * speed;
        float3 rel = p - Cam;
        rel = (frac(rel / box + 0.5) - 0.5) * box;
        float3 a = Cam + rel;
        float3 v = RV.xyz * speed - CV.xyz * 0.85;
        float3 dir = normalize(v);
        float3 toCam = normalize(Cam - a);
        float3 side = normalize(cross(dir, toCam));
        float len = clamp(length(v) * 0.045, 35.0, 140.0) * (0.7 + 0.6 * C.r);
        float3 vtx = a + dir * (UV.y - 0.5) * len + side * UV.x * 0.9;
        return vtx - WP;
    """, [("P", loc), ("UV", uv0), ("C", vc), ("T", t), ("Cam", cam), ("WP", wpos), ("RV", rain_vel), ("CV", cam_vel)], F3)
    g.out(wpo, ME.MP_WORLD_POSITION_OFFSET)
    wp2 = g.world()
    cam2 = g.camera()
    lamp_pos = g.vector("LampPos", (0.0, 0.0, 0.0))
    lamp_dir = g.vector("LampDir", (1.0, 0.0, 0.0))
    bright = g.scalar("Brightness", 0.11)
    e = g.custom("""
        float d = length(W - Cam);
        float fade = smoothstep(60.0, 260.0, d) * (1.0 - smoothstep(1100.0, 1700.0, d));
        float edge = 1.0 - abs(UV.x * 2.0);
        float3 toP = W - LP.xyz; float dl = length(toP);
        float cone = smoothstep(0.86, 0.97, dot(toP / max(dl, 1.0), normalize(LD.xyz))) * saturate(1.0 - dl / 2600.0);
        float3 c = float3(0.65, 0.75, 0.9) * B + float3(1.0, 0.95, 0.85) * cone * 1.6;
        return c * fade * edge * (0.6 + 0.4 * C.b);
    """, [("W", wp2), ("Cam", cam2), ("UV", uv0), ("LP", lamp_pos), ("LD", lamp_dir), ("B", bright), ("C", vc)], F3)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.finish()


def mat_beacon():
    g = Graph("M_Beacon")
    g.set("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    g.set("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    g.set("two_sided", True)
    uv0 = g.uv(0)
    t = g.time()
    cv = g.node(unreal.MaterialExpressionCameraVectorWS)
    n = g.vnormal()
    col = g.vector("Color", (1.0, 0.55, 0.12))
    e = g.custom("""
        float v = 1.0 - UV.y;
        float soft = pow(saturate(abs(dot(N, V))), 1.6);
        float pulse = 0.75 + 0.25 * sin(T * 2.4);
        float rise = 0.85 + 0.15 * sin(v * 60.0 - T * 4.0);
        float ring = v < 0.03 ? 2.5 : 1.0;
        return C.rgb * pow(1.0 - v, 1.4) * soft * pulse * rise * ring * 1.4;
    """, [("UV", uv0), ("T", t), ("V", cv), ("N", n), ("C", col)], F3, lib=False)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.finish()


def mat_sky():
    g = Graph("M_Sky")
    g.set("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    g.set("two_sided", True)
    wp = g.world()
    cam = g.camera()
    t = g.time()
    flash = g.scalar("Lightning", 0.0)
    e = g.custom("""
        float3 d = normalize(W - Cam);
        float h = d.z;
        float3 zenith = float3(0.004, 0.006, 0.014);
        float3 horizon = float3(0.07, 0.04, 0.05);
        float3 glow = float3(0.16, 0.07, 0.035);
        float3 c = lerp(horizon, zenith, saturate(pow(max(h, 0.0), 0.55)));
        c += glow * exp(-max(h, 0.0) * 9.0);
        float2 p = d.xy / max(h + 0.12, 0.05) * 1.3 + float2(T * 0.006, T * 0.002);
        float cl = L.fbm(p) * 0.65 + L.fbm(p * 2.7 + 4.0) * 0.35;
        float cloud = smoothstep(0.35, 0.8, cl);
        float3 lit = float3(0.08, 0.05, 0.05) * exp(-max(h, 0.0) * 3.0) + float3(0.5, 0.55, 0.7) * F * 1.5;
        c = lerp(c, c * 0.5 + lit * (0.4 + 0.6 * cl), cloud * saturate(h * 6.0 + 0.3));
        return c * (1.0 + F * 3.0);
    """, [("W", wp), ("Cam", cam), ("T", t), ("F", flash)], F3)
    g.out(e, ME.MP_EMISSIVE_COLOR)
    g.finish()


def mat_spray():
    """Wheel spray: soft additive puffs."""
    g = Graph("M_Spray")
    g.set("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    g.set("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    g.set("two_sided", True)
    uv0 = g.uv(0)
    op = g.scalar("Opacity", 0.0)
    a = g.custom("float2 d = UV - 0.5; return saturate(1.0 - length(d) * 2.0) * O;", [("UV", uv0), ("O", op)], F1, lib=False)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.12, 0.13, 0.15, 1)), ME.MP_EMISSIVE_COLOR)
    g.out(a, ME.MP_OPACITY)
    g.finish()


def build_materials():
    mat_vc("M_VC", False)
    mat_vc("M_VCMetal", True)
    mat_glow()
    mat_tint()
    mat_ghost()
    mat_road()
    mat_stone("M_Sidewalk", (0.34, 0.33, 0.31), 0.6, 0.42, 0.08)
    mat_stone("M_Curb", (0.42, 0.41, 0.4), 0.0, 0.35, 0.0)
    mat_stone("M_Stairs", (0.36, 0.34, 0.32), 0.0, 0.4, 0.0)
    mat_stone("M_Concrete", (0.3, 0.3, 0.3), 0.0, 0.5, 0.04)
    mat_stone("M_Cobble", (0.28, 0.26, 0.25), 0.22, 0.35, 0.15)
    mat_stone("M_Wood", (0.32, 0.2, 0.12), 0.0, 0.55, 0.0)
    mat_stone("M_FacadePlain", (0.28, 0.26, 0.25), 0.0, 0.65, 0.0)
    mat_roof()
    mat_paint()
    mat_facade()
    mat_shopfront()
    mat_neon()
    mat_lamp()
    mat_water()
    mat_rain()
    mat_beacon()
    mat_sky()
    mat_spray()


# ======================================================================================================
# Meshes
# ======================================================================================================
def import_file(path, dest, name=None, options=None):
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", path)
    task.set_editor_property("destination_path", dest)
    if name:
        task.set_editor_property("destination_name", name)
    task.set_editor_property("automated", True)
    task.set_editor_property("replace_existing", True)
    task.set_editor_property("save", True)
    if options is not None:
        task.set_editor_property("options", options)
    tools.import_asset_tasks([task])
    return [str(p) for p in task.get_editor_property("imported_object_paths")]


def mesh_pipeline():
    p = unreal.InterchangeGenericAssetsPipeline()
    p.set_editor_property("use_source_name_for_asset", True)
    common = p.get_editor_property("common_meshes_properties")
    common.set_editor_property("force_all_mesh_as_type", unreal.InterchangeForceMeshType.IFMT_STATIC_MESH)
    common.set_editor_property("vertex_color_import_option", unreal.InterchangeVertexColorImportOption.IVCIO_REPLACE)
    common.set_editor_property("recompute_normals", False)
    common.set_editor_property("recompute_tangents", True)
    common.set_editor_property("use_full_precision_u_vs", True)
    common.set_editor_property("remove_degenerates", False)
    mesh = p.get_editor_property("mesh_pipeline")
    mesh.set_editor_property("import_static_meshes", True)
    mesh.set_editor_property("import_skeletal_meshes", False)
    mesh.set_editor_property("combine_static_meshes_behavior", unreal.InterchangeCombineStaticMeshesBehavior.ALL)
    mesh.set_editor_property("generate_lightmap_u_vs", False)
    mesh.set_editor_property("build_nanite", False)
    mesh.set_editor_property("collision", False)
    p.get_editor_property("material_pipeline").set_editor_property("import_materials", False)
    p.get_editor_property("material_pipeline").get_editor_property("texture_pipeline").set_editor_property("import_textures", False)
    p.get_editor_property("animation_pipeline").set_editor_property("import_animations", False)
    override = unreal.InterchangePipelineStackOverride()
    override.add_pipeline(p)
    return override


def skeletal_pipeline():
    p = unreal.InterchangeGenericAssetsPipeline()
    p.set_editor_property("use_source_name_for_asset", True)
    common = p.get_editor_property("common_meshes_properties")
    common.set_editor_property("force_all_mesh_as_type", unreal.InterchangeForceMeshType.IFMT_SKELETAL_MESH)
    common.set_editor_property("vertex_color_import_option", unreal.InterchangeVertexColorImportOption.IVCIO_REPLACE)
    common.set_editor_property("recompute_normals", False)
    common.set_editor_property("recompute_tangents", True)
    mesh = p.get_editor_property("mesh_pipeline")
    mesh.set_editor_property("import_static_meshes", False)
    mesh.set_editor_property("import_skeletal_meshes", True)
    mesh.set_editor_property("create_physics_asset", False)
    mesh.set_editor_property("import_morph_targets", False)
    p.get_editor_property("material_pipeline").set_editor_property("import_materials", False)
    p.get_editor_property("material_pipeline").get_editor_property("texture_pipeline").set_editor_property("import_textures", False)
    p.get_editor_property("animation_pipeline").set_editor_property("import_animations", False)
    override = unreal.InterchangePipelineStackOverride()
    override.add_pipeline(p)
    return override


def import_rider():
    dest = f"{ROOT}/Meshes"
    path = os.path.join(EXPORT, "SK_Rider.fbx")
    if not os.path.isfile(path):
        return
    import_file(path, dest, options=skeletal_pipeline())
    sk = unreal.load_asset(f"{dest}/SK_Rider")
    if not sk:
        log("RIDER_FAILED")
        return
    mats = sk.get_editor_property("materials")
    names = []
    for i in range(len(mats)):
        m = mats[i]
        slot = str(m.get_editor_property("material_slot_name")).split(".")[0]
        names.append(slot)
        m.set_editor_property("material_interface", material(slot) or material("M_VC"))
        mats[i] = m
    sk.set_editor_property("materials", mats)
    eal.save_asset(f"{dest}/SK_Rider", only_if_is_dirty=False)
    log(f"RIDER slots={names}")


def material(name):
    return unreal.load_asset(f"{ROOT}/Materials/{name}")


def assign_materials(path, complex_collision=False, distance_field=True):
    sm = unreal.load_asset(path)
    if not sm:
        log(f"MESH_MISSING {path}")
        return []
    names = []
    for i, slot in enumerate(sm.get_editor_property("static_materials")):
        slot_name = str(slot.get_editor_property("material_slot_name"))
        # Blender may suffix duplicate material names (.001); strip that.
        base = slot_name.split(".")[0]
        names.append(base)
        mat = material(base) or material("M_VC")
        sm.set_material(i, mat)
    body = sm.get_editor_property("body_setup")
    if body:
        body.set_editor_property("collision_trace_flag",
                                 unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE if complex_collision else unreal.CollisionTraceFlag.CTF_USE_DEFAULT)
    eal.save_asset(path, only_if_is_dirty=False)
    return names


def import_meshes(prefixes, complex_collision):
    dest = f"{ROOT}/Meshes"
    count = 0
    if not os.path.isdir(EXPORT):
        return
    for f in sorted(os.listdir(EXPORT)):
        if not f.endswith(".fbx") or not f.startswith(tuple(prefixes)):
            continue
        name = os.path.splitext(f)[0]
        import_file(os.path.join(EXPORT, f), dest, options=mesh_pipeline())
        slots = assign_materials(f"{dest}/{name}", complex_collision)
        count += 1
        if count <= 3:
            log(f"SLOTS {name} {slots}")
    log(f"IMPORTED {count} meshes ({prefixes})")


# ======================================================================================================
# Audio + data
# ======================================================================================================
LOOPS = ("A_RainLoop", "A_CityLoop", "A_WindLoop", "A_RollLoop", "A_FreewheelLoop", "A_ChainLoop", "A_SkidLoop", "A_MusicRide", "A_MusicTitle")


def import_audio():
    src = os.path.join(PROJECT, "Art", "Audio")
    if not os.path.isdir(src):
        log("AUDIO none")
        return
    dest = f"{ROOT}/Audio"
    count = 0
    for f in sorted(os.listdir(src)):
        if not f.endswith(".wav"):
            continue
        name = os.path.splitext(f)[0]
        import_file(os.path.join(src, f), dest, name=name)
        snd = unreal.load_asset(f"{dest}/{name}")
        if snd and name in LOOPS:
            snd.set_editor_property("looping", True)
            eal.save_asset(f"{dest}/{name}", only_if_is_dirty=False)
        count += 1
    log(f"IMPORTED {count} sounds")


def copy_data():
    src = os.path.join(EXPORT, "level.json")
    if os.path.isfile(src):
        dest = os.path.join(PROJECT, "Content", "Courier", "Data")
        os.makedirs(dest, exist_ok=True)
        shutil.copy2(src, dest)
        log("DATA level.json")


if want("materials"):
    build_materials()
if want("meshes"):
    import_meshes(("SM_Bike", "SM_Rider", "SM_Package", "SM_Rain", "SM_Beacon", "SM_Prop"), False)
if want("rider"):
    import_rider()
if want("city"):
    import_meshes(("SM_City",), True)
if want("audio"):
    import_audio()
if want("data"):
    copy_data()
log("DONE")
