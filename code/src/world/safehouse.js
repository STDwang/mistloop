// 安全屋：你自己的山洞。
//
// ─────────────────────────────────────────────────────────────
// 【为什么"家"必须是山洞，而不是一间小屋或一座塔】
//
// 因为需求里的第三个条件是"逃回**自己的**山洞安全屋"——
// 这个"自己的"是整个目标系统的地基。玩家必须从一开始就**已经知道**
// 这个地方存在，只是找不到它在哪。山洞能满足这一点，小屋不能：
//   · 一间屋子是"别人的"，你会问"谁建的、为什么在这"；
//     一个山洞是"你的"，它不需要任何解释，它就是在那里。
//   · 山洞的入口可以极不起眼（一个黑色缺口），
//     所以它天然适配"我知道它在附近但看不见"。
//
// 【它是一个点，但不是一个"唯一副本"】
// 和其他地标一样按环面晶格取最近的一份。这不是"世界上有很多山洞"——
// 环面的周期正好是 196 m，一整个周期里只有这一个位置，
// 晶格只是让"跨过回绕边界时它还在正确的地方"这件事自动成立。
//
// 【方向必须是环面上最短的那一条】
// 直接相减会得到一条绕远路的方向（最多差 139 m）。
// 必须走 wrapDelta：把差值折回 [-T/2, T/2]。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { terrainHeight } from '../core/noise.js';
import { mulberry32 } from '../core/rng.js';
import { applyTextureSet } from '../core/textures.js';

