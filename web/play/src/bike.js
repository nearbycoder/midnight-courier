// The courier's bike: a port of AMcBike (Source/MidnightCourier/McBike.cpp).
// Physics is hand-rolled at a fixed 240 Hz in metres, in Unreal's frame (X fwd, Y right, Z up): a rigid body
// in the vertical plane on two sphere-swept wheels with spring/damper suspension and rim strikes, an arcade
// grip/slide model, a swept capsule for walls, air control, a second spring for the rider's legs carrying
// the package, and the damage model. Plus the procedural rider, the chase camera and wheel spray.
import * as THREE from 'three';
import { Hit } from './collision.js';
import {
	PI, HALF_PI, DEG, clamp, finterp, deltaAngleDeg, deltaAngleRad, randRange, sign, lerp,
	rotatorQuat, rotatorVector, vectorRotation, makeFromXZ, makeFromXY, toThreeQuat, setUE,
} from './math.js';

// =====================================================================================================
// Tuning. Units: metres, seconds, radians. Accelerations are per unit mass (the bike+rider weighs "1").
// =====================================================================================================
export const Tune = {
	G: 9.81,
	StepHz: 240,
	// geometry
	HalfBase: 0.525, WheelR: 0.34, ProbeR: 0.22, Ext: 0.11, MaxComp: 0.11, EdgeLift: 1.3, Sag: 0.035,
	// suspension (per wheel)
	K: 140, C: 7.5, PitchInertia: 0.525 * 0.525 * 0.85,
	// rider legs (the package rides on the rider's back)
	SeatK: 240, SeatC: 18, SeatMin: -0.19, SeatMax: 0.10, SeatCap: 3.9 * 9.81,
	BraceK: 80, BraceC: 10, BraceMin: -0.30, BraceMax: 0.16, BraceCap: 4.2 * 9.81,
	// drive
	Power: 12, PedalAccelMax: 3.6, CadenceFull: 12.5, CadenceZero: 16.5, BrakeDecel: 7.5, RollRes: 0.05, Drag: 0.0042, DriftDecel: 1.6,
	// steering
	MinRadius: 1.9, LeanTurn: 9.5, Grip: 16, DriftGrip: 2.0,
	// damage
	RattleThreshold: 0.5, RattleScale: 0.6, RattleExp: 1.3,
	LegThreshold: 0.8, LegScale: 2.2, LegExp: 1.2,
	WallThreshold: 1.6, WallScale: 1.5, WallExp: 1.5,
	GSafe: 2.7, GScale: 1.1, GExp: 1.7,
	CrashDamage: 22, CrashWallSpeed: 8.5, PerfectWindow: 0.40, PerfectScale: 0.2,
};

