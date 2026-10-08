// 轮回地标：一座残破的石龛。
//
// 它固定在环面的某个坐标上，按 2D 晶格复制；每帧只把"离玩家最近的那一份"
// 摆到正确位置。于是玩家每绕一圈就会再遇到它一次 —— 这不是 bug，是"似曾相识"。
//
// 注意：绝对不能做成"世界上唯一一份、位置固定"。那样玩家绕一圈发现它不见了，
// 机制当场穿帮。

import * as THREE from 'three';
import { terrainHeight } from '../core/noise.js';
import { mulberry32 } from '../core/rng.js';

function boxMesh(w, h, d, mat) {
	const g = new THREE.BoxGeometry(w, h, d);
	return new THREE.Mesh(g, mat);
}

export class Landmark {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.root = new THREE.Group();
		scene.add(this.root);

		const stone = new THREE.MeshStandardMaterial({
			color: cfg.palette.stone,
			roughness: 0.98,
			metalness: 0,
			flatShading: true,
		});
		const dark = new THREE.MeshStandardMaterial({
			color: cfg.palette.stoneDark,
			roughness: 1,
			metalness: 0,
			flatShading: true,
		});
		this.darkMat = dark;

		const rnd = mulberry32(18932);

		// ── 基础结构：两根立柱 + 倒伏的横梁 ──────────────────────
		this.base = new THREE.Group();
		this.pillarL = boxMesh(0.46, 3.4, 0.46, stone);
		this.pillarL.position.set(-1.15, 1.7, 0);
		this.pillarR = boxMesh(0.42, 2.5, 0.42, stone);
		this.pillarR.position.set(1.15, 1.25, 0);
		this.pillarR.rotation.z = -0.26; // 一开始就有点歪，后面会越来越歪
		this.lintel = boxMesh(2.9, 0.36, 0.5, stone);
		this.lintel.position.set(0.35, 1.05, 0.55);
		this.lintel.rotation.set(0.42, 0.24, 0.62);
		const base = boxMesh(3.4, 0.22, 3.4, dark);
		base.position.y = 0.05;
		this.base.add(this.pillarL, this.pillarR, this.lintel, base);

		// 碎石环
		this.stones = new THREE.Group();
		for (let i = 0; i < 14; i++) {
			const s = 0.14 + rnd() * 0.26;
			const m = boxMesh(s * (0.8 + rnd() * 0.8), s * (0.5 + rnd() * 0.5), s, rnd() < 0.5 ? stone : dark);
			const a = (i / 14) * Math.PI * 2 + rnd() * 0.3;
			const r = 2.0 + rnd() * 1.2;
			m.position.set(Math.cos(a) * r, s * 0.3, Math.sin(a) * r);
			m.rotation.set(rnd(), rnd() * 3, rnd());
			this.stones.add(m);
		}
		this.base.add(this.stones);

		// ── 锈灯 ────────────────────────────────────────────────
		this.lantern = new THREE.Group();
		const cage = boxMesh(0.24, 0.32, 0.24, dark);
		const flame = new THREE.Mesh(
			new THREE.SphereGeometry(0.075, 6, 6),
			new THREE.MeshBasicMaterial({ color: cfg.palette.lantern, fog: false }),
		);
		this.flame = flame;
		const arm = boxMesh(0.06, 0.06, 0.9, dark);
		arm.position.set(0, 0, -0.45);
		this.lantern.add(cage, flame, arm);
		this.lantern.position.set(-1.15, 2.55, 0.42);
		this.base.add(this.lantern);

		this.light = new THREE.PointLight(cfg.palette.lantern, 0, 18, 2);
		this.light.position.copy(this.lantern.position);
		this.base.add(this.light);

		// ── 随阶段出现的"腐坏"细节 ──────────────────────────────
		// 全部预先建好，只切换可见性 —— 运行时不再分配内存
		this.stageExtras = [];

		// 阶段 1：更多倒下的碎石
		const s1 = new THREE.Group();
		for (let i = 0; i < 10; i++) {
			const s = 0.2 + rnd() * 0.4;
			const m = boxMesh(s, s * 0.6, s * 1.3, dark);
			m.position.set((rnd() - 0.5) * 5, s * 0.3, (rnd() - 0.5) * 5);
			m.rotation.set(rnd(), rnd() * 3, rnd());
			s1.add(m);
		}
		this.stageExtras.push(s1);

