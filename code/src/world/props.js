// 大气道具：水汽、雾墙、雨、落叶。
//
// 全部挂在"跟随玩家"的组里，坐标存相对玩家的局部空间。
// 这是为了环面回绕：回绕时玩家坐标跳变 tile，但因为这些东西是相对的，
// 画面上一点都不会动。
//
// 另一个关键点：雾墙和落叶必须自己做环绕（wrap），否则它们会像贴纸一样
// 粘在玩家身上一起平移——那一眼就露馅了。

import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

export function softTexture(size = 128) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, 'rgba(255,255,255,0.92)');
	g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
	g.addColorStop(0.68, 'rgba(255,255,255,0.11)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

function cloudTexture(size = 256) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const rnd = mulberry32(5150);
	ctx.clearRect(0, 0, size, size);
	// 用一堆软斑堆出不规则形状，边缘必须软到看不出是四边形
	for (let i = 0; i < 46; i++) {
		const r = size * (0.09 + rnd() * 0.2);
		const x = size * (0.5 + (rnd() - 0.5) * 0.78);
		const y = size * (0.5 + (rnd() - 0.5) * 0.5);
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		g.addColorStop(0, 'rgba(255,255,255,0.26)');
		g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, 6.284);
		ctx.fill();
	}
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

const WRAP = (v, box) => {
	const h = box * 0.5;
	if (v > h) return v - box;
	if (v < -h) return v + box;
	return v;
};

export class Atmosphere {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.group = new THREE.Group();
		scene.add(this.group);

