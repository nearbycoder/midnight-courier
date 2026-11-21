// Complex (triangle) collision against the solid city chunks, in Unreal space (metres, Z up).
// Ports the three kinds of scene query the Unreal game uses: sphere sweeps (wheel probes, crash debris,
// camera), a capsule sweep (the bike body against walls) and a line trace (spawning).
// Candidate triangles come from a three-mesh-bvh shapecast over a small box; exact tests follow.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const EPS_PEN = 0.0015; // initial overlap deeper than this counts as "start penetrating"

export class Hit {
	constructor() { this.reset(); }
	reset() {
		this.hit = false; this.time = 1; this.startPen = false; this.depth = 0;
		this.loc = [0, 0, 0]; this.normal = [0, 0, 1]; this.impact = [0, 0, 1];
		return this;
	}
}

export class Collision {
	/** positions: Float32Array of Unreal-space metres; index: Uint32Array */
	constructor(positions, index) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		g.setIndex(new THREE.BufferAttribute(index, 1));
		this.bvh = new MeshBVH(g, { targetLeafSize: 6, strategy: 0 /* CENTER */ });
		this.geometry = g;
		this.P = g.attributes.position.array;
		this.I = g.index.array;
		this.triCount = this.I.length / 3;
		// Per-triangle cache: 9 coords + unit normal + aabb (6) = 18 floats.
		this.T = new Float64Array(this.triCount * 18);
		const P = this.P, I = this.I, T = this.T;
		for (let t = 0; t < this.triCount; t++) {
			const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3, o = t * 18;
			T[o] = P[a]; T[o + 1] = P[a + 1]; T[o + 2] = P[a + 2];
			T[o + 3] = P[b]; T[o + 4] = P[b + 1]; T[o + 5] = P[b + 2];
			T[o + 6] = P[c]; T[o + 7] = P[c + 1]; T[o + 8] = P[c + 2];
			const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2];
			const vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
			let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
			const l = Math.hypot(nx, ny, nz) || 1;
			T[o + 9] = nx / l; T[o + 10] = ny / l; T[o + 11] = nz / l;
			T[o + 12] = Math.min(T[o], T[o + 3], T[o + 6]); T[o + 13] = Math.min(T[o + 1], T[o + 4], T[o + 7]); T[o + 14] = Math.min(T[o + 2], T[o + 5], T[o + 8]);
			T[o + 15] = Math.max(T[o], T[o + 3], T[o + 6]); T[o + 16] = Math.max(T[o + 1], T[o + 4], T[o + 7]); T[o + 17] = Math.max(T[o + 2], T[o + 5], T[o + 8]);
		}
		this.cand = new Int32Array(8192);
		this.nc = 0;
		this._box = new THREE.Box3();
		this._ray = new THREE.Ray();
		this._cp = new Float64Array(3);
		this._cs = new Float64Array(3);
		this._ct = new Float64Array(3);
		const self = this;
		this._cast = {
			intersectsBounds: (box) => box.intersectsBox(self._box),
			intersectsRange: (offset, count) => {
				const T = self.T, b = self._box;
				for (let t = offset; t < offset + count; t++) {
					const o = t * 18;
					if (T[o + 15] < b.min.x || T[o + 12] > b.max.x || T[o + 16] < b.min.y || T[o + 13] > b.max.y || T[o + 17] < b.min.z || T[o + 14] > b.max.z) continue;
					if (self.nc < self.cand.length) self.cand[self.nc++] = t;
				}
				return false;
			},
		};
		this.queries = 0;
	}

	gather(x0, y0, z0, x1, y1, z1) {
		this._box.min.set(x0, y0, z0);
		this._box.max.set(x1, y1, z1);
		this.nc = 0;
		this.queries++;
		this.bvh.shapecast(this._cast);
		return this.nc;
	}

	// ---- line trace --------------------------------------------------------------------------------------
	raycast(sx, sy, sz, ex, ey, ez) {
		const dx = ex - sx, dy = ey - sy, dz = ez - sz, len = Math.hypot(dx, dy, dz);
		this._ray.origin.set(sx, sy, sz);
		this._ray.direction.set(dx / len, dy / len, dz / len);
		const h = this.bvh.raycastFirst(this._ray, THREE.DoubleSide, 0, len);
		return h ? [h.point.x, h.point.y, h.point.z] : null;
	}

	// ---- sphere sweep --------------------------------------------------------------------------------------
	/** Unreal SweepSingle with a sphere. Fills `out` (loc = sphere centre at impact, normal = contact normal,
	 *  impact = face normal of the triangle hit). */
	sweepSphere(sx, sy, sz, ex, ey, ez, r, out) {
		out.reset();
		const m = r + 0.01;
		this.gather(Math.min(sx, ex) - m, Math.min(sy, ey) - m, Math.min(sz, ez) - m, Math.max(sx, ex) + m, Math.max(sy, ey) + m, Math.max(sz, ez) + m);
		const T = this.T, cp = this._cp;
		const dx = ex - sx, dy = ey - sy, dz = ez - sz;
		const dd = dx * dx + dy * dy + dz * dz;
		let best = 2, bn0 = 0, bn1 = 0, bn2 = 1, bi0 = 0, bi1 = 0, bi2 = 1;
		let penDepth = -1, pn0 = 0, pn1 = 0, pn2 = 1;
		for (let k = 0; k < this.nc; k++) {
			const o = this.cand[k] * 18;
			let nx = T[o + 9], ny = T[o + 10], nz = T[o + 11];
			// Initial overlap?
			const d2 = closestPtTri(sx, sy, sz, T, o, cp);
			if (d2 < (r - EPS_PEN) * (r - EPS_PEN)) {
				const d = Math.sqrt(d2), depth = r - d;
				if (depth > penDepth) {
					penDepth = depth;
					if (d > 1e-6) { pn0 = (sx - cp[0]) / d; pn1 = (sy - cp[1]) / d; pn2 = (sz - cp[2]) / d; }
					else { const s = (sx - T[o]) * nx + (sy - T[o + 1]) * ny + (sz - T[o + 2]) * nz >= 0 ? 1 : -1; pn0 = nx * s; pn1 = ny * s; pn2 = nz * s; }
				}
				continue;
			}
			if (penDepth >= 0 || dd < 1e-12) continue;
			// Face.
			let s = (sx - T[o]) * nx + (sy - T[o + 1]) * ny + (sz - T[o + 2]) * nz;
			if (s < 0) { s = -s; nx = -nx; ny = -ny; nz = -nz; }
			const dn = dx * nx + dy * ny + dz * nz;
			if (dn < -1e-9) {
				const t = (s - r) / -dn;
				if (t >= 0 && t <= 1 && t < best) {
					const qx = sx + dx * t - nx * r, qy = sy + dy * t - ny * r, qz = sz + dz * t - nz * r;
					if (pointInTri(qx, qy, qz, T, o)) { best = t; bn0 = nx; bn1 = ny; bn2 = nz; bi0 = nx; bi1 = ny; bi2 = nz; continue; }
				}
			}
			// Edges and vertices.
			for (let e = 0; e < 3; e++) {
				const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
				const t = rayCapsuleEdge(sx, sy, sz, dx, dy, dz, T[a], T[a + 1], T[a + 2], T[b], T[b + 1], T[b + 2], r, cp);
				if (t >= 0 && t < best) {
					best = t;
					const cx = sx + dx * t, cy = sy + dy * t, cz = sz + dz * t;
					const l = Math.hypot(cx - cp[0], cy - cp[1], cz - cp[2]) || 1;
					bn0 = (cx - cp[0]) / l; bn1 = (cy - cp[1]) / l; bn2 = (cz - cp[2]) / l;
					const f = bn0 * nx + bn1 * ny + bn2 * nz >= 0 ? 1 : -1;
					bi0 = nx * f; bi1 = ny * f; bi2 = nz * f;
				}
			}
		}
		if (penDepth >= 0) {
			out.hit = true; out.startPen = true; out.time = 0; out.depth = penDepth;
			out.loc[0] = sx; out.loc[1] = sy; out.loc[2] = sz;
			out.normal[0] = pn0; out.normal[1] = pn1; out.normal[2] = pn2;
			out.impact[0] = pn0; out.impact[1] = pn1; out.impact[2] = pn2;
			return true;
		}
		if (best > 1) return false;
		out.hit = true; out.time = best;
		out.loc[0] = sx + dx * best; out.loc[1] = sy + dy * best; out.loc[2] = sz + dz * best;
		out.normal[0] = bn0; out.normal[1] = bn1; out.normal[2] = bn2;
		out.impact[0] = bi0; out.impact[1] = bi1; out.impact[2] = bi2;
		return true;
	}

	// ---- capsule sweep ---------------------------------------------------------------------------------------
	/** Capsule (centre c, unit axis u, half segment h, radius r) swept by (dx, dy, dz). */
	sweepCapsule(cx, cy, cz, dx, dy, dz, ux, uy, uz, h, r, out) {
		out.reset();
		const ex = Math.abs(ux) * h + r + 0.01, ey = Math.abs(uy) * h + r + 0.01, ez = Math.abs(uz) * h + r + 0.01;
		this.gather(Math.min(cx, cx + dx) - ex, Math.min(cy, cy + dy) - ey, Math.min(cz, cz + dz) - ez,
			Math.max(cx, cx + dx) + ex, Math.max(cy, cy + dy) + ey, Math.max(cz, cz + dz) + ez);
		if (this.nc === 0) return false;
		const res = this._capRes || (this._capRes = { d2: 0, tri: -1, s: new Float64Array(3), t: new Float64Array(3) });
		const ax = ux * h, ay = uy * h, az = uz * h;
		const evalAt = (t) => {
			const px = cx + dx * t, py = cy + dy * t, pz = cz + dz * t;
			return this._minSegDist(px - ax, py - ay, pz - az, px + ax, py + ay, pz + az, res);
		};
		// Start.
		let d2 = evalAt(0);
		if (d2 < (r - EPS_PEN) * (r - EPS_PEN)) {
			const d = Math.sqrt(d2);
			out.hit = true; out.startPen = true; out.time = 0; out.depth = r - d;
			out.loc[0] = cx; out.loc[1] = cy; out.loc[2] = cz;
			this._normalFrom(res, d, cx, cy, cz, out.normal);
			out.impact.splice(0, 3, ...out.normal);
			return true;
		}
		d2 = evalAt(1);
		if (d2 >= r * r) return false;
		let lo = 0, hi = 1;
		for (let i = 0; i < 14; i++) {
			const mid = (lo + hi) * 0.5;
			if (evalAt(mid) < r * r) hi = mid; else lo = mid;
		}
		d2 = evalAt(hi);
		const d = Math.sqrt(d2);
		out.hit = true; out.time = lo;
		out.loc[0] = cx + dx * lo; out.loc[1] = cy + dy * lo; out.loc[2] = cz + dz * lo;
		this._normalFrom(res, d, out.loc[0], out.loc[1], out.loc[2], out.normal);
		out.impact.splice(0, 3, ...out.normal);
		return true;
	}

	_normalFrom(res, d, cx, cy, cz, n) {
		if (d > 1e-5) {
			n[0] = (res.s[0] - res.t[0]) / d; n[1] = (res.s[1] - res.t[1]) / d; n[2] = (res.s[2] - res.t[2]) / d;
		} else {
			const o = res.tri * 18, T = this.T;
			const f = (cx - T[o]) * T[o + 9] + (cy - T[o + 1]) * T[o + 10] + (cz - T[o + 2]) * T[o + 11] >= 0 ? 1 : -1;
			n[0] = T[o + 9] * f; n[1] = T[o + 10] * f; n[2] = T[o + 11] * f;
		}
	}

	/** Smallest squared distance from segment p0-p1 to the candidate triangles. */
	_minSegDist(p0x, p0y, p0z, p1x, p1y, p1z, res) {
		let best = Infinity;
		const T = this.T, cs = this._cs, ct = this._ct;
		const bx0 = Math.min(p0x, p1x), by0 = Math.min(p0y, p1y), bz0 = Math.min(p0z, p1z);
		const bx1 = Math.max(p0x, p1x), by1 = Math.max(p0y, p1y), bz1 = Math.max(p0z, p1z);
		for (let k = 0; k < this.nc; k++) {
			const tri = this.cand[k], o = tri * 18;
			// Cheap reject: AABB distance.
			const gx = Math.max(0, T[o + 12] - bx1, bx0 - T[o + 15]);
			const gy = Math.max(0, T[o + 13] - by1, by0 - T[o + 16]);
			const gz = Math.max(0, T[o + 14] - bz1, bz0 - T[o + 17]);
			if (gx * gx + gy * gy + gz * gz >= best) continue;
			const d2 = segTriDist2(p0x, p0y, p0z, p1x, p1y, p1z, T, o, cs, ct);
			if (d2 < best) {
				best = d2; res.tri = tri;
				res.s[0] = cs[0]; res.s[1] = cs[1]; res.s[2] = cs[2];
				res.t[0] = ct[0]; res.t[1] = ct[1]; res.t[2] = ct[2];
			}
		}
		res.d2 = best;
		return best;
	}
}

