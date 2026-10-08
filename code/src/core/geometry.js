// 几何合并工具。
// 为什么不用 three/addons 的 mergeGeometries：这里的树是"每棵一个几何体、
// 上千个实例共用"，几何体必须保留索引（否则顶点吞吐翻倍，核显吃不消）。
// 自己写一个保索引的合并，既省依赖也省性能。

import * as THREE from 'three';

const ATTRS = [
	['position', 3],
	['normal', 3],
	['uv', 2],
];

export function mergeGeoms(geos) {
	let vCount = 0;
	let iCount = 0;
	for (const g of geos) {
		vCount += g.attributes.position.count;
		iCount += g.index ? g.index.count : g.attributes.position.count;
	}

	const buffers = {};
	for (const [name, size] of ATTRS) {
		buffers[name] = new Float32Array(vCount * size);
	}
	const index = new Uint32Array(iCount);

	let vo = 0;
	let io = 0;
	for (const g of geos) {
		const n = g.attributes.position.count;
		for (const [name, size] of ATTRS) {
			const a = g.attributes[name];
			if (a) buffers[name].set(a.array, vo * size);
		}
		if (g.index) {
			const ia = g.index.array;
			for (let k = 0; k < ia.length; k++) index[io++] = ia[k] + vo;
		} else {
			for (let k = 0; k < n; k++) index[io++] = k + vo;
		}
		vo += n;
	}

	const out = new THREE.BufferGeometry();
	for (const [name, size] of ATTRS) {
		out.setAttribute(name, new THREE.BufferAttribute(buffers[name], size));
	}
	out.setIndex(new THREE.BufferAttribute(index, 1));
	return out;
}

// 沿 +X 方向的二次弯曲：t 为归一化高度（0 = 根部，1 = 顶），用于树干。
export function bendGeometry(geo, amp, phi, height) {
	const pos = geo.attributes.position;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	for (let i = 0; i < pos.count; i++) {
		const t = height > 0 ? pos.getY(i) / height : 0;
		const d = amp * t * t;
		pos.setX(i, pos.getX(i) + d * cos);
		pos.setZ(i, pos.getZ(i) + d * sin);
	}
	pos.needsUpdate = true;
	return geo;
}

// ── Verlet 链（围巾 / 女鬼发丝共用的"布料"物理）────────────────
//
// 【为什么是 verlet 而不是弹簧-阻尼】verlet 的速度隐含在
// "上一帧位置 − 当前位置"里，约束（定长）直接投影位置即可满足，
// 没有显式速度就没有"弹簧过冲"要调 —— 两条链共用一个类，
// 各自只给三个数（段长 / 重力 / 阻尼），剩下的行为自己长出来。
//
// 【为什么不用骨骼动画】骨骼摆动是"预定的生命"，verlet 是
// "对世界的反应"：玩家急转弯、急停、跳跃落地，围巾都会给出
// 一次性的、方向正确的拖曳 —— 这正是"基础物理"最便宜的可见证明。
export class VerletChain {
	/**
	 * @param n 点数（含锚点）
	 * @param seg 每段长度（米）
	 * @param opts { gravity, damping, windX, windZ } 加速度（米/秒²）
	 */
	constructor(n, seg, opts = {}) {
		this.seg = seg;
		this.gravity = opts.gravity ?? 3.4;
		this.damping = opts.damping ?? 0.9;
		this.pts = Array.from({ length: n }, () => new THREE.Vector3());
		this.prev = Array.from({ length: n }, () => new THREE.Vector3());
		this._init = false;
	}

	// anchor：世界坐标锚点（调用方负责每帧取，比如挂点 getWorldPosition）。
	// wind：世界坐标的风加速度（负速度方向 + 颤动项，由调用方合成）。
	// dt 会被钳到 1/30：切页回来的第一帧不许把链子炸飞。
	step(anchor, wind, dt) {
		const h = Math.min(dt, 1 / 30);
		const pts = this.pts;
		const prev = this.prev;
		if (!this._init) {
			for (let i = 0; i < pts.length; i++) {
				pts[i].copy(anchor);
				prev[i].copy(anchor);
			}
			this._init = true;
		}
		pts[0].copy(anchor);
		prev[0].copy(anchor);
		const g = this.gravity * h * h;
		const wx = wind.x * h * h;
		const wz = wind.z * h * h;
		for (let i = 1; i < pts.length; i++) {
			const p = pts[i];
			const vx = (p.x - prev[i].x) * this.damping;
			const vy = (p.y - prev[i].y) * this.damping;
			const vz = (p.z - prev[i].z) * this.damping;
			prev[i].copy(p);
			p.x += vx + wx;
			p.y += vy - g;
			p.z += vz + wz;
		}
		// 定长约束，3 轮迭代：从锚点往外逐段投影。
		for (let k = 0; k < 3; k++) {
			for (let i = 1; i < pts.length; i++) {
				const a = pts[i - 1];
				const b = pts[i];
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let dz = b.z - a.z;
				const d = Math.hypot(dx, dy, dz) || 1e-6;
				const r = (d - this.seg) / d;
				b.x -= dx * r;
				b.y -= dy * r;
				b.z -= dz * r;
			}
		}
	}

	// 把链渲染成"一节节短棒"。meshes[i] 连接 pts[i] → pts[i+1]，
	// 由调用方建好（单位长度圆柱，原点居中）传进来。
	render(meshes) {
		const pts = this.pts;
		for (let i = 0; i < meshes.length; i++) {
			const a = pts[i];
			const b = pts[i + 1];
			const m = meshes[i];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dz = b.z - a.z;
			const d = Math.hypot(dx, dy, dz) || 1e-6;
			m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
			// 单位圆柱的 +Y 对准段方向；长度用 scale 补（段长会瞬时偏离 seg）
			m.quaternion.setFromUnitVectors(UP, TMP.set(dx / d, dy / d, dz / d));
			m.scale.set(1, d, 1);
		}
	}
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP = new THREE.Vector3();
