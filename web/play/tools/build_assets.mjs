// Packs the Blender glTF exports (MidnightCourier/Art/Export/web) into a few compact, meshopt-compressed
// files for the browser:
//   assets/city_s.glb   solid city chunks (rendered + collision), one node per chunk
//   assets/city_d.glb   decoration chunks (rendered only)
//   assets/props.glb    bike parts, package, beacon, rain streaks
//   assets/rider.glb    skinned rider
// Usage: node build_assets.mjs <exportWebDir> <outAssetsDir>
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup, unpartition, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [, , SRC, OUT] = process.argv;
if (!SRC || !OUT) { console.error('usage: node build_assets.mjs <exportWebDir> <outAssetsDir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
	'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});

// Which vertex attributes each (procedural) material actually reads. Everything else is dropped.
const NEEDS = {
	M_VC: ['COLOR_0'], M_VCMetal: ['COLOR_0'], M_Glow: ['COLOR_0'], M_Neon: ['COLOR_0'], M_Lamp: ['COLOR_0'],
	M_Paint: ['COLOR_0'], M_Road: ['COLOR_0'], M_Sidewalk: ['COLOR_0'], M_Curb: ['COLOR_0'], M_Stairs: ['COLOR_0'],
	M_Concrete: ['COLOR_0'], M_Cobble: ['COLOR_0'], M_Wood: ['COLOR_0'], M_FacadePlain: ['COLOR_0'], M_Roof: ['COLOR_0'],
	M_Facade: ['TEXCOORD_0', 'TEXCOORD_1'], M_Shop: ['TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0'], M_Water: [],
	M_Rain: ['TEXCOORD_0', 'COLOR_0'], M_Beacon: ['TEXCOORD_0'], M_Tint: [],
};
const ALWAYS = ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'];

async function pack(files, outName, { position = 16 } = {}) {
	const t0 = Date.now();
	let doc = null;
	for (const f of files) {
		const src = await io.read(path.join(SRC, f));
		const name = path.basename(f, '.glb');
		// Name the top node after the file so the game can find chunks / parts.
		for (const scene of src.getRoot().listScenes()) {
			for (const n of scene.listChildren()) { if (n.getMesh()) n.setName(name); }
		}
		for (const m of src.getRoot().listMeshes()) m.setName(name);
		if (!doc) { doc = src; continue; }
		mergeDocuments(doc, src);
	}
	// One scene holding every node.
	const scenes = doc.getRoot().listScenes();
	const main = scenes[0];
	for (const s of scenes.slice(1)) {
		for (const n of s.listChildren()) main.addChild(n);
		s.dispose();
	}
	doc.getRoot().setDefaultScene(main);
	// Strip attributes the shaders never read.
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const mat = (prim.getMaterial()?.getName() || 'M_VC').split('.')[0];
			const keep = new Set([...ALWAYS, ...(NEEDS[mat] || ['COLOR_0'])]);
			for (const sem of prim.listSemantics()) if (!keep.has(sem)) prim.setAttribute(sem, null);
		}
	}
	await doc.transform(
		dedup({ keepUniqueNames: true }), prune({ keepAttributes: true }), unpartition(),
		reorder({ encoder: MeshoptEncoder, target: 'size' }),
		quantize({
			pattern: /^(POSITION|NORMAL|COLOR_0|JOINTS_0|WEIGHTS_0)$/,
			quantizePosition: position, quantizeNormal: 8, quantizeColor: 8, quantizeWeight: 8,
			quantizationVolume: 'mesh',
		}),
	);
	doc.createExtension(EXTMeshoptCompression).setRequired(true)
		.setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
	const out = path.join(OUT, outName);
	await io.write(out, doc);
	console.log(`${outName}: ${files.length} files -> ${(fs.statSync(out).size / 1e6).toFixed(2)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

const all = fs.readdirSync(SRC).filter((f) => f.endsWith('.glb')).sort();
await pack(all.filter((f) => f.startsWith('SM_City_S_')), 'city_s.glb');
await pack(all.filter((f) => f.startsWith('SM_City_D_')), 'city_d.glb');
await pack(['SM_BikeFrame', 'SM_BikeFork', 'SM_BikeWheel', 'SM_BikeCrank', 'SM_BikePedal', 'SM_Package', 'SM_Beacon', 'SM_RainStreaks']
	.map((n) => n + '.glb'), 'props.glb');
await pack(['SK_Rider.glb'], 'rider.glb');