/** Two-bone IK in a plane given by a hint direction. Returns the middle joint. */
function solveIK(A, Target, L1, L2, Hint, out = new THREE.Vector3()) {
	const D = Target.clone().sub(A);
	let dist = D.length();
	dist = clamp(dist, Math.abs(L1 - L2) + 0.01, (L1 + L2) * 0.999);
	const dir = D.lengthSq() > 1e-12 ? D.normalize() : new THREE.Vector3(1, 0, 0);
	const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
	const sinA = Math.sqrt(1 - cosA * cosA);
	const perp = Hint.clone().addScaledVector(dir, -Hint.dot(dir));
	if (perp.lengthSq() < 1e-10) perp.set(0, 0, 1); else perp.normalize();
	return out.copy(A).addScaledVector(dir, cosA * L1).addScaledVector(perp, sinA * L1);
}

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 0, 1), FWD = V(1, 0, 0), YAX = V(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class Bike {
	/**
	 * @param {object} env  { collision, water: [{x0,y0,x1,y1,z}], settings, time() }
	 * @param {object} view three objects built by world.js: { root, frame, parts, rider, lights, spray }
	 */
	constructor(env, view, { ghost = false } = {}) {
		this.env = env;
		this.view = view;
		this.ghost = ghost;
		this.input = { throttle: 0, brake: 0, steer: 0, lean: 0, brace: false, drift: false };
		this.pendingShocks = [];
		this.pendingLandings = [];
		this.justHopped = false;
		this.justTookOff = false;
		this.invincible = false;
		this.hit = new Hit();

		// physics state (metres, radians)
		this.px = 0; this.py = 0; this.pz = 0; this.vx = 0; this.vy = 0; this.vz = 0;
		this.yaw = 0; this.yawRate = 0; this.pitch = 0; this.pitchRate = 0; this.lean = 0; this.steerSmooth = 0;
		this.compression = [0, 0]; this.groundPrev = [0, 0]; this.contactPrev = [false, false]; this.contact = [false, false];
		this.groundNormal = [V(0, 0, 1), V(0, 0, 1)];
		this.strikeTimer = [0, 0]; this.strikePeak = [0, 0];
		this.torsoU = 0; this.torsoV = 0; this.braceHold = 0; this.braceReleasedAgo = 10; this.bracePressedAgo = 10;
		this.braced = false; this.bracePrev = false; this.packageG = 1;
		this.packageWobble = [0, 0]; this.packageWobbleV = [0, 0]; this.packageBounce = 0; this.packageBounceV = 0;
		this.condition = 100; this.grounded = false; this.airTime = 0; this.groundTime = 0; this.airApexZ = 0;
		this.landingWindow = 0; this.pendingLanding = null; this.landingOpen = false;
		this.driftActive = false; this.slip = 0; this.roll = 0; this.shake = 0;
		this.wheelAngle = 0; this.crankAngle = 0; this.accumulator = 0;
		this.frozen = true; this.crashed = false; this.crashTime = 0;
		this.crashVel = V(); this.crashSpin = V(); this.crashRot = new THREE.Quaternion(); this.crashPos = V();
		this.packFlyPos = V(); this.packFlyVel = V(); this.packFlyRot = new THREE.Quaternion(); this.packFlySpin = V();
		this.standBlend = 0;
		this.recordedCrouch = 0; this.useRecordedPose = false;

		// frame transform (Unreal space, metres) — updated by updateVisuals
		this.frameLoc = V(); this.frameQuat = new THREE.Quaternion();
		this.packLoc = V(); this.packQuat = new THREE.Quaternion();

		// camera
		this.camPos = V(); this.camYaw = 0; this.camPitch = -10; this.camFov = 80; this.camDist = 4.2; this.camInit = false;
		this.cameraOverride = false; this.overrideLoc = V(); this.overrideRot = { pitch: 0, yaw: 0, roll: 0 }; this.overrideFov = 60;
		this.camLoc = V(); this.camRot = { pitch: 0, yaw: 0, roll: 0 }; this.camFovOut = 80;

		// spray puffs
		this.puffs = [];
		for (let i = 0; i < 28; i++) this.puffs.push({ pos: V(), vel: V(), age: 10, life: 0.5, size: 0.3 });
		this.sprayAccum = 0; this.nextPuff = 0;
	}

	// ---- read-outs ------------------------------------------------------------------------------------
	getSpeed() { return Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz); }
	getForwardSpeed() { return this.vx * Math.cos(this.yaw) + this.vy * Math.sin(this.yaw); }
	getWorldLocation(out = V()) { return out.set(this.px, this.py, this.pz); }
	getWorldVelocity(out = V()) { return out.set(this.vx, this.vy, this.vz); }
	getYawDeg() { return this.yaw / DEG; }
	getPitchDeg() { return this.pitch / DEG; }
	getLeanDeg() { return this.lean / DEG; }
	getPackageWorldLocation(out = V()) { return out.copy(this.packLoc); }
	getHeadLampLocation(out = V()) { return out.set(0.58, 0, 0.40).applyQuaternion(this.frameQuat).add(this.frameLoc); }
	getHeadLampDirection(out = V()) { return rotatorVector(-9, 0, out).applyQuaternion(this.frameQuat); }

	setFrozen(f) { this.frozen = f; }

	/** Puts the bike on the ground at a world position (m) facing yaw (degrees), rolling at speed (m/s). */
	resetTo(pos, yawDeg, speed = 0) {
		const T = Tune;
		this.yaw = yawDeg * DEG;
		this.yawRate = 0;
		this.px = pos.x; this.py = pos.y; this.pz = pos.z + 1.0;
		const h = this.env.collision.raycast(pos.x, pos.y, pos.z + 4, pos.x, pos.y, pos.z - 30);
		if (h) this.pz = h[2] + 0.6;
		this.vx = Math.cos(this.yaw) * speed; this.vy = Math.sin(this.yaw) * speed; this.vz = 0;
		this.pitch = 0; this.pitchRate = 0; this.lean = 0; this.steerSmooth = 0;
		this.torsoU = 0; this.torsoV = 0;
		this.braced = false; this.bracePrev = false; this.braceHold = 0;
		this.crashed = false; this.crashTime = 0;
		this.airTime = 0; this.groundTime = 0;
		this.landingOpen = false;
		this.pendingShocks.length = 0;
		this.pendingLandings.length = 0;
		this.shake = 0;
		this.packageWobble = [0, 0]; this.packageWobbleV = [0, 0];
		for (let i = 0; i < 2; i++) { this.contactPrev[i] = false; this.compression[i] = 0; }
		const hubs = [0, 0];
		for (let i = 0; i < 2; i++) {
			const arm = (i === 0 ? 1 : -1) * T.HalfBase;
			const hx = this.px + Math.cos(this.yaw) * arm, hy = this.py + Math.sin(this.yaw) * arm;
			const p = this.probeWheel(hx, hy, this.pz);
			hubs[i] = p ? p.groundHub : this.pz - 0.6 + T.WheelR;
			this.groundPrev[i] = hubs[i];
		}
		this.pitch = Math.atan2(hubs[0] - hubs[1], 2 * T.HalfBase);
		this.pz = 0.5 * (hubs[0] + hubs[1]) + T.Ext - T.Sag;
		this.grounded = true;
		this.camInit = false;
		this.updateVisuals(0);
	}

	probeWheel(hx, hy, hubZ) {
		const T = Tune;
		const h = this.hit;
		if (!this.env.collision.sweepSphere(hx, hy, hubZ + 0.55, hx, hy, hubZ - (T.Ext + 0.45), T.ProbeR, h)) return null;
		if (h.startPen) return null;
		const r = this._probe || (this._probe = { groundHub: 0, n: V() });
		r.groundHub = h.loc[2] + (T.WheelR - T.ProbeR);
		r.n.set(h.impact[0], h.impact[1], h.impact[2]);
		return r;
	}

	sweepBody(fx, fy, fz, dx, dy, dz) {
		const F0 = Math.cos(this.yaw), F1 = Math.sin(this.yaw);
		const cp = Math.cos(this.pitch);
		const ax = F0 * cp, ay = F1 * cp, az = Math.sin(this.pitch);
		return this.env.collision.sweepCapsule(fx, fy, fz + 0.30, dx, dy, dz, ax, ay, az, 0.84 - 0.26, 0.26, this.hit) ? this.hit : null;
	}

	addShock(type, strength, damage) {
		if (this.ghost) return;
		if (this.landingOpen && (type === 'landing' || type === 'rattle')) {
			if (this.pendingLanding.perfect) damage *= Tune.PerfectScale;
			this.pendingLanding.damage += damage;
			this.pendingLanding.impactSpeed = Math.max(this.pendingLanding.impactSpeed, strength);
		}
		if (!this.invincible) this.condition = Math.max(0, this.condition - damage);
		this.shake = clamp(this.shake + strength * 0.12, 0, 1);
		this.packageWobbleV[0] += randRange(-1, 1) * strength * 1.4;
		this.packageWobbleV[1] += randRange(-1, 1) * strength * 1.4;
		this.packageBounceV -= strength * 0.25;
		if (damage > 0.05 || type === 'crash' || type === 'splash' || strength > 1.5) {
			this.pendingShocks.push({ type, strength, damage, loc: this.packLoc.clone() });
		}
	}

	crash(why) {
		if (this.crashed || this.ghost) return;
		this.crashed = true;
		this.crashTime = 0;
		this.crashWhy = why;
		const water = why === 'water';
		this.addShock(water ? 'splash' : 'crash', this.getSpeed(), water ? 30 : Tune.CrashDamage);
		this.crashVel.set(this.vx * 0.55, this.vy * 0.55, this.vz * 0.55 + 2.5);
		this.crashSpin.set(randRange(-6, 6), randRange(3, 7), randRange(-3, 3));
		this.crashRot.copy(this.frameQuat);
		this.crashPos.copy(this.frameLoc);
		this.packFlyPos.copy(this.packLoc);
		this.packFlyVel.set(this.vx * 0.9, this.vy * 0.9, this.vz * 0.9 + 4.2);
		this.packFlyRot.identity();
		this.packFlySpin.set(randRange(-9, 9), randRange(-9, 9), randRange(-4, 4));
	}

	tick(dt) {
		if (this.ghost) { this.updateVisuals(dt); return; }
		this.justHopped = false;
		this.justTookOff = false;
		dt = Math.min(dt, 0.05);
		if (this.crashed) this.stepCrash(dt);
		else if (!this.frozen) {
			this.accumulator += dt;
			const Dt = 1 / Tune.StepHz;
			let guard = 0;
			while (this.accumulator >= Dt && guard++ < 16) {
				this.step(Dt);
				this.accumulator -= Dt;
				if (this.crashed) break;
			}
		}
		this.shake = Math.max(0, this.shake - dt * 1.6);
		this.updateVisuals(dt);
		this.updateCamera(dt);
		this.updateSpray(dt);
	}

	step(Dt) {
		const T = Tune;
		const In = this.input;

		// ---- input shaping ----------------------------------------------------------------------------------
		this.steerSmooth = finterp(this.steerSmooth, clamp(In.steer, -1, 1), Dt, Math.abs(In.steer) > Math.abs(this.steerSmooth) ? 9 : 12);
		this.bracePressedAgo += Dt;
		this.braceReleasedAgo += Dt;
		if (In.brace && !this.bracePrev) { this.bracePressedAgo = 0; this.braceHold = 0; }
		if (In.brace) this.braceHold += Dt;
		let hop = false, hopCharge = 0;
		if (!In.brace && this.bracePrev) {
			this.braceReleasedAgo = 0;
			if (this.grounded && this.braceHold > 0.06) { hop = true; hopCharge = clamp(this.braceHold / 0.32, 0, 1); }
		}
		this.bracePrev = In.brace;
		this.braced = In.brace;

		const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
		const CosP = Math.cos(this.pitch), SinP = Math.sin(this.pitch);
		const VzStart = this.vz;

		// ---- wheels: where is the ground? -------------------------------------------------------------------
		const Ground = [0, 0];
		const Arm = [T.HalfBase * CosP, -T.HalfBase * CosP];
		const MountZ = [0, 0], MountV = [0, 0], Force = [0, 0];
		let anyContact = false;
		for (let i = 0; i < 2; i++) {
			this.strikeTimer[i] -= Dt;
			const sg = i === 0 ? 1 : -1;
			const hx = this.px + fx * (sg * T.HalfBase * CosP), hy = this.py + fy * (sg * T.HalfBase * CosP);
			MountZ[i] = this.pz + sg * T.HalfBase * SinP;
			MountV[i] = this.vz + Arm[i] * this.pitchRate;
			const p = this.probeWheel(hx, hy, MountZ[i]);
			this.contact[i] = !!p;
			let N = this.groundNormal[i];
			if (p) { Ground[i] = p.groundHub; N.copy(p.n); } else N.set(0, 0, 1);
			if (this.contact[i]) {
				this.compression[i] = Ground[i] - (MountZ[i] - T.Ext);
				if (this.compression[i] <= 0) this.contact[i] = false;
			} else {
				this.compression[i] = -1;
			}
			if (this.contact[i]) {
				anyContact = true;
				let groundRate;
				if (this.contactPrev[i]) {
					groundRate = (Ground[i] - this.groundPrev[i]) / Dt;
				} else {
					// First touch: how fast the surface under a moving wheel rises from its slope.
					groundRate = N.z > 0.3 ? -(N.x * this.vx + N.y * this.vy) / N.z : 0;
				}
				groundRate = clamp(groundRate, -14, 14);
				// Dampers see a bounded rate: a sharp edge shouldn't turn into a rocket.
				const compRate = clamp(groundRate - MountV[i], -8, 2.5);
				Force[i] = Math.max(0, T.K * Math.min(this.compression[i], T.MaxComp) + T.C * compRate);

				// Past the fork's travel: shift the body up instead of launching it, and only pass on a small
				// upward velocity, so smooth ramps still throw you but sharp edges just jolt.
				if (this.compression[i] > T.MaxComp) {
					const Pen = this.compression[i] - T.MaxComp;
					const InvM = 1 + Arm[i] * Arm[i] / T.PitchInertia;
					this.pz += Pen / InvM;
					this.pitch += Pen * (Arm[i] / T.PitchInertia) / InvM * 0.5;
					const Target = Math.min(groundRate, T.EdgeLift);
					const VRel = MountV[i] - Target;
					// Edges rising into the wheel hurt most; a wheel dropping onto a tread hurts half as much.
					const Jolt = Math.min(3.2, Math.max(0, groundRate) + 0.5 * Math.max(0, -MountV[i]));
					if (VRel < 0) {
						const InvMSoft = 1 + 0.5 * Arm[i] * Arm[i] / T.PitchInertia;
						const J = -VRel / InvMSoft;
						this.vz += J;
						this.pitchRate += 0.5 * J * Arm[i] / T.PitchInertia;
					}
					if (Jolt > 0) {
						// One edge is one strike: consecutive steps of the same climb only count their peak.
						if (this.strikeTimer[i] <= 0) this.strikePeak[i] = 0;
						this.strikeTimer[i] = 0.07;
						if (Jolt > this.strikePeak[i]) {
							const F = (j) => (j > T.RattleThreshold ? T.RattleScale * Math.pow(j - T.RattleThreshold, T.RattleExp) : 0);
							const Dmg = (F(Jolt) - F(this.strikePeak[i])) * (this.braced ? 0.4 : 1);
							// Each strike scrubs a little forward speed.
							const Fs = this.vx * fx + this.vy * fy;
							const scrub = clamp((Jolt - this.strikePeak[i]) * 0.12, 0, Math.abs(Fs) * 0.2) * sign(Fs);
							this.vx -= fx * scrub; this.vy -= fy * scrub;
							this.strikePeak[i] = Jolt;
							this.addShock('rattle', Jolt, Dmg);
						}
					}
					this.compression[i] = T.MaxComp;
				}
				this.groundPrev[i] = Ground[i];
			}
			this.contactPrev[i] = this.contact[i];
		}

		// ---- landing / takeoff bookkeeping -------------------------------------------------------------------
		const wasGrounded = this.grounded;
		if (anyContact) {
			this.groundTime += Dt;
			if (!wasGrounded) {
				if (this.airTime > 0.18) {
					// Touchdown. Open a short window to gather the damage this landing causes.
					this.landingOpen = true;
					this.landingWindow = 0.35;
					this.pendingLanding = {
						airTime: this.airTime, dropHeight: Math.max(0, this.airApexZ - this.pz), impactSpeed: -this.vz,
						damage: 0, braced: In.brace, perfect: In.brace && this.bracePressedAgo < T.PerfectWindow, sketchy: false,
					};
					// How well does the bike line up with the ground it lands on?
					const terrainPitch = this.contact[0] && this.contact[1] ? Math.atan2(Ground[0] - Ground[1], 2 * T.HalfBase * CosP) : this.pitch;
					const pitchErr = Math.abs((this.pitch - terrainPitch) / DEG);
					const speed2 = Math.hypot(this.vx, this.vy);
					const slipDeg = speed2 > 3 ? Math.acos(clamp((this.vx / speed2) * fx + (this.vy / speed2) * fy, -1, 1)) / DEG : 0;
					if ((pitchErr > 52 && -this.vz > 3) || slipDeg > 75) {
						this.crash('landing');
						return;
					}
					if (pitchErr > 26 || slipDeg > 35) {
						this.pendingLanding.sketchy = true;
						this.pendingLanding.perfect = false;
						this.addShock('landing', pitchErr * 0.1, pitchErr * 0.25);
						this.vx *= 0.85; this.vy *= 0.85;
					}
				}
				this.airTime = 0;
			}
		} else {
			if (wasGrounded) {
				this.airApexZ = this.pz;
				this.justTookOff = true;
			}
			this.airTime += Dt;
			this.airApexZ = Math.max(this.airApexZ, this.pz);
			this.groundTime = 0;
		}
		// Brief losses of contact (bumps, steps) don't count as being airborne.
		this.grounded = anyContact || (wasGrounded && this.airTime < 0.06);

		if (this.landingOpen) {
			this.landingWindow -= Dt;
			if (this.landingWindow <= 0) {
				this.landingOpen = false;
				this.pendingLandings.push(this.pendingLanding);
			}
		}

		// ---- vertical rigid body ---------------------------------------------------------------------------
		this.vz += (Force[0] + Force[1] - T.G) * Dt;
		this.pitchRate += (Force[0] * Arm[0] + Force[1] * Arm[1]) / T.PitchInertia * Dt;

		if (hop) {
			const Pop = 2.3 + 1.4 * hopCharge;
			this.vz += Pop;
			this.pitchRate += 1.2 + 1.0 * hopCharge;   // front wheel comes up first
			this.torsoV += 1.2;
			this.justHopped = true;
		}

		if (!anyContact) {
			// Air control: lean to rotate, plus a gentle pull of the nose toward the flight path.
			const flightAngle = Math.atan2(this.vz, Math.max(1, Math.hypot(this.vx, this.vy)));
			const assist = clamp(this.airTime * 2, 0, 1) * (Math.abs(In.lean) > 0.1 ? 0.25 : 1);
			this.pitchRate += (-In.lean * 7.5 + (clamp(flightAngle, -1.1, 0.6) - this.pitch) * 4 * assist) * Dt;
			this.pitchRate *= Math.exp(-1.2 * Dt);
		} else {
			this.pitchRate *= Math.exp(-2 * Dt);
		}

		// ---- horizontal ------------------------------------------------------------------------------------
		const numContacts = (this.contact[0] ? 1 : 0) + (this.contact[1] ? 1 : 0);
		const rx = -fy, ry = fx;
		let FwdSpeed = this.vx * fx + this.vy * fy;
		const LatSpeed = this.vx * rx + this.vy * ry;
		const AbsSpeed = Math.abs(FwdSpeed);
		this.driftActive = false;
		if (numContacts > 0) {
			const traction = numContacts === 2 ? 1 : 0.75;
			// Gravity along the slope the wheels sit on.
			const terrainPitch = numContacts === 2 ? Math.atan2(Ground[0] - Ground[1], 2 * T.HalfBase * CosP) : this.pitch;
			FwdSpeed += -T.G * Math.sin(terrainPitch) * Math.cos(terrainPitch) * Dt;

			// Pedalling (not while standing to brace).
			if (In.throttle > 0.01 && !this.braced && this.contact[1]) {
				const cadence = 1 - clamp((AbsSpeed - T.CadenceFull) / (T.CadenceZero - T.CadenceFull), 0, 1);
				const A = Math.min(T.PedalAccelMax, T.Power / Math.max(AbsSpeed, 1)) * cadence * In.throttle;
				FwdSpeed += A * Dt;
			}
			// Brakes and rolling resistance oppose motion and never reverse it.
			const oppose = (In.brake * T.BrakeDecel * traction + T.RollRes + (In.drift ? T.DriftDecel : 0)) * Dt;
			FwdSpeed = FwdSpeed > 0 ? Math.max(0, FwdSpeed - oppose) : Math.min(0, FwdSpeed + oppose);

			// Steering: a yaw-rate envelope that is tight at walking pace and lean-limited at speed.
			let maxRate = Math.min(AbsSpeed / T.MinRadius, T.LeanTurn / Math.max(AbsSpeed, 0.5) + 0.35);
			const drift = In.drift && AbsSpeed > 4;
			if (drift) { maxRate *= 1.6; this.driftActive = true; }
			if (this.braced) maxRate *= 0.85;
			const targetRate = this.steerSmooth * maxRate * (FwdSpeed >= 0 ? 1 : -1);
			this.yawRate = finterp(this.yawRate, targetRate, Dt, 11 * traction);
			this.yaw += this.yawRate * Dt;

			// Grip pulls the velocity back in line with the wheels; a slide bleeds speed.
			const nfx = Math.cos(this.yaw), nfy = Math.sin(this.yaw), nrx = -nfy, nry = nfx;
			const oy = this.yaw - this.yawRate * Dt;
			const orx = -Math.sin(oy), ory = Math.cos(oy);
			const vox = fx * FwdSpeed + orx * LatSpeed, voy = fy * FwdSpeed + ory * LatSpeed;
			let S = vox * nfx + voy * nfy;
			const L = vox * nrx + voy * nry;
			const gripNow = (drift ? T.DriftGrip : T.Grip) * traction;
			const LNew = L * Math.exp(-gripNow * Dt);
			const keep = drift ? 0.55 : 0.9;
			const gain = Math.max(0, L * L - LNew * LNew) * keep;
			S = (S >= 0 ? 1 : -1) * Math.sqrt(S * S + gain);
			this.vx = nfx * S + nrx * LNew; this.vy = nfy * S + nry * LNew;
			this.slip = finterp(this.slip, clamp(Math.abs(LNew) / 3, 0, 1), Dt, 8);
			this.roll = clamp(AbsSpeed / 12, 0, 1);
		} else {
			// Airborne: tiny yaw control, keep momentum.
			this.yawRate = finterp(this.yawRate, this.steerSmooth * 1.3, Dt, 3);
			this.yaw += this.yawRate * Dt;
			this.slip = finterp(this.slip, 0, Dt, 4);
			this.roll = 0;
		}

		// Aerodynamic drag on everything.
		{
			const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
			const dec = T.Drag * sp * sp * Dt;
			if (sp > 0.01) {
				const scale = Math.max(0, sp - dec) / sp;
				this.vx *= scale; this.vy *= scale;
				this.vz = this.vz * (anyContact ? 1 : scale);
			}
		}

		// ---- move, colliding the frame with walls -----------------------------------------------------------
		const hbx = this.vx, hby = this.vy;
		let Px = this.px, Py = this.py, Pz = this.pz;
		let Dx = this.vx * Dt, Dy = this.vy * Dt, Dz = 0;
		for (let iter = 0; iter < 3 && !(Math.abs(Dx) <= 1e-4 && Math.abs(Dy) <= 1e-4 && Math.abs(Dz) <= 1e-4); iter++) {
			const hit = this.sweepBody(Px, Py, Pz, Dx, Dy, Dz);
			if (!hit) { Px += Dx; Py += Dy; Pz += Dz; break; }
			if (hit.startPen) {
				const d = hit.depth + 0.005;
				Px += hit.normal[0] * d; Py += hit.normal[1] * d; Pz += hit.normal[2] * d;
				continue;
			}
			Px = hit.loc[0] + hit.normal[0] * 0.002; Py = hit.loc[1] + hit.normal[1] * 0.002; Pz = hit.loc[2] - 0.30 + hit.normal[2] * 0.002;
			let nx = hit.normal[0], ny = hit.normal[1];
			if (nx * nx + ny * ny < 0.04) break;
			const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
			const into = -(this.vx * nx + this.vy * ny);
			if (into > 0) {
				const restitution = 0.15;
				this.vx += nx * into * (1 + restitution); this.vy += ny * into * (1 + restitution);
				const frontal = Math.abs(Math.cos(this.yaw) * nx + Math.sin(this.yaw) * ny);
				// Scrape along the wall: turn the bike toward the slide direction.
				const sl = Math.hypot(this.vx, this.vy);
				if (sl > 1e-4 && frontal < 0.85) {
					let target = Math.atan2(this.vy, this.vx);
					if (FwdSpeed < 0) target += PI;
					this.yaw += deltaAngleRad(this.yaw, target) * 0.35;
				}
				this.yawRate *= 0.5;
				if (into > T.CrashWallSpeed && frontal > 0.6) {
					this.crash('wall');
					return;
				}
				const dmg = into > T.WallThreshold ? T.WallScale * Math.pow(into - T.WallThreshold, T.WallExp) : 0;
				this.addShock('wall', into, dmg);
			}
			const remaining = 1 - hit.time;
			const rdx = Dx * remaining, rdy = Dy * remaining, rdz = Dz * remaining;
			const dn = rdx * nx + rdy * ny;
			Dx = rdx - nx * dn; Dy = rdy - ny * dn; Dz = rdz;
		}
		this.px = Px; this.py = Py;

		// Vertical integration.
		this.pz += this.vz * Dt;
		this.pitchRate = clamp(this.pitchRate, -6, 6);
		this.pitch += this.pitchRate * Dt;
		this.pitch = clamp(this.pitch, -1.45, 1.45);

		// Fell in the water (or through the world)?
		for (const W of this.env.water) {
			if (this.px >= W.x0 && this.px <= W.x1 && this.py >= W.y0 && this.py <= W.y1 && this.pz < W.z + 0.3) {
				this.crash('water');
				return;
			}
		}
		if (this.pz < -3) { this.crash('water'); return; }

		// ---- the rider's legs and the package ----------------------------------------------------------------
		{
			const Az = (this.vz - VzStart) / Dt;   // vertical acceleration of the frame (includes -g in flight)
			const b = this.braced;
			const Kt = b ? T.BraceK : T.SeatK, Ct = b ? T.BraceC : T.SeatC, Cap = b ? T.BraceCap : T.SeatCap;
			const UMin = b ? T.BraceMin : T.SeatMin, UMax = b ? T.BraceMax : T.SeatMax;
			let Ft = clamp(Kt * (0 - this.torsoU) - Ct * this.torsoV, 0, Cap);
			const prevU = this.torsoU;
			this.torsoV += (Ft - T.G - Az) * Dt;
			this.torsoU += this.torsoV * Dt;
			if (this.torsoU < UMin && prevU < UMin - 0.002) {
				// Sitting back down from a crouch: the legs extend into the seated range, no harm done.
				this.torsoU = Math.min(UMin, prevU + 1.5 * Dt);
				this.torsoV = Math.max(this.torsoV, 0);
			} else if (this.torsoU < UMin) {
				// Legs (or seat) bottomed out: the package feels the whole remaining velocity at once.
				const hitV = -this.torsoV;
				this.torsoU = UMin;
				if (hitV > 0) {
					this.torsoV = 0;
					const dmg = hitV > T.LegThreshold ? T.LegScale * Math.pow(hitV - T.LegThreshold, T.LegExp) * (b ? 0.6 : 1) : 0;
					this.addShock('landing', hitV, dmg);
					Ft = Cap + hitV / Dt * 0.02;
				}
			} else if (this.torsoU > UMax) {
				this.torsoU = UMax;
				this.torsoV = Math.min(this.torsoV, 0);
			}
			const hax = (this.vx - hbx) / Dt, hay = (this.vy - hby) / Dt;
			const felt = Math.sqrt(Ft * Ft + (hax * hax + hay * hay) * 0.25) / T.G;
			this.packageG = lerp(this.packageG, felt, 0.25);
			if (felt > T.GSafe) {
				const dmg = T.GScale * Math.pow(felt - T.GSafe, T.GExp) * Dt;
				if (!this.invincible) this.condition = Math.max(0, this.condition - dmg);
				if (this.landingOpen) this.pendingLanding.damage += dmg;
			}
		}

		// Package wobble (visual): a damped spring kicked by accelerations.
		{
			const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
			const Fs = ((this.vx - hbx) * cy + (this.vy - hby) * sy) / Dt;
			const Ls = ((this.vx - hbx) * -sy + (this.vy - hby) * cy) / Dt;
			const kicks = [-Fs * 0.006, Ls * 0.006 + this.yawRate * FwdSpeed * 0.004];
			for (let k = 0; k < 2; k++) {
				this.packageWobbleV[k] += (-90 * this.packageWobble[k] - 5 * this.packageWobbleV[k]) * Dt + kicks[k] * Dt * 30;
				this.packageWobble[k] += this.packageWobbleV[k] * Dt;
				this.packageWobble[k] = clamp(this.packageWobble[k], -0.6, 0.6);
			}
			this.packageBounceV += (-160 * this.packageBounce - 7 * this.packageBounceV) * Dt;
			this.packageBounce += this.packageBounceV * Dt;
			this.packageBounce = clamp(this.packageBounce, -0.08, 0.08);
		}

		// Lean (visual + camera): what a real bike needs for this turn.
		{
			const sp = Math.abs(FwdSpeed);
			let target = this.grounded ? Math.atan(sp * this.yawRate / T.G) : this.lean * 0.98;
			if (this.driftActive) target *= 1.15;
			target = clamp(target, -0.85, 0.85);
			this.lean = finterp(this.lean, target, Dt, 7);
		}

		// Wheels and cranks.
		this.wheelAngle += FwdSpeed / T.WheelR * Dt;
		if (In.throttle > 0.05 && !this.braced && this.grounded) {
			this.crankAngle += clamp(FwdSpeed, 2, 14) / 2.2 * Dt * (0.6 + 0.4 * In.throttle);
		} else {
			// Coasting: feet come level (cranks horizontal).
			const level = Math.round((this.crankAngle - HALF_PI) / PI) * PI + HALF_PI;
			this.crankAngle = finterp(this.crankAngle, level, Dt, 5);
		}
		if (this.condition <= 0 && !this.invincible) this.condition = 0;
	}

	stepCrash(Dt) {
		const col = this.env.collision, h = this.hit;
		this.crashTime += Dt;
		this.crashVel.z -= 9.8 * Dt;
		const next = _v.copy(this.crashPos).addScaledVector(this.crashVel, Dt);
		if (col.sweepSphere(this.crashPos.x, this.crashPos.y, this.crashPos.z, next.x, next.y, next.z, 0.30, h)) {
			const N = _v2.set(h.normal[0], h.normal[1], h.normal[2]);
			next.set(h.loc[0], h.loc[1], h.loc[2]).addScaledVector(N, 0.01);
			const into = this.crashVel.dot(N);
			this.crashVel.addScaledVector(N, -into * 1.35).multiplyScalar(0.6);
			this.crashSpin.multiplyScalar(0.55);
		}
		this.crashPos.copy(next);
		const sl = this.crashSpin.length();
		if (sl > 1e-6) this.crashRot.premultiply(_q.setFromAxisAngle(_v2.copy(this.crashSpin).divideScalar(sl), sl * Dt)).normalize();

		this.packFlyVel.z -= 9.8 * Dt;
		const pn = _v.copy(this.packFlyPos).addScaledVector(this.packFlyVel, Dt);
		if (col.sweepSphere(this.packFlyPos.x, this.packFlyPos.y, this.packFlyPos.z, pn.x, pn.y, pn.z, 0.15, h)) {
			const N = _v2.set(h.normal[0], h.normal[1], h.normal[2]);
			pn.set(h.loc[0], h.loc[1], h.loc[2]).addScaledVector(N, 0.01);
			const into = this.packFlyVel.dot(N);
			this.packFlyVel.addScaledVector(N, -into * 1.4).multiplyScalar(0.55);
			this.packFlySpin.multiplyScalar(0.6);
		}
		this.packFlyPos.copy(pn);
		const ps = this.packFlySpin.length();
		if (ps > 1e-6) this.packFlyRot.premultiply(_q.setFromAxisAngle(_v2.copy(this.packFlySpin).divideScalar(ps), ps * Dt));
	}

	setPoseFromRecording(loc, rot, crank, wheelSpin, crouch) {
		this.useRecordedPose = true;
		this.px = loc.x; this.py = loc.y; this.pz = loc.z;
		this.yaw = rot.yaw * DEG; this.pitch = rot.pitch * DEG; this.lean = rot.roll * DEG;
		this.crankAngle = crank; this.wheelAngle = wheelSpin; this.torsoU = crouch;
		this.compression[0] = this.compression[1] = Tune.Sag;
	}

	// =================================================================================================
	// Visuals
	// =================================================================================================
	updateVisuals(dt) {
		const T = Tune;
		const hubDrop = T.WheelR + T.Ext - T.Sag;
		if (this.crashed) {
			this.frameLoc.copy(this.crashPos);
			this.frameQuat.copy(this.crashRot);
		} else {
			const yp = rotatorQuat(this.pitch / DEG, this.yaw / DEG, 0, _q);
			const leanQ = _q2.setFromAxisAngle(FWD, -this.lean); // lean into the turn (matches McBike.cpp)
			const pivot = -hubDrop;
			const lo = _v.set(0, 0, -pivot).applyQuaternion(leanQ); lo.z += pivot;
			lo.applyQuaternion(yp);
			this.frameLoc.set(this.px + lo.x, this.py + lo.y, this.pz + lo.z);
			this.frameQuat.copy(yp).multiply(leanQ);
		}
		const v = this.view;
		if (!v) { this.updateRider(dt); return; }
		setUE(v.frame, this.frameLoc, this.frameQuat);

		// Wheels sit at their suspension travel and spin.
		const spin = -this.wheelAngle / DEG;
		for (let i = 0; i < 2; i++) {
			const w = i === 0 ? v.parts.wheelF : v.parts.wheelR;
			const comp = clamp(this.compression[i] > 0 ? this.compression[i] : 0, 0, T.MaxComp);
			setUE(w, _v.set((i === 0 ? 1 : -1) * T.HalfBase, 0, -(T.Ext - comp)), rotatorQuat(spin, 0, 0, _q));
		}
		{
			const comp = clamp(this.compression[0] > 0 ? this.compression[0] : 0, 0, T.MaxComp);
			setUE(v.parts.fork, _v.set(T.HalfBase, 0, -(T.Ext - comp)), rotatorQuat(0, this.steerSmooth * 14, 0, _q));
		}
		this.updateRider(dt);
	}

	updateRider(dt) {
		// All positions in the frame's local space (cm). Body centre is the origin; X forward, Z up.
		const BB = V(2, 0, -18), CrankLen = 17, Seat = V(-20, 0, 58), Bars = V(44, 0, 64);
		const Thigh = 44, Shin = 44, UpperArm = 30, ForeArm = 28, TorsoLen = 56;
		const v = this.view;
		const crankDeg = this.crankAngle / DEG;
		if (v) setUE(v.parts.crank, _v.copy(BB).multiplyScalar(0.01), rotatorQuat(-crankDeg, 0, 0, _q));
		const Pedal = [V(), V()];
		for (let s = 0; s < 2; s++) {
			const A = this.crankAngle + (s === 0 ? 0 : PI);
			Pedal[s].set(BB.x + Math.sin(A) * CrankLen, (s === 0 ? -1 : 1) * 11, BB.z + Math.cos(A) * CrankLen);
			if (v) setUE(s === 0 ? v.parts.pedalL : v.parts.pedalR, _v.copy(Pedal[s]).multiplyScalar(0.01), _q.identity());
		}

		// Hips: on the saddle, or standing on the pedals when braced. TorsoU is the legs' spring.
		this.standBlend = finterp(this.standBlend, this.braced ? 1 : 0, dt, 9);
		if (this.crashed) this.standBlend = 0.5;
		const Stand = this.standBlend;
		const speed = this.getSpeed();
		const Lift = Stand * 30;
		const Hip = V(Seat.x - 6 * Stand, 0, Seat.z + 6 + Lift + this.torsoU * 100 * (0.35 + 0.65 * Stand));

		// Torso leans forward to the bars; more at speed (tuck) and when standing (attack position).
		const tuck = clamp(speed / 14, 0, 1);
		const torsoPitch = (38 - 8 * tuck + 6 * Stand + clamp(this.torsoV * 8, -10, 10)) * DEG;
		const TorsoDir = V(Math.cos(torsoPitch), 0, Math.sin(torsoPitch));
		const Neck = Hip.clone().addScaledVector(TorsoDir, TorsoLen);
		const TorsoUp = V().crossVectors(TorsoDir, YAX).normalize();

		// Package on the back: rides the torso, bounces and wobbles on its straps.
		{
			const Back = Hip.clone().addScaledVector(TorsoDir, TorsoLen * 0.55).addScaledVector(TorsoUp, 17 + this.packageBounce * 100).multiplyScalar(0.01);
			if (this.crashed) {
				this.packLoc.copy(this.packFlyPos);
				this.packQuat.copy(this.packFlyRot);
			} else {
				const base = makeFromXZ(TorsoDir, TorsoUp, _q);
				const wob = rotatorQuat(this.packageWobble[0] / DEG * 0.6, 0, this.packageWobble[1] / DEG * 0.6, _q2);
				const local = base.multiply(wob);
				this.packQuat.copy(this.frameQuat).multiply(local);
				this.packLoc.copy(Back).applyQuaternion(this.frameQuat).add(this.frameLoc);
			}
			if (v) setUE(v.parts.pack, this.packLoc, this.packQuat);
		}
		if (!v || !v.rider) return;

		// Legs: two-bone IK from hip to pedal, knees forward and slightly out.
		const HipJ = [], KneeJ = [], FootJ = [], ShJ = [], ElbowJ = [], GripJ = [];
		for (let s = 0; s < 2; s++) {
			const side = s === 0 ? -1 : 1;
			const H = Hip.clone().add(V(0, side * 10, 0));
			const Foot = Pedal[s].clone().add(V(-3, side * 2, 5));
			const Knee = solveIK(H, Foot, Thigh, Shin, V(1, side * 0.15, 0.4));
			HipJ[s] = H; KneeJ[s] = Knee; FootJ[s] = Foot;
		}
		// Arms: shoulders to the grips, elbows out and down.
		const Shoulder = Neck.clone().addScaledVector(TorsoDir, -5);
		const steerYaw = this.steerSmooth * 14 * DEG;
		for (let s = 0; s < 2; s++) {
			const side = s === 0 ? -1 : 1;
			const Sh = Shoulder.clone().add(V(0, side * 18, 0));
			const Grip = Bars.clone().add(V(Math.sin(steerYaw) * side * 27 * -1, side * 27 * Math.cos(steerYaw), 0));
			const Elbow = solveIK(Sh, Grip, UpperArm, ForeArm, V(-0.3, side * 0.8, -0.5));
			ShJ[s] = Sh; ElbowJ[s] = Elbow; GripJ[s] = Grip;
		}

		// Skinned rider: every bone aimed from its joint toward the next, relative to the modelled rest pose.
		const R = v.rider;
		const Rest = (n) => R.restUE[n];
		const BackOf = (d) => V().crossVectors(d, YAX).normalize();
		const Pelvis = Hip, Spine = Hip.clone().addScaledVector(TorsoDir, 20), Chest = Hip.clone().addScaledVector(TorsoDir, 38);
		const NeckJ = Neck.clone().addScaledVector(TorsoDir, -2);
		const HeadJ = Neck.clone().addScaledVector(TorsoDir, 4).add(V(0, 0, 5));
		const RP = Rest('pelvis'), RS = Rest('spine'), RC = Rest('chest'), RN = Rest('neck'), RH = Rest('head');
		const sub = (a, b) => a.clone().sub(b);
		this.poseBone('pelvis', Pelvis, sub(Spine, Pelvis), BackOf(sub(Spine, Pelvis)), sub(RS, RP), BackOf(sub(RS, RP)));
		this.poseBone('spine', Spine, sub(Chest, Spine), BackOf(sub(Chest, Spine)), sub(RC, RS), BackOf(sub(RC, RS)));
		this.poseBone('chest', Chest, sub(NeckJ, Chest), BackOf(sub(NeckJ, Chest)), sub(RN, RC), BackOf(sub(RN, RC)));
		this.poseBone('neck', NeckJ, sub(HeadJ, NeckJ), BackOf(sub(HeadJ, NeckJ)), sub(RH, RN), BackOf(sub(RH, RN)));
		{
			// Head stays upright and looks into the turn.
			const look = new THREE.Quaternion().setFromAxisAngle(UP, this.steerSmooth * 0.32);
			const restDir = V(3, 0, 22);
			this.poseBone('head', HeadJ, restDir.clone().applyQuaternion(look), YAX.clone().applyQuaternion(look), restDir, YAX, true);
		}
		const sfx = ['_l', '_r'];
		for (let s = 0; s < 2; s++) {
			const side = s === 0 ? -1 : 1;
			const x = sfx[s];
			const kneeHint = V(1, side * 0.15, 0.4), elbowHint = V(-0.3, side * 0.8, -0.5);
			const RTh = Rest('thigh' + x), RSh = Rest('shin' + x), RFt = Rest('foot' + x);
			const RUa = Rest('upperarm' + x), RFa = Rest('forearm' + x), RHd = Rest('hand' + x);
			this.poseBone('thigh' + x, HipJ[s], sub(KneeJ[s], HipJ[s]), kneeHint, sub(RSh, RTh), kneeHint);
			this.poseBone('shin' + x, KneeJ[s], sub(FootJ[s], KneeJ[s]), kneeHint, sub(RFt, RSh), kneeHint);
			const footDir = V(16, 0, -4);
			this.poseBone('foot' + x, FootJ[s], footDir, UP, footDir, UP);
			this.poseBone('upperarm' + x, ShJ[s], sub(ElbowJ[s], ShJ[s]), elbowHint, sub(RFa, RUa), elbowHint);
			this.poseBone('forearm' + x, ElbowJ[s], sub(GripJ[s], ElbowJ[s]), elbowHint, sub(RHd, RFa), elbowHint);
			const steer = new THREE.Quaternion().setFromAxisAngle(UP, steerYaw);
			const handDir = V(9, 0, -1);
			this.poseBone('hand' + x, GripJ[s], handDir.clone().applyQuaternion(steer), UP, handDir, UP);
		}
		R.apply();
	}

	poseBone(name, joint, dir, up, restDir, restUp, useXY = false) {
		const R = this.view.rider;
		const b = R.bones[name];
		if (!b) return;
		const newF = useXY ? makeFromXY(dir, up, _q) : makeFromXZ(dir, up, _q);
		const restF = useXY ? makeFromXY(restDir, restUp, _q2) : makeFromXZ(restDir, restUp, _q2);
		const D = newF.multiply(restF.invert());
		toThreeQuat(D, b.csQuat).multiply(b.restQuat3);
		if (!Number.isFinite(b.csQuat.x)) b.csQuat.copy(b.restQuat3);
		b.csPos.set(joint.x * 0.01, joint.z * 0.01, joint.y * 0.01);
	}

	// =================================================================================================
	// Camera
	// =================================================================================================
	snapCamera() { this.camInit = false; this.updateCamera(0); }

	updateCamera(dt) {
		if (this.ghost) return;
		const target = this.crashed ? this.crashPos : _v.set(this.px, this.py, this.pz);
		const speed = this.getSpeed();
		const velYawDeg = Math.hypot(this.vx, this.vy) > 2 ? Math.atan2(this.vy, this.vx) / DEG : this.getYawDeg();
		const headingYaw = this.getYawDeg();
		const desiredYaw = headingYaw + clamp(deltaAngleDeg(headingYaw, velYawDeg), -35, 35) * 0.5;
		const desiredPitch = -11 + clamp(this.getPitchDeg() * 0.45, -14, 8) - clamp(speed * 0.15, 0, 2);
		const desiredFov = 78 + clamp((speed - 6) * 1.3, 0, 16);
		const desiredDist = 4.0 + clamp(speed * 0.06, 0, 0.7);
		if (!this.camInit || dt <= 0) {
			this.camYaw = desiredYaw; this.camPitch = desiredPitch; this.camFov = desiredFov; this.camDist = desiredDist;
			this.camPos.copy(target);
			this.camInit = true;
		} else {
			const yawSpeed = this.grounded ? 7.5 : 2.5;
			this.camYaw += deltaAngleDeg(this.camYaw, desiredYaw) * Math.min(1, dt * yawSpeed);
			this.camPitch = finterp(this.camPitch, desiredPitch, dt, 3);
			this.camFov = finterp(this.camFov, desiredFov, dt, 2);
			this.camDist = finterp(this.camDist, desiredDist, dt, 2);
			// Follow the target tightly horizontally, softly vertically (landings read as a dip, not a jolt).
			this.camPos.x += (target.x - this.camPos.x) * Math.min(1, dt * 14);
			this.camPos.y += (target.y - this.camPos.y) * Math.min(1, dt * 14);
			this.camPos.z += (target.z - this.camPos.z) * Math.min(1, dt * (this.grounded ? 9 : 6));
		}
		const roll = this.lean / DEG * 0.18;
		const rotV = rotatorVector(this.camPitch, this.camYaw, V());
		const pivot = this.camPos.clone().add(V(0, 0, 1.5));
		const desired = pivot.clone().addScaledVector(rotV, -this.camDist).add(V(0, 0, 0.4));
		// Keep the camera out of walls.
		const h = this.hit;
		if (this.env.collision.sweepSphere(pivot.x, pivot.y, pivot.z, desired.x, desired.y, desired.z, 0.22, h)) {
			if (!h.startPen) desired.set(h.loc[0], h.loc[1], h.loc[2]);
		}
		// Shake from shocks.
		const t = this.env.time();
		const sh = this.shake * this.shake * (this.env.settings.shake / 10);
		const loc = desired.add(V(Math.sin(t * 61) * 0.03, Math.sin(t * 53 + 1) * 0.03, Math.sin(t * 71 + 2) * 0.04).multiplyScalar(sh));
		const look = vectorRotation(pivot.clone().addScaledVector(rotV, 3).sub(loc));
		look.roll = roll;
		look.pitch += Math.sin(t * 47) * 1.2 * sh;
		look.yaw += Math.sin(t * 39) * 0.8 * sh;
		this.camLoc.copy(loc);
		this.camRot = look;
		this.camFovOut = this.camFov;
		if (this.cameraOverride) {
			this.camLoc.copy(this.overrideLoc);
			this.camRot = { ...this.overrideRot };
			this.camFovOut = this.overrideFov;
		}
	}

	// =================================================================================================
	// Wheel spray: a small pool of camera-facing mist puffs.
	// =================================================================================================
	updateSpray(dt) {
		const speed = this.getSpeed();
		const rate = (this.grounded && !this.crashed && !this.frozen) ? clamp((speed - 3) * 3.5, 0, 45) * (1 + this.slip * 2) : 0;
		this.sprayAccum += rate * dt;
		const fwd = _v2.set(1, 0, 0).applyQuaternion(this.frameQuat).clone();
		while (this.sprayAccum >= 1) {
			this.sprayAccum -= 1;
			const P = this.puffs[this.nextPuff];
			this.nextPuff = (this.nextPuff + 1) % this.puffs.length;
			const rear = Math.random() < 0.7;
			const local = V((rear ? -1 : 1) * Tune.HalfBase - 0.2, randRange(-0.06, 0.06), -Tune.WheelR + 0.08);
			P.pos.copy(local).applyQuaternion(this.frameQuat).add(this.frameLoc);
			P.vel.set(this.vx * 0.35, this.vy * 0.35, this.vz * 0.35).addScaledVector(fwd, -randRange(0.8, 2.2))
				.add(V(randRange(-0.6, 0.6), randRange(-0.6, 0.6), randRange(0.8, 2.2)));
			P.age = 0;
			P.life = randRange(0.35, 0.7);
			P.size = randRange(0.18, 0.34) * (0.6 + 0.4 * clamp(speed / 12, 0, 1.5));
		}
		for (const P of this.puffs) {
			P.age += dt;
			if (P.age >= P.life) continue;
			P.vel.z -= 6 * dt;
			P.vel.multiplyScalar(Math.exp(-3 * dt));
			P.pos.addScaledVector(P.vel, dt);
		}
	}
}