// ==========================================================================================================
// Geometry helpers (triangles stored at T[o..o+8])
// ==========================================================================================================

/** Closest point on triangle to p (Ericson 5.1.5). Writes it to out, returns squared distance. */
export function closestPtTri(px, py, pz, T, o, out) {
	const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
	const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
	let rx, ry, rz;
	if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; }
	else {
		const bpx = px - bx, bpy = py - by, bpz = pz - bz;
		const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
		if (d3 >= 0 && d4 <= d3) { rx = bx; ry = by; rz = bz; }
		else {
			const vc = d1 * d4 - d3 * d2;
			if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); rx = ax + abx * v; ry = ay + aby * v; rz = az + abz * v; }
			else {
				const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
				const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
				if (d6 >= 0 && d5 <= d6) { rx = cx; ry = cy; rz = cz; }
				else {
					const vb = d5 * d2 - d1 * d6;
					if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w; }
					else {
						const va = d3 * d6 - d5 * d4;
						if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
							const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
							rx = bx + (cx - bx) * w; ry = by + (cy - by) * w; rz = bz + (cz - bz) * w;
						} else {
							const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
							rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w;
						}
					}
				}
			}
		}
	}
	out[0] = rx; out[1] = ry; out[2] = rz;
	return (px - rx) * (px - rx) + (py - ry) * (py - ry) + (pz - rz) * (pz - rz);
}

