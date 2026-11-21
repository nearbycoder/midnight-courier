// Unreal-style math. The simulation runs in Unreal's frame (X forward, Y right, Z up, left-handed) but in
// metres; only the renderer sees three.js space. Conversion: three = (ue.x, ue.z, ue.y), which is a mirror,
// so a rotation R becomes M R M and a quaternion (x, y, z, w) becomes (-x, -z, -y, w).
import * as THREE from 'three';

export const PI = Math.PI;
export const HALF_PI = Math.PI / 2;
export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const randRange = (a, b) => a + Math.random() * (b - a);
export const smoothStep = (a, b, x) => { if (x < a) return 0; if (x >= b) return 1; const t = (x - a) / (b - a); return t * t * (3 - 2 * t); };

/** FMath::FInterpTo */
export function finterp(cur, target, dt, speed) {
	if (speed <= 0) return target;
	const d = target - cur;
	if (d * d < 1e-8) return target;
	return cur + d * clamp(dt * speed, 0, 1);
}
/** FMath::FindDeltaAngleDegrees */
export function deltaAngleDeg(a, b) {
	let d = (b - a) % 360;
	if (d > 180) d -= 360; else if (d < -180) d += 360;
	return d;
}
export function deltaAngleRad(a, b) {
	let d = (b - a) % (2 * PI);
	if (d > PI) d -= 2 * PI; else if (d < -PI) d += 2 * PI;
	return d;
}
/** FMath::InterpEaseOut */
export function easeOut(a, b, alpha, exp) {
	return lerp(a, b, 1 - Math.pow(1 - alpha, exp));
}

// ---- rotations in Unreal space ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();

/** FRotator(pitch, yaw, roll) in degrees -> quaternion (Unreal's FRotationMatrix convention). */
export function rotatorQuat(pitch, yaw, roll, out = new THREE.Quaternion()) {
	const p = pitch * DEG, y = yaw * DEG, r = roll * DEG;
	const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(r), CR = Math.cos(r);
	// Rows of FRotationMatrix are the rotated axes; use them as columns.
	_m.set(
		CP * CY, SR * SP * CY - CR * SY, -(CR * SP * CY + SR * SY), 0,
		CP * SY, SR * SP * SY + CR * CY, CY * SR - CR * SP * SY, 0,
		SP, -SR * CP, CR * CP, 0,
		0, 0, 0, 1,
	);
	return out.setFromRotationMatrix(_m);
}
/** FRotator::Vector() */
export function rotatorVector(pitch, yaw, out = new THREE.Vector3()) {
	const p = pitch * DEG, y = yaw * DEG;
	return out.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p));
}
/** FVector::Rotation() -> {pitch, yaw, roll} degrees */
export function vectorRotation(v) {
	return { pitch: Math.atan2(v.z, Math.hypot(v.x, v.y)) / DEG, yaw: Math.atan2(v.y, v.x) / DEG, roll: 0 };
}
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
/** FRotationMatrix::MakeFromXZ(X, Z) as a quaternion. */
export function makeFromXZ(X, Z, out = new THREE.Quaternion()) {
	_x.copy(X).normalize();
	_z.copy(Z).normalize();
	if (Math.abs(_x.dot(_z)) > 1 - 1e-4) { _z.set(Math.abs(_x.z) < 1 - 1e-4 ? 0 : 1, 0, Math.abs(_x.z) < 1 - 1e-4 ? 1 : 0); }
	_y.crossVectors(_z, _x).normalize();
	_z.crossVectors(_x, _y);
	_m.makeBasis(_x, _y, _z);
	return out.setFromRotationMatrix(_m);
}
/** FRotationMatrix::MakeFromXY(X, Y) as a quaternion. */
export function makeFromXY(X, Y, out = new THREE.Quaternion()) {
	_x.copy(X).normalize();
	_y.copy(Y).normalize();
	if (Math.abs(_x.dot(_y)) > 1 - 1e-4) { _y.set(0, 0, 1); }
	_z.crossVectors(_x, _y).normalize();
	_y.crossVectors(_z, _x);
	_m.makeBasis(_x, _y, _z);
	return out.setFromRotationMatrix(_m);
}
/** Quaternion -> FRotator (degrees), Unreal's FQuat::Rotator() for our use (no gimbal handling needed). */
export function quatRotator(q) {
	_m.makeRotationFromQuaternion(q);
	const e = _m.elements; // column-major: X axis = e[0..2], Y axis = e[4..6], Z axis = e[8..10]
	const pitch = Math.asin(clamp(e[2], -1, 1)) / DEG;
	const yaw = Math.atan2(e[1], e[0]) / DEG;
	const roll = Math.atan2(-e[6], e[10]) / DEG;
	return { pitch, yaw, roll };
}

// ---- Unreal -> three -------------------------------------------------------------------------------------
export function v3(ueX, ueY, ueZ, out = new THREE.Vector3()) { return out.set(ueX, ueZ, ueY); }
export function toThreeVec(v, out = new THREE.Vector3()) { return out.set(v.x, v.z, v.y); }
export function toThreeQuat(q, out = new THREE.Quaternion()) { return out.set(-q.x, -q.z, -q.y, q.w); }
export function fromThreeVec(v, out = new THREE.Vector3()) { return out.set(v.x, v.z, v.y); }
export function fromThreeQuat(q, out = new THREE.Quaternion()) { return out.set(-q.x, -q.z, -q.y, q.w); }

/** Sets a three Object3D's local transform from an Unreal-space location (metres) and rotation. */
export function setUE(obj, loc, quat) {
	obj.position.set(loc.x, loc.z, loc.y);
	if (quat) obj.quaternion.set(-quat.x, -quat.z, -quat.y, quat.w);
}

export function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
