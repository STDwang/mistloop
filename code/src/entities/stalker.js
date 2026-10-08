// 「它」—— 一个极瘦的人形剪影。
//
// 这个类刻意"不聪明"：它不做任何决策，只负责
// ① 出现在给定坐标 ② 朝给定目标移动 ③ 摆动与呼吸。
// 所有"什么时候出现、出现多远、什么时候消失"都归 Director 管。
//
// 如果行为规则被写进这个类，后面调参就要改两个文件 —— 这是必须避免的耦合。

import * as THREE from 'three';
import { terrainHeight } from '../core/noise.js';
import { loadCharacter, applyCharacterTexture } from '../core/characters.js';
import { VerletChain } from '../core/geometry.js';

const _sv1 = new THREE.Vector3();
const _swind = new THREE.Vector3();

export class Stalker {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.pos = new THREE.Vector3();
		this.active = false;
		// 发丝风用的"她自己的速度"：update 里按帧间位移估算
		this._vel = new THREE.Vector3();
		this._lastPos = new THREE.Vector3();

		// 写实女鬼的三块材质：裙（灰白破布）/ 皮（尸白）/ 发（近黑）。
		// 全部不受雾（fog:false）—— 显隐完全由 opacity 手动控制，
		// 远处是一团"雾里变暗的痕迹"，近处才是看清的苍白人形。
		// 换掉原来的单一纯黑：目标图（target-ghost.png）里的她
		// 是"雾里一张苍白的脸"，不是一块黑。
		const ghostMat = (hex) =>
			new THREE.MeshBasicMaterial({
				color: hex,
				transparent: true,
				opacity: 0,
				fog: false,
				depthWrite: false,
				side: THREE.FrontSide,
			});
		this.material = ghostMat(0x8b8e88); // 裙 —— 保留 this.material 引用兼容外部 opacity 读写
		this.skinMat = ghostMat(0xb6b0a8);
		this.hairMat = ghostMat(0x0a0908);
		this._mats = [this.material, this.skinMat, this.hairMat];

		this.root = new THREE.Group();
		this.root.visible = false;
		this.root.renderOrder = 20;
		scene.add(this.root);