function pointInTri(px, py, pz, T, o) {
	const nx = T[o + 9], ny = T[o + 10], nz = T[o + 11];
	for (let e = 0; e < 3; e++) {
		const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
		const ex = T[b] - T[a], ey = T[b + 1] - T[a + 1], ez = T[b + 2] - T[a + 2];
		const qx = px - T[a], qy = py - T[a + 1], qz = pz - T[a + 2];
		// (e x q) . n
		const cx = ey * qz - ez * qy, cy = ez * qx - ex * qz, cz = ex * qy - ey * qx;
		if (cx * nx + cy * ny + cz * nz < -1e-9) return false;
	}
	return true;
}

/** Time of impact (0..1) of a moving sphere centre s + d t against the rounded edge a-b (capsule of radius
 *  r around the segment, ends included). Writes the contact point on the edge to cp. -1 if none. */
function rayCapsuleEdge(sx, sy, sz, dx, dy, dz, ax, ay, az, bx, by, bz, r, cp) {
	const Ex = bx - ax, Ey = by - ay, Ez = bz - az;
	const EE = Ex * Ex + Ey * Ey + Ez * Ez;
	const mx = sx - ax, my = sy - ay, mz = sz - az;
	let best = -1;
	if (EE > 1e-12) {
		const md = (mx * Ex + my * Ey + mz * Ez) / EE, dE = (dx * Ex + dy * Ey + dz * Ez) / EE;
		const mmx = mx - Ex * md, mmy = my - Ey * md, mmz = mz - Ez * md;
		const ddx = dx - Ex * dE, ddy = dy - Ey * dE, ddz = dz - Ez * dE;
		const A = ddx * ddx + ddy * ddy + ddz * ddz;
		if (A > 1e-12) {
			const B = 2 * (mmx * ddx + mmy * ddy + mmz * ddz), C = mmx * mmx + mmy * mmy + mmz * mmz - r * r;
			const disc = B * B - 4 * A * C;
			if (disc >= 0) {
				const t = (-B - Math.sqrt(disc)) / (2 * A);
				if (t >= 0 && t <= 1) {
					const u = md + dE * t;
					if (u >= 0 && u <= 1) { best = t; cp[0] = ax + Ex * u; cp[1] = ay + Ey * u; cp[2] = az + Ez * u; }
				}
			}
		}
	}
	// End caps (vertex a; vertex b is covered by the next edge).
	const A = dx * dx + dy * dy + dz * dz;
	if (A > 1e-12) {
		const B = 2 * (mx * dx + my * dy + mz * dz), C = mx * mx + my * my + mz * mz - r * r;
		const disc = B * B - 4 * A * C;
		if (disc >= 0) {
			const t = (-B - Math.sqrt(disc)) / (2 * A);
			if (t >= 0 && t <= 1 && (best < 0 || t < best)) { best = t; cp[0] = ax; cp[1] = ay; cp[2] = az; }
		}
	}
	return best;
}