		this.wind = new THREE.Vector3(0.9, 0, 0.42).normalize();
		this.weather = 0;
		this.t = 0;
		this._buildMist();
		this._buildWalls();
		this._buildRain();
		this._buildLeaves();
	}

	_buildMist() {
		const W = this.cfg.world;
		const n = W.mistCount;
		const box = W.mistBox;
		const pos = new Float32Array(n * 3);
		const rnd = mulberry32(20731);
		for (let i = 0; i < n; i++) {
			pos[i * 3] = (rnd() - 0.5) * box;
			pos[i * 3 + 1] = rnd() * 15 - 1.5;
			pos[i * 3 + 2] = (rnd() - 0.5) * box;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.mistPos = pos;
		this.mist = new THREE.Points(
			geo,
			new THREE.PointsMaterial({
				map: softTexture(),
				size: 21,
				sizeAttenuation: true,
				transparent: true,
				opacity: 0.055,
				depthWrite: false,
				color: 0xc3cec6,
				fog: false,
			}),
		);
		this.mist.frustumCulled = false;
		this.group.add(this.mist);
	}

	_buildWalls() {
		const n = this.cfg.world.wallCount;
		const rnd = mulberry32(8801);
		const tex = cloudTexture();
		// 材质各自独立：需要逐片控制透明度与颜色
		this.walls = [];
		this.wallData = [];
		for (let i = 0; i < n; i++) {
			const mat = new THREE.MeshBasicMaterial({
				map: tex,
				transparent: true,
				opacity: 0.075,
				depthWrite: false,
				color: 0xbcc7bf,
				fog: false,
				side: THREE.DoubleSide,
			});
			const m = new THREE.Mesh(new THREE.PlaneGeometry(66, 30), mat);
			m.renderOrder = 900;
			m.frustumCulled = false;
			const ang = (i / n) * Math.PI * 2 + rnd();
			const dist = 22 + rnd() * 66;
			const d = {
				x: Math.cos(ang) * dist,
				z: Math.sin(ang) * dist,
				y: 4 + rnd() * 9,
				spin: (rnd() - 0.5) * 0.02,
				phase: rnd() * 100,
			};
			this.wallData.push(d);
			this.walls.push(m);
			this.group.add(m);
		}
	}

	_buildRain() {
		const n = this.cfg.world.rainCount;
		const pos = new Float32Array(n * 2 * 3);
		const base = new Float32Array(n * 3);
		const rnd = mulberry32(6621);
		const BOX = 44;
		for (let i = 0; i < n; i++) {
			base[i * 3] = (rnd() - 0.5) * BOX;
			base[i * 3 + 1] = rnd() * 24 - 2;
			base[i * 3 + 2] = (rnd() - 0.5) * BOX;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.rainBase = base;
		this.rainPos = pos;
		this.rainBox = BOX;
		this.rain = new THREE.LineSegments(
			geo,
			new THREE.LineBasicMaterial({
				color: 0xa9b6b0,
				transparent: true,
				opacity: 0.28,
				depthWrite: false,
				fog: true,
			}),
		);
		this.rain.frustumCulled = false;
		this.rain.visible = false;
		this.group.add(this.rain);
	}

	_buildLeaves() {
		const n = this.cfg.world.leafCount;
		const pos = new Float32Array(n * 3);
		const rnd = mulberry32(3391);
		const BOX = 46;
		for (let i = 0; i < n; i++) {
			pos[i * 3] = (rnd() - 0.5) * BOX;
			pos[i * 3 + 1] = rnd() * 12;
			pos[i * 3 + 2] = (rnd() - 0.5) * BOX;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		this.leafPos = pos;
		this.leafBox = BOX;
		this.leaves = new THREE.Points(
			geo,
			new THREE.PointsMaterial({
				map: softTexture(64),
				size: 0.17,
				sizeAttenuation: true,
				transparent: true,
				opacity: 0.55,
				depthWrite: false,
				color: 0x6b5a34,
				fog: true,
			}),
		);
		this.leaves.frustumCulled = false;
		this.group.add(this.leaves);
	}

	// 组跟着玩家走，但子项自己环绕 —— 这是"雾是环境不是贴纸"的关键
	update(dt, px, py, pz) {
		this.group.position.set(px, py, pz);
		this.t += dt;
		const t = this.t;

		const wx = this.wind.x;
		const wz = this.wind.z;
		const gust = 1 + 0.35 * Math.sin(t * 0.07);

		// 水汽
		const mp = this.mistPos;
		const box = this.cfg.world.mistBox;
		const drift = (0.55 + this.weather * 1.5) * gust * dt;
		for (let i = 0; i < mp.length; i += 3) {
			mp[i] = WRAP(mp[i] + wx * drift, box);
			mp[i + 1] += dt * 0.16;
			mp[i + 2] = WRAP(mp[i + 2] + wz * drift, box);
			if (mp[i + 1] > 14) mp[i + 1] = -1.5;
		}
		this.mist.geometry.attributes.position.needsUpdate = true;

		// 雾墙：朝相机做"仅偏航"的 billboard。
		// 组原点就是玩家位置，所以每片墙只需要转向原点。
		for (let i = 0; i < this.walls.length; i++) {
			const d = this.wallData[i];
			const m = this.walls[i];
			d.x = WRAP(d.x + wx * drift * 0.55, 180);
			d.z = WRAP(d.z + wz * drift * 0.55, 180);
			m.position.set(d.x, d.y + Math.sin(t * 0.11 + d.phase) * 0.5, d.z);
			// 平面默认朝 +Z，所以让它朝 (-d.x, -d.z)
			m.rotation.set(0, Math.atan2(-d.x, -d.z), 0);
			m.material.opacity = (0.05 + 0.08 * this.weather) * (0.75 + 0.25 * Math.sin(t * 0.13 + d.phase));
		}

		// ── 雨 ────────────────────────────────────────────────
		// 【"小雨淅淅沥沥"在视觉上是一条很具体的等式】
		//   密（雨滴多）+ 短（雨丝短）+ 直（几乎不斜）+ 淡（不抢戏）
		// 反过来就是"线痕"：稀疏、细长、明显倾斜 —— 那读起来不是雨，
		// 是屏幕上的划痕。所以这一版把雨丝长度砍到原来的一半以下，
		// 同时把雨滴数提上去（见 CFG.world.rainCount）。
		//
		// 长度仍然随 weather 增长：小雨是短促的"点点"，
		// 雨大起来才连成线 —— 这个变化本身就传达了雨势。
		//
		// 【为什么不再有 weather > 0.03 的开关】
		// 天气基线已经是 0.30（连阴雨），雨是常驻的。
		// 留一个几乎永不触发的分支只会让"雨什么时候出现"变得难以推理。
		this.rain.visible = true;
		{
			const rp = this.rainPos;
			const rb = this.rainBase;
			const speed = 9 + this.weather * 5.5;
			const slantX = wx * 1.05;
			const slantZ = wz * 1.05;
			const len = 0.13 + this.weather * 0.42;
			this.rain.material.opacity = 0.14 + 0.26 * this.weather;
			for (let i = 0, k = 0; i < rb.length; i += 3, k += 6) {
				rb[i + 1] -= speed * dt;
				if (rb[i + 1] < -3) {
					rb[i + 1] = 22;
					rb[i] = WRAP(rb[i] + 9.3, 44);
					rb[i + 2] = WRAP(rb[i + 2] + 5.1, 44);
				}
				rp[k] = rb[i];
				rp[k + 1] = rb[i + 1];
				rp[k + 2] = rb[i + 2];
				rp[k + 3] = rb[i] - slantX * len * 0.09;
				rp[k + 4] = rb[i + 1] + len;
				rp[k + 5] = rb[i + 2] - slantZ * len * 0.09;
			}
			this.rain.geometry.attributes.position.needsUpdate = true;
		}

		// 落叶
		const lp = this.leafPos;
		for (let i = 0; i < lp.length; i += 3) {
			lp[i] = WRAP(lp[i] + (wx * 1.1 + Math.sin(t * 0.9 + i) * 0.35) * dt, this.leafBox);
			lp[i + 1] -= dt * 0.22;
			lp[i + 2] = WRAP(lp[i + 2] + (wz * 1.1 + Math.cos(t * 0.7 + i) * 0.35) * dt, this.leafBox);
			if (lp[i + 1] < -0.2) lp[i + 1] = 11;
		}
		this.leaves.geometry.attributes.position.needsUpdate = true;
	}

	// 连阴雨的水汽比阵雨更"底"：湿度高、颗粒大、飘得慢。
	// 基线的抬升（0.045 → 0.052）就是"空气是湿的"这件事的全部代码。
	setWeather(w) {
		this.weather = w;
		this.mist.material.opacity = 0.052 + 0.06 * w;
		this.mist.material.size = 20 + 9 * w;
	}

	// 降画质：先砍水汽粒子数（几乎不可察觉），再砍雾墙
	reduceQuality(step) {
		if (step === 1) {
			const keep = Math.floor(this.cfg.world.mistCount * 0.5);
			this.mist.geometry.setDrawRange(0, keep);
		} else if (step === 2) {
			for (let i = 0; i < 5; i++) this.walls[i].visible = false;
		}
	}
}