		// 阶段 2：挂上破布
		const s2 = new THREE.Group();
		for (let i = 0; i < 4; i++) {
			const cloth = new THREE.Mesh(
				new THREE.PlaneGeometry(0.34 + rnd() * 0.3, 0.7 + rnd() * 0.8, 1, 3),
				new THREE.MeshStandardMaterial({ color: 0x5a564c, roughness: 1, side: THREE.DoubleSide }),
			);
			cloth.position.set(-1.15 + (i - 1.5) * 0.4, 2.1 - rnd() * 0.3, 0.24);
			cloth.rotation.y = 0.2 * i;
			s2.add(cloth);
		}
		this.stageExtras.push(s2);

		// 阶段 3：地上出现一排小石块，像有人摆过
		const s3 = new THREE.Group();
		for (let i = 0; i < 9; i++) {
			const m = boxMesh(0.12, 0.09, 0.12, stone);
			m.position.set(-1.6 + i * 0.4, 0.1, -1.9);
			m.rotation.y = rnd() * 3;
			s3.add(m);
		}
		this.stageExtras.push(s3);

		// 阶段 4：有人站在那里
		const s4 = this._makeFigure(dark);
		this.stageExtras.push(s4);

		for (const g of this.stageExtras) {
			g.visible = false;
			this.base.add(g);
		}

		this.root.add(this.base);
		this.stage = -1;
		this.setStage(0);
		this.dist = Infinity;
		this._wasNear = false;
		this._bellCooldown = 0;
		this._t = 0;
	}

	_makeFigure(mat) {
		const g = new THREE.Group();
		const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.35, 6), mat);
		body.position.y = 1.35;
		const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 6), mat);
		head.position.y = 2.12;
		head.scale.set(0.85, 1.45, 0.85);
		head.rotation.z = 0.4;
		g.add(body, head);
		for (const sx of [-1, 1]) {
			const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, 1.25, 5), mat);
			arm.position.set(sx * 0.24, 1.5, 0);
			arm.rotation.z = sx * 0.06;
			const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.045, 1.35, 5), mat);
			leg.position.set(sx * 0.12, 0.68, 0);
			arm.position.y = 1.55;
			g.add(arm, leg);
		}
		// 站在神龛正后方一点点，正对玩家
		g.position.set(0.4, 0, -1.5);
		return g;
	}

	setStage(s) {
		s = Math.max(0, Math.min(this.stageExtras.length, s | 0));
		if (s === this.stage) return;
		this.stage = s;
		for (let i = 0; i < this.stageExtras.length; i++) {
			this.stageExtras[i].visible = i < s;
		}
		// 立柱越来越歪
		this.pillarL.rotation.z = s * 0.055;
		this.pillarR.rotation.z = -0.26 + s * 0.03;
		// 灯的颜色：橙 → 红
		const warm = new THREE.Color(this.cfg.palette.lantern);
		const red = new THREE.Color(this.cfg.palette.lanternLate);
		const c = warm.clone().lerp(red, Math.min(1, s / 3));
		this.light.color.copy(c);
		this.flame.material.color.copy(c);
	}

	update(dt, px, pz) {
		const T = this.cfg.world.tile;
		const lx = this.cfg.director.landmark.x * T;
		const lz = this.cfg.director.landmark.z * T;
		// 最近的晶格复制
		const nx = lx + Math.round((px - lx) / T) * T;
		const nz = lz + Math.round((pz - lz) / T) * T;
		this.root.position.set(nx, terrainHeight(nx, nz, this.cfg), nz);

		this._t += dt;
		this.dist = Math.hypot(nx - px, nz - pz);

		// 灯只在近处点亮：省一次点光源计算，也让"走近才看见"更有仪式感
		const near = this.dist < 46;
		this.light.intensity = near ? 2.6 + Math.sin(this._t * 11.3) * 0.5 + Math.sin(this._t * 27.1) * 0.3 : 0;

		this._bellCooldown -= dt;
		let ring = false;
		if (this.dist < 30 && !this._wasNear && this._bellCooldown <= 0) {
			ring = true;
			this._bellCooldown = 20;
		}
		this._wasNear = this.dist < 30;
		return ring;
	}
}