		// ── 雾中黑洞：一圈很暗的软光晕 ──────────────────────────
		// 纯黑剪影只有在背景是"亮雾"时才读得出来；背景是暗树干时它会消失。
		// 解决办法不是把身体提亮（那就不是剪影了），而是在它身后挖一个
		// "雾变稀了"的洞 —— 这正是寂静岭里那个东西看起来的样子。
		this.halo = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: Stalker.haloTexture(),
				color: 0x000000,
				transparent: true,
				opacity: 0,
				depthWrite: false,
				depthTest: true,
				fog: false,
			}),
		);
		this.halo.scale.set(7.4, 9.4, 1);
		this.halo.position.y = 2.6;
		this.halo.renderOrder = 19;
		this.root.add(this.halo);

		this.body = new THREE.Group();
		this.root.add(this.body);

		const m = this.material;
		const H = cfg.entity.height;

		// 躯干：上窄下宽，比人瘦得多 —— "太高的竖条"就来自这个比例
		const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.235, 1.5, 8), m);
		torso.position.y = 1.5;

		// ── 头部枢轴：歪头与抽动都作用在这里 ─────────────────────
		// 【为什么头需要一个独立的枢轴】"歪着"不是静态的——静态的歪头
		// 看三秒就是"模型歪了"。它会缓慢地歪来歪去，偶尔**抽动**一下
		// （快收敛、长保持）：恐怖感来自"它在调整它对你格栅的角度"。
		// 枢轴在颈（y=2.1），基元头/ GLB 头都挂进来。
		this.headPivot = new THREE.Group();
		this.headPivot.position.y = 2.1;
		this.body.add(this.headPivot);

		// 头：拉长并歪着，避免看起来像正常人
		const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 7, 7), m);
		head.position.y = 0.25;
		head.scale.set(0.86, 1.55, 0.86);
		head.rotation.z = 0.34;
		this.headPivot.add(head);

		this.body.add(torso);

		const limbs = [];
		const primLimbs = [];
		for (const sx of [-1, 1]) {
			// 手臂：垂得很低，几乎到膝
			const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.032, 1.42, 6), m);
			arm.position.set(sx * 0.25, 1.4, 0.02);
			arm.rotation.z = sx * 0.05;
			// 腿
			const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.044, 1.5, 6), m);
			leg.position.set(sx * 0.11, 0.75, 0);
			// 苍白的手：手臂末端的球。五指不值得 —— 雾里那只"苍白的手"
			// 只需要一点比袖口亮的皮肤色。
			const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), this.skinMat);
			hand.position.set(sx * 0.25, 0.68, 0.02);
			this.body.add(arm, leg, hand);
			limbs.push(arm, leg);
			primLimbs.push(arm, leg, hand);
		}
		this.limbs = limbs;

		// ── 发丝：五条 verlet 链 ─────────────────────────────────
		// 挂在头部枢轴上（头歪它们跟着歪）。低重力（1.0）—— 她的头发
		// 下落得比应该的慢，"水下一样的迟滞"是她不属于这里的物理证据。
		this._strands = [];
		this._strandAnchors = [];
		{
			const sgeo = new THREE.CylinderGeometry(0.007, 0.015, 1, 4);
			for (let i = 0; i < 5; i++) {
				const chain = new VerletChain(4, 0.17, { gravity: 1.0, damping: 0.94 });
				const anchor = new THREE.Object3D();
				// 头顶一圈：两侧/后侧各一，随头部枢轴转动
				anchor.position.set(
					Math.sin((i / 5) * Math.PI * 2) * 0.11,
					0.36,
					-Math.cos((i / 5) * Math.PI * 2) * 0.09 - 0.02,
				);
				this.headPivot.add(anchor);
				const meshes = [];
				for (let s = 0; s < 3; s++) {
					const seg = new THREE.Mesh(sgeo, this.hairMat);
					seg.renderOrder = 20;
					this.root.add(seg);
					meshes.push(seg);
				}
				this._strands.push(chain);
				this._strandAnchors.push(anchor);
				this._strandMeshes = this._strandMeshes || [];
				this._strandMeshes.push(meshes);
			}
		}
		this._movingT = 0;
		this._twZ = 0.34;
		this._twY = 0;
		this._nextTw = 2.5;

		// ── 写实女鬼换装（Blender 自建 ghost.glb，146 KB）────────
		// 基元版在上面先撑起"太高的人形"轮廓；GLB 到货后原地换装。
		// 机制一个都不动：opacity 驱动显隐、halo 雾洞、rim 亮边、
		// 被照住冻结 —— 换的只是"她长什么样"。
		//   · 裙身替代了基元的躯干+腿（她本来就滑行，不需要腿）
		//   · 手臂挂进肩部枢轴，update() 的微风摆动绕肩而不是绕中心
		//   · 长发壳中央挖了脸窗：苍白的无面脸从兜帽阴影里露出来
		loadCharacter('models/ghost.glb').then((parts) => {
			const by = {};
			for (const p of parts) by[p.name] = p;
			const matOf = {
				G_Dress: this.material,
				G_ArmL: this.skinMat,
				G_ArmR: this.skinMat,
				G_Head: this.skinMat,
				G_Hair: this.hairMat,
			};
			const add = (nm, parent, x = 0, y = 0, z = 0) => {
				const p = by[nm];
				if (!p) return;
				const mesh = new THREE.Mesh(p.geometry, matOf[nm] || this.material);
				mesh.name = nm;
				mesh.position.set(x, y, z);
				mesh.renderOrder = 20; // 盖过 halo(19)/rim(18) 的雾洞亮边
				parent.add(mesh);
				return mesh;
			};

			// 手臂枢轴：肩高 1.95（模型实际值），微风摆动绕肩
			const armPivots = [];
			for (const sx of [-1, 1]) {
				const g = new THREE.Group();
				g.position.set(sx * 0.285, 1.95, 0.02);
				this.body.add(g);
				add(sx < 0 ? 'G_ArmL' : 'G_ArmR', g, -sx * 0.285, -1.95, -0.02);
				// 苍白的手：臂长约 1.42（肩 1.95 → 指尖 0.53），
				// 挂进肩枢轴，摆臂时手跟着走。
				const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 7, 6), this.skinMat);
				hand.position.set(-sx * 0.285 + 0, -1.42, -0.02);
				hand.scale.set(0.85, 1.25, 0.7); // 略拉长：不是球，是"手"
				hand.renderOrder = 20;
				g.add(hand);
				armPivots.push(g);
			}

			add('G_Dress', this.body);
			// 头与长发壳进头部枢轴（几何烘焙在角色空间，枢轴在 2.1 →
			// 网格偏移 -2.1 挂回原位；枢轴转动即"歪头/抽动"）
			add('G_Head', this.headPivot, 0, -2.1, 0);
			add('G_Hair', this.headPivot, 0, -2.1, 0);

			// 拆掉基元：躯干与基元头（GLB 头进枢轴后基元头没有存在意义）
			this.body.remove(torso);
			this.headPivot.remove(head);
			for (const lm of primLimbs) lm.parent?.remove(lm);
			this.limbs = armPivots;

			// 自产贴图：破裙布料 + 尸白皮肤（缺文件保持纯色）
			applyCharacterTexture(this.material, 'char-dress');
			applyCharacterTexture(this.skinMat, 'char-skin');
		}).catch((err) => {
			console.warn('[资产] ghost.glb 加载失败，保留基元剪影：', err?.message || err);
		});

		this._t = 0;
		this._baseHeight = H;
		this._distHint = 30;

		// ── 被手电照住时的亮边（rim）─────────────────────────
		// 【为什么"照到一个纯黑的东西"需要一层亮边】
		// 它是纯黑的、不受雾影响的剪影。把手电照上去，物理上发生的是
		// "它把光挡住了"—— 但它本身不反光，所以直接照它**不会让它变亮**，
		// 只会让它更黑。玩家得不到任何"我照到了"的反馈。
		//
		// 真实世界里真正让轮廓显形的是**前向散射**：手电在它周围的
		// 雾里点亮一圈，身体把圆心吃掉，于是你看见一圈亮边裹着一个人形。
		// 所以这里加的是一张比它大一圈的加性亮斑，
		// 身体（renderOrder 更高）盖住圆心 —— 露出来的那圈就是亮边。
		this.rim = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: Stalker.haloTexture(),
				color: cfg.palette.torch,
				transparent: true,
				opacity: 0,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
				depthTest: true,
				fog: false,
			}),
		);
		this.rim.scale.set(8.6, 10.8, 1);
		this.rim.position.y = 2.4;
		this.rim.renderOrder = 18; // 在 halo(19) 与 body(20) 之后被覆盖
		this.root.add(this.rim);

		// 被手电照住的程度 0–1（视觉用，平滑过）
		this.lit = 0;
		// 本帧的目标值，由 Director 每帧写入
		this.litTarget = 0;
		// 闪电背光强度 0–1，由 Director 每帧写入
		this.flash = 0;
		// 被定住（照住）时为真 —— 表现上等于"完全静止"
		this.held = false;
	}

	// 闪电把雾点亮 → 黑剪影的对比度拉满。
	// 这个数不是"额外的不透明度"，是 Director 计算可见度时用的一个乘子，
	// 所以这里只负责存放，不在这里参与合成。
	setLightning(f) {
		this.flash = f;
	}

	// 软暗斑。所有贴图都程序化生成，这是本项目的资产纪律。
	static haloTexture(size = 128) {
		if (this._haloTex) return this._haloTex;
		const c = document.createElement('canvas');
		c.width = c.height = size;
		const ctx = c.getContext('2d');
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(255,255,255,0.92)');
		g.addColorStop(0.34, 'rgba(255,255,255,0.58)');
		g.addColorStop(0.64, 'rgba(255,255,255,0.2)');
		g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		this._haloTex = tex;
		return tex;
	}

	// yOverride 用于 CLIMAX：那一刻它必须和镜头同高，不能踩在地上
	place(x, z, yOverride) {
		const y = yOverride === undefined ? terrainHeight(x, z, this.cfg) : yOverride;
		this.pos.set(x, y, z);
		this.root.position.set(x, y, z);
	}

	// 面向某个世界坐标（人的默认朝前是 -Z）
	faceTarget(x, z) {
		const dx = x - this.pos.x;
		const dz = z - this.pos.z;
		this.root.rotation.y = Math.atan2(-dx, -dz);
	}

	distanceTo(v) {
		return Math.hypot(this.pos.x - v.x, this.pos.z - v.z);
	}

	// 朝目标逼近。只在 Director 判定"玩家没在看"时调用。
	advanceToward(target, step) {
		const dx = target.x - this.pos.x;
		const dz = target.z - this.pos.z;
		const d = Math.hypot(dx, dz);
		if (d < 1e-4) return;
		const k = Math.min(1, step / d);
		this.place(this.pos.x + dx * k, this.pos.z + dz * k);
		this.faceTarget(target.x, target.z);
		// "她在动"的标记：手臂拖曳与发丝风都读它。0.35 s 自然衰减 ——
		// 停下之后手臂还要漂一会儿才回来，比瞬间归位可信。
		this._movingT = 0.35;
	}

	show() {
		this.active = true;
		this.root.visible = true;
	}

	hide() {
		this.active = false;
		this.root.visible = false;
		for (const mt of this._mats) mt.opacity = 0;
		// 亮边也必须一起清掉：留在场上会变成一个飘着的亮斑，
		// 比鬼影本身还显眼（它是加性的）。
		this.rim.material.opacity = 0;
		this.lit = 0;
		this.litTarget = 0;
		this.held = false;
	}

	set opacity(v) {
		for (const mt of this._mats) mt.opacity = v;
		// 光晕在远处要更强：远处的剪影只有几个像素大，真正让人"感觉到有东西"的
		// 是雾里那一块变暗的区域。近处反而收敛，避免变成一个黑圈。
		//
		// 【闪电的那一项为什么是乘上去的】
		// "雾里变暗的一块"要能看见，前提是**雾本身是亮的**。
		// 闪电把雾点亮多少，这块暗斑就有多显眼 —— 所以是乘不是加。
		// 这同时也解释了为什么在闪电下它突然"跳出来"：
		// 平时 fog 灰暗时那一圈几乎不可见，一记闪电就把它拉满。
		const back = 1 + this.flash * 1.6;
		this.halo.material.opacity =
			v * (0.26 + 0.5 * Math.max(0, Math.min(1, this._distHint / 45))) * back;
	}

	get opacity() {
		return this.material.opacity;
	}

	// 摆动与呼吸：让静止的剪影仍然"活着"，但不至于像动画。
	//
	// 【被照住时停止推进 _t，而不是把幅度调小】
	// 这是"定住"这个动作唯一诚实的表达：它不是"动得慢一点"，
	// 是**完全不动**。幅度调到 0 仍然会有相位漂移，一旦松手就会
	// 从新相位弹回去；冻结时间轴是真正的静止。
	//
	// 【v2 新增的每一个动态都必须是 _t 或 _movingT 的函数】
	// 头部抽动、悬浮 bob、发丝物理 —— 全部挂在冻结纪律之下：
	// 被手电照住的那一刻，她也连同头发一起凝固在半空。
	// 发丝链在 held 时不步进（物理停了），但仍然 render（保持姿势）。
	update(dt) {
		// 照住的程度。上升极快、下降慢 —— 手感上"照到"是瞬时的，
		// 而"移开"留一点余韵，否则手一抖它就开始动了。
		const F = this.cfg.flashlight;
		const k = this.litTarget > this.lit ? F.litRise : F.litFall;
		this.lit += (this.litTarget - this.lit) * Math.min(1, dt / Math.max(1e-4, k));
		this.held = this.lit > 0.5;

		// 亮边强度。被照住时最强；同时闪电也算一种"照亮"，
		// 但闪电是从天上下来的背光，不该在轮廓上产生手电那样的前向散射，
		// 所以只取 lit（不给 flash 一项）。
		const rim = this.lit * 0.5;
		this.rim.material.opacity = rim;
		// 被照住时亮边稍微外扩一点：光晕随光强变大，这是真实散射的行为
		const sc = 1 + this.lit * 0.12;
		this.rim.scale.set(8.6 * sc, 10.8 * sc, 1);

		if (this.held) return; // 冻结：一动不动

		this._t += dt;
		const t = this._t;

		// 帧间位移 → 她的移动速度（发丝风的驱动源）。
		// clamp 防首帧/传送瞬间的无穷大。
		if (dt > 1e-4) {
			this._vel.set(
				Math.max(-8, Math.min(8, (this.pos.x - this._lastPos.x) / dt)),
				0,
				Math.max(-8, Math.min(8, (this.pos.z - this._lastPos.z) / dt)),
			);
		}
		this._lastPos.copy(this.pos);

		// ── 悬浮：她不走路，她漂着 ─────────────────────────────
		// 0.75 Hz 的慢 bob。地衣不长在她脚下的意义上，她没有脚步。
		this.root.position.y = this.pos.y + Math.sin(t * 0.75) * 0.055;

		// ── 头部：缓慢歪斜 + 不规则抽动 ─────────────────────────
		// 抽动是这只"东西"最错的一处：歪头的目标值每 2.5–8 s 换一次，
		// 换的时候 10/s 快速收敛 —— 肉眼看是一次"咔"的扭头。
		// 叠加的两个慢振荡让它在两次抽动之间也不是完全静止。
		if (t > this._nextTw) {
			this._twZ = 0.34 + (Math.sin(t * 12.9) > 0 ? 1 : -1) * (0.1 + Math.abs(Math.sin(t * 7.7)) * 0.22);
			this._twY = (Math.sin(t * 9.1) > 0 ? 1 : -1) * Math.abs(Math.sin(t * 5.3)) * 0.35;
			this._nextTw = t + 2.5 + Math.abs(Math.sin(t * 3.3)) * 5.5;
		}
		const twk = Math.min(1, dt * 10);
		this._curZ = (this._curZ ?? this._twZ) + (this._twZ - (this._curZ ?? this._twZ)) * twk;
		this._curY = (this._curY ?? this._twY) + (this._twY - (this._curY ?? this._twY)) * twk;
		this.headPivot.rotation.z = this._curZ + Math.sin(t * 0.23) * 0.06;
		this.headPivot.rotation.y = this._curY + Math.sin(t * 0.17) * 0.04;

		// 呼吸：极轻微的纵向伸缩
		this.body.scale.y = 1 + Math.sin(t * 1.55) * 0.012;
		// 极慢的横向摇摆，像被风吹
		this.root.rotation.y += Math.sin(t * 0.31) * 0.00035;

		// ── 手臂：静止微风 / 移动拖曳 ───────────────────────────
		// advanceToward 会把 _movingT 抬到 0.35 s，这里自然衰减。
		// 她挪近的时候双臂向后漂（+x 是向后）—— 像身体先走、
		// 手臂没跟上，"这具身体不是一套连贯的肌肉"就是恐怖本身。
		this._movingT = Math.max(0, this._movingT - dt);
		const drag = Math.min(1, this._movingT / 0.35);
		for (let i = 0; i < this.limbs.length; i++) {
			this.limbs[i].rotation.x =
				Math.sin(t * 0.9 + i * 1.7) * 0.02 + drag * (0.24 + Math.sin(t * 1.2 + i * 1.7) * 0.05);
		}

		// ── 发丝 verlet ────────────────────────────────────────
		// 风 = 她自己的移动（拖在身后）+ 环境微颤。只在激活时模拟 ——
		// 隐形时链子不存在。
		if (this.active) {
			for (let i = 0; i < this._strands.length; i++) {
				this._strandAnchors[i].getWorldPosition(_sv1);
				_swind.set(
					-this._vel.x * 2.2 + Math.sin(t * 1.9 + i * 2.1) * 0.35,
					0,
					-this._vel.z * 2.2 + Math.cos(t * 1.4 + i * 1.7) * 0.35,
				);
				this._strands[i].step(_sv1, _swind, dt);
				this._strands[i].render(this._strandMeshes[i]);
			}
		}
	}

	// Director 每帧把距离喂进来，光晕用它决定"洞开多大"
	setDistanceHint(d) {
		this._distHint = d;
	}
}