function rock(w, h, d, mat) {
	return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

// 环面上的最短有向差。这是"朝向家"和"到家了没有"共用的唯一一段数学。
export function wrapDelta(d, T) {
	return d - Math.round(d / T) * T;
}

export class Safehouse {
	constructor(cfg, scene) {
		this.cfg = cfg;
		const S = cfg.safehouse;
		const T = cfg.world.tile;

		this.x = S.x * T;
		this.z = S.z * T;
		this.root = new THREE.Group();
		scene.add(this.root);

		const rnd = mulberry32(70417);
		const stone = new THREE.MeshStandardMaterial({
			color: 0x4a4b45,
			roughness: 0.97,
			metalness: 0,
			flatShading: true,
		});
		const dark = new THREE.MeshStandardMaterial({
			color: 0x2a2b27,
			roughness: 1,
			metalness: 0,
			flatShading: true,
		});
		// 真岩石贴图。和树皮同理：flatShading 的顶点法线会盖过贴图法线，
		// 所以贴图版关掉它。石块的"棱角"由 BoxGeometry 的硬边自己提供。
		if (cfg.textures?.enabled) {
			stone.flatShading = false;
			dark.flatShading = false;
			for (const m of [stone, dark]) {
				applyTextureSet(m, 'rock', {
					repeatX: cfg.textures.rockRepeat,
					repeatY: cfg.textures.rockRepeat,
					normalScale: 0.9,
				});
			}
			dark.color = new THREE.Color(0x6a6b64); // 深色版靠 color 压暗，贴图共享
		}
		// 洞口。纯黑、不受雾影响 —— 和鬼影同一个道理：
		// 在亮雾里，一个"什么都没有"的缺口比任何贴图都更像洞。
		this.mouthMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });

		// ── 岩体：几块大方石堆出一个坡 ─────────────────────────
		// 不用球/圆柱做山包：方形块面在 flatShading 下棱角分明，
		// 雾里那几道硬边就是"这是石头"的全部证据。
		const mass = new THREE.Group();
		const blocks = [
			[7.2, 5.4, 5.0, -1.6, 1.9, 0.6, 0.06],
			[5.6, 4.2, 4.4, 2.1, 1.4, -0.7, -0.11],
			[4.6, 3.4, 3.8, -3.4, 1.0, -1.8, 0.19],
			[6.4, 2.6, 5.2, 1.0, 0.8, 2.3, 0.04],
			[3.8, 2.2, 3.4, 3.6, 0.6, 1.6, -0.24],
		];
		for (const [w, h, d, x, y, z, ry] of blocks) {
			const m = rock(w, h, d, stone);
			m.position.set(x, y, z);
			m.rotation.y = ry;
			m.rotation.x = (rnd() - 0.5) * 0.08;
			mass.add(m);
		}

		// ── 洞口：两根立柱 + 一根压顶 + 洞里的黑 ─────────────────
		// 朝向固定在 -Z（root 不旋转），所以"从哪个方向能看见洞口"
		// 是一个确定的事实，不是随机的。
		const jambL = rock(1.3, 3.0, 1.5, stone);
		jambL.position.set(-1.75, 1.5, 2.0);
		jambL.rotation.z = 0.07;
		const jambR = rock(1.15, 2.5, 1.4, stone);
		jambR.position.set(1.6, 1.25, 1.95);
		jambR.rotation.z = -0.13;
		const cap = rock(4.9, 1.1, 1.9, dark);
		cap.position.set(-0.1, 3.35, 1.9);
		cap.rotation.z = 0.05;
		// 黑：贴在立柱之后，把"里面"交代掉
		const mouth = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.7), this.mouthMat);
		mouth.position.set(-0.05, 1.42, 2.72);
		mouth.renderOrder = 18;
		mass.add(jambL, jambR, cap, mouth);

		// ── 散落的碎石，让"这里有人住过"有一点痕迹 ──────────────
		for (let i = 0; i < 16; i++) {
			const s = 0.18 + rnd() * 0.42;
			const m = rock(s * 1.2, s * 0.7, s, rnd() < 0.5 ? stone : dark);
			const a = rnd() * Math.PI * 2;
			const r = 3.2 + rnd() * 4.5;
			m.position.set(Math.cos(a) * r, s * 0.3, Math.sin(a) * r);
			m.rotation.set(rnd() * 0.6, rnd() * 3, rnd() * 0.6);
			mass.add(m);
		}
		this.mass = mass;
		this.root.add(mass);

		// ── 洞里的暖光。这是"家"唯一允许的奢侈 ──────────────────
		// 它同时干两件事：把洞口那一小块雾染暖（
		// 冷灰色的森林里唯一一点橙），以及作为最后 20 米的视觉确认。
		this.light = new THREE.PointLight(cfg.palette.lantern, 0, 26, 2);
		this.light.position.set(-0.05, 1.5, 3.6);
		this.root.add(this.light);

		// 灯芯本体：一个不受雾影响的小亮点。
		// 【为什么必须有它】只有 PointLight 的话，光会照亮周围却**看不见光源**，
		// 玩家会以为是自己眼花了。恐怖游戏里"远处有一点光"必须有一个可指认的来源。
		this.ember = new THREE.Mesh(
			new THREE.SphereGeometry(0.085, 6, 6),
			new THREE.MeshBasicMaterial({ color: cfg.palette.lantern, fog: false }),
		);
		this.ember.position.copy(this.light.position);
		this.root.add(this.ember);

		this.dist = Infinity;
		this.bearing = 0; // 世界系朝向（yaw 语义：和 player.yaw 可直接相减）
		this._t = 0;
		this.inside = false;
	}

	// 把"最近的那一份"摆到正确位置，并算出距离与朝向。
	// 返回是否刚刚踏入洞内（用于一次性事件，不要每帧都用返回值做判定）。
	update(dt, px, pz) {
		const T = this.cfg.world.tile;
		this._t += dt;

		// 最近晶格副本
		const nx = this.x + Math.round((px - this.x) / T) * T;
		const nz = this.z + Math.round((pz - this.z) / T) * T;
		this.root.position.set(nx, terrainHeight(nx, nz, this.cfg), nz);

		// 环面最短差 —— 这是唯一正确的算法，直接相减会指一条远路
		const dx = wrapDelta(this.x - px, T);
		const dz = wrapDelta(this.z - pz, T);
		this.dist = Math.hypot(dx, dz);
		// yaw 语义与 player.yaw 一致（前方 = -Z），所以两者可直接相减
		this.bearing = Math.atan2(-dx, -dz);

		// 灯只在近处点亮：省一路点光源计算，也让"走近才亮"更有仪式感
		const near = this.dist < 34;
		this.light.intensity = near
			? 3.1 + Math.sin(this._t * 9.1) * 0.45 + Math.sin(this._t * 21.7) * 0.22
			: 0;
		this.ember.visible = near;

		const wasInside = this.inside;
		this.inside = this.dist < this.cfg.safehouse.arriveRadius;
		return this.inside && !wasInside;
	}
}