/** Closest points between segments p1-q1 and p2-q2 (Ericson 5.1.9). Writes to c1/c2, returns dist². */
function segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z, c1, c2) {
	const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
	const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
	const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
	const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
	let s, t;
	if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
	else if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
	else {
		const c = d1x * rx + d1y * ry + d1z * rz;
		if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
		else {
			const b = d1x * d2x + d1y * d2y + d1z * d2z, denom = a * e - b * b;
			s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
			t = (b * s + f) / e;
			if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
			else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
		}
	}
	c1[0] = p1x + d1x * s; c1[1] = p1y + d1y * s; c1[2] = p1z + d1z * s;
	c2[0] = p2x + d2x * t; c2[1] = p2y + d2y * t; c2[2] = p2z + d2z * t;
	const x = c1[0] - c2[0], y = c1[1] - c2[1], z = c1[2] - c2[2];
	return x * x + y * y + z * z;
}

const _a = new Float64Array(3), _b = new Float64Array(3);
/** Squared distance between segment p0-p1 and the triangle; closest points to cs (segment) / ct (triangle). */
function segTriDist2(p0x, p0y, p0z, p1x, p1y, p1z, T, o, cs, ct) {
	// Segment crossing the triangle?
	const nx = T[o + 9], ny = T[o + 10], nz = T[o + 11];
	const s0 = (p0x - T[o]) * nx + (p0y - T[o + 1]) * ny + (p0z - T[o + 2]) * nz;
	const s1 = (p1x - T[o]) * nx + (p1y - T[o + 1]) * ny + (p1z - T[o + 2]) * nz;
	if ((s0 <= 0 && s1 >= 0) || (s0 >= 0 && s1 <= 0)) {
		const den = s0 - s1;
		const u = Math.abs(den) > 1e-12 ? s0 / den : 0;
		const ix = p0x + (p1x - p0x) * u, iy = p0y + (p1y - p0y) * u, iz = p0z + (p1z - p0z) * u;
		if (pointInTri(ix, iy, iz, T, o)) {
			cs[0] = ct[0] = ix; cs[1] = ct[1] = iy; cs[2] = ct[2] = iz;
			return 0;
		}
	}
	let best = closestPtTri(p0x, p0y, p0z, T, o, _a);
	cs[0] = p0x; cs[1] = p0y; cs[2] = p0z; ct[0] = _a[0]; ct[1] = _a[1]; ct[2] = _a[2];
	let d = closestPtTri(p1x, p1y, p1z, T, o, _a);
	if (d < best) { best = d; cs[0] = p1x; cs[1] = p1y; cs[2] = p1z; ct[0] = _a[0]; ct[1] = _a[1]; ct[2] = _a[2]; }
	for (let e = 0; e < 3; e++) {
		const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
		d = segSeg(p0x, p0y, p0z, p1x, p1y, p1z, T[a], T[a + 1], T[a + 2], T[b], T[b + 1], T[b + 2], _a, _b);
		if (d < best) { best = d; cs[0] = _a[0]; cs[1] = _a[1]; cs[2] = _a[2]; ct[0] = _b[0]; ct[1] = _b[1]; ct[2] = _b[2]; }
	}
	return best;
}
