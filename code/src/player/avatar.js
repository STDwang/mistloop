// 主角的可视化身：只出现在第三人称里。
//
// ─────────────────────────────────────────────────────────────
// 【为什么不用外部模型】
//
// materials/ASSETS.md 的宪法是"3D 模型 | 0 | 全部由 Three.js 基元构造"。
// 用户曾提议"找免费的模型"，但每引入一个 glb 就要同时引入加载器、
// 骨骼绑定和一份素材清单条目，而本作的人物在 99% 的时间里
// 是雾里的一个剪影 —— 一个剪影不需要骨骼，需要的是**轮廓对**。
//
// 【v2 · 为什么把四肢拆成两段】
// 用户反馈"像木头人"。病根不在建模精度（模型已精修 7 轮），
// 在**关节**：单根刚体绕髋/肩摆动，永远没有膝盖和手肘 ——
// 而人腿最可读的信号恰恰是"迈步时小腿折叠、脚跟踢向臀部"。
// 没有它的摆动无论幅度多大，读起来都是"圆规在画弧"。
// 所以：大腿+小腿（膝关节）、上臂+前臂（肘关节），各多一个枢轴，
// 换来步态从"滑行"到"走路"的质变。GLB 的单件肢体到货后**丢弃**，
// 只取它的材质（M_Coat/M_Pants/M_Boot）穿在两段式肢体上。
//
// 【动作状态机】
// 不引入动画剪辑 —— 全部姿态是 6 个数的函数：
//   walk 循环：大腿 ±0.50 · 膝 0.35 · 臂反相 0.75 · 躯干微摆
//   run  循环：大腿 ±0.85 · 膝 1.35（脚跟踢臀）· 摆臂泵肘 · 前倾 0.17
// 两者用 runK（速度 → 0..1，指数平滑）插值 —— "启动奔跑"的丝滑
// 全部来自这个 0.4 s 的混合，没有任何瞬间切换。
//
// 【可见的物理：围巾】
// VerletChain（core/geometry.js）挂着一条围巾。它的意义不只是装饰：
// 玩家急停、急转、跳跃落地时它给出方向正确的拖曳 ——
// 这是"惯性存在"的可见证明，比任何镜头特效都便宜且诚实。
//
// 【纪律】
//   ① 第一人称必须隐藏。悬在相机下面的半截身体会毁掉一切。
//   ② 走路动画的相位就是 player.bobPhase —— 脚步声与迈腿共用同一个
//      相位源，耳朵听到一步、眼睛看到一步，两者永远对得上。
//   ③ 全部部件 castShadow。第三人称里手电往前照，
//      自己的影子投在前方雾里。
//   ④ P_Head 必须是 body 的直属子节点（stance-visual 量头顶）。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { loadCharacter, applyCharacterTexture } from '../core/characters.js';
import { VerletChain } from '../core/geometry.js';

const _v1 = new THREE.Vector3();
const _wind = new THREE.Vector3();

export class Avatar {
	constructor(cfg, scene) {
		this.cfg = cfg;
		this.root = new THREE.Group();
		this.root.visible = false; // 第一人称开局。切第三人称才亮
		scene.add(this.root);

		const coat = new THREE.Color(cfg.palette.rot);
		const dark = new THREE.Color(cfg.palette.barkDark);
		this.matCoat = new THREE.MeshStandardMaterial({
			color: coat,
			roughness: 0.98,
			metalness: 0,
			flatShading: true,
		});
		this.matDark = new THREE.MeshStandardMaterial({
			color: dark,
			roughness: 0.98,
			metalness: 0,
			flatShading: true,
		});

		// ── 躯干组：驼背 + 呼吸都作用在这里 ──────────────────────
		this.body = new THREE.Group();
		this.root.add(this.body);

		// 胸腔：上窄下宽的圆柱，前倾 0.1 rad = 驼背
		const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.19, 0.6, 8), this.matCoat);
		torso.position.y = 1.22;
		torso.rotation.x = 0.1;
		// 外套的下摆：比胸腔宽一圈、短一截。轮廓上它才是"穿了衣服"的证据
		const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.225, 0.52, 8), this.matDark);
		hem.position.y = 1.02;
		hem.rotation.x = 0.04;
		// 肩：最宽的一圈，在胸腔顶部
		const shoulders = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.22, 8), this.matCoat);
		shoulders.position.y = 1.5;
		shoulders.rotation.x = 0.1;

		// 头：略前伸（驼背的人头在肩膀前面，不在上面）。
		// 直属 body，不进枢轴 —— stance-visual 靠"body 直属子节点里的球"找到它。
		const head = new THREE.Mesh(new THREE.SphereGeometry(0.112, 8, 7), this.matDark);
		head.position.set(0, 1.68, -0.055);
		head.scale.set(0.88, 1.12, 0.96);

		this.body.add(torso, hem, shoulders, head);
		this._primTorso = [torso, hem, shoulders, head];

		// ── 两段式四肢 ─────────────────────────────────────────
		// 腿：髋枢轴 → 大腿 → 膝枢轴 → 小腿 + 靴。
		// 膝只能向后弯（负 rotation.x）—— 单向关节，弯错方向是"骨折"不是"屈膝"。
		this.legL = this._buildLeg(this.matDark, -0.105, 0.94);
		this.legR = this._buildLeg(this.matDark, 0.105, 0.94);
		this.armL = this._buildArm(this.matCoat, this.matDark, -0.245, 1.47);
		this.armR = this._buildArm(this.matCoat, this.matDark, 0.245, 1.47);
		this.armL.pivot.rotation.z = 0.07; // 自然外张
		this.armR.pivot.rotation.z = -0.07;

		// ── 手电挂点：第三人称时手电装具的父节点 ─────────────────
		this.head = new THREE.Group();
		this.head.position.set(0.16, 1.56, -0.08);
		this.root.add(this.head);

		// ── 右手的道具：一支看得见的手电 ─────────────────────────
		// 光束本体从相机出发（flashlight.js），但第三人称里"光从哪来"
		// 需要一个可指认的来源 —— 一支握在右手里的金属小筒。
		{
			const body = new THREE.Mesh(
				new THREE.CylinderGeometry(0.022, 0.026, 0.15, 8),
				this.matDark,
			);
			const lens = new THREE.Mesh(
				new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8),
				new THREE.MeshBasicMaterial({ color: cfg.palette.torch }),
			);
			const grip = new THREE.Group();
			body.rotation.x = -Math.PI / 2; // 筒轴指向 -Z（前方）
			lens.rotation.x = -Math.PI / 2;
			body.position.z = -0.02;
			lens.position.z = -0.1;
			grip.add(body, lens);
			grip.position.set(0, -0.3, -0.05);
			this.armR.joint.add(grip); // 挂在前臂末端，随摆臂自然摆动
		}

		// ── 围巾：Verlet 链 ────────────────────────────────────
		// 锚点挂在颈后（body 空间），风 = 玩家速度的反向 + 微颤。
		{
			this.scarfAnchor = new THREE.Object3D();
			this.scarfAnchor.position.set(0, 1.5, 0.1);
			this.body.add(this.scarfAnchor);
			const smat = new THREE.MeshStandardMaterial({
				color: new THREE.Color(cfg.palette.scarf),
				roughness: 1,
				metalness: 0,
			});
			const sgeo = new THREE.CylinderGeometry(0.02, 0.032, 1, 5);
			this._scarf = new VerletChain(5, 0.105, { gravity: 3.4, damping: 0.9 });
			this._scarfMeshes = [];
			for (let i = 0; i < 4; i++) {
				const m = new THREE.Mesh(sgeo, smat);
				m.castShadow = false;
				this.root.add(m);
				this._scarfMeshes.push(m);
			}
		}

		this.root.traverse((n) => {
			if (n.isMesh) {
				n.castShadow = true;
				n.receiveShadow = false;
			}
		});

		// ── 写实模型换装（Blender 自建 player.glb）──────────────
		// 躯干/背包/头发/头 → body（GLB 几何已烘焙到角色空间）。
		// 四肢的 GLB 几何**不用**（单根刚体），只取材质给两段式肢体；
		// 枢轴挪到模型实际关节（肩 1.45 / 髋 0.90）。
		loadCharacter('models/player.glb').then((parts) => {
			const by = {};
			for (const p of parts) by[p.name] = p;
			const armPivotX = 0.21;
			const armY = 1.45;
			const hipX = 0.098;
			const hipY = 0.9;

			const place = (part, parent) => {
				if (!part) return;
				const m = new THREE.Mesh(part.geometry, part.material);
				m.name = part.name;
				m.castShadow = true;
				parent.add(m);
			};

			// 躯干、背包、头发、头：直接挂 body（P_Head 必须保持直属）
			for (const nm of ['P_Torso', 'P_Pack', 'P_Hair', 'P_Head']) {
				place(by[nm], this.body);
			}

			// 两段式肢体换上 GLB 的材质：外套袖 / 裤 / 靴 / 皮肤手
			const coatMat = by['P_ArmL']?.material || this.matCoat;
			const pantsMat = by['P_LegL']?.material || this.matDark;
			const bootMat = by['P_BootL']?.material || this.matDark;
			const skinMat = new THREE.MeshStandardMaterial({
				color: 0x9a8a78,
				roughness: 0.9,
				metalness: 0,
			});
			applyCharacterTexture(coatMat, 'char-coat');
			applyCharacterTexture(by['P_Head']?.material, 'char-skin');
			applyCharacterTexture(skinMat, 'char-skin');
			this.armL.setMaterials(coatMat, skinMat);
			this.armR.setMaterials(coatMat, skinMat);
			this.legL.setMaterials(pantsMat, bootMat);
			this.legR.setMaterials(pantsMat, bootMat);

			// 枢轴挪到模型的实际关节
			this.armL.pivot.position.set(-armPivotX, armY, -0.02);
			this.armR.pivot.position.set(armPivotX, armY, -0.02);
			this.legL.pivot.position.set(-hipX, hipY, 0);
			this.legR.pivot.position.set(hipX, hipY, 0);

			// 拆掉基元躯干
			for (const m of this._primTorso) this.body.remove(m);
			this._primTorso = null;
		}).catch((err) => {
			console.warn('[资产] player.glb 加载失败，保留基元化身：', err?.message || err);
		});

		this._t = 0;
		this._runK = 0;
		this._dip = 0;
	}

	// ── 两段式肢体构建 ────────────────────────────────────────
	// 返回 { pivot, joint }：pivot 绕关节摆，joint 是第二段枢轴。
	// setMaterials 让 GLB 材质到货后原地换装（几何不动）。
	_buildLeg(mat, x, y) {
		const pivot = new THREE.Group();
		pivot.position.set(x, y, 0);
		const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.064, 0.46, 7), mat);
		thigh.position.y = -0.23;
		const joint = new THREE.Group();
		joint.position.y = -0.46;
		const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.046, 0.42, 7), mat);
		shin.position.y = -0.21;
		const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.27), mat);
		boot.position.set(0, -0.44, -0.05); // 鞋尖朝前（-Z）
		joint.add(shin, boot);
		pivot.add(thigh, joint);
		this.body.add(pivot);
		pivot.traverse((n) => {
			if (n.isMesh) n.castShadow = true;
		});
		return {
			pivot,
			joint,
			setMaterials(mLeg, mBoot) {
				thigh.material = mLeg;
				shin.material = mLeg;
				boot.material = mBoot;
			},
		};
	}

	_buildArm(mat, matHand, x, y) {
		const pivot = new THREE.Group();
		pivot.position.set(x, y, -0.02);
		const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.34, 7), mat);
		upper.position.y = -0.17;
		const joint = new THREE.Group();
		joint.position.y = -0.34;
		const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.036, 0.3, 7), mat);
		fore.position.y = -0.15;
		const hand = new THREE.Mesh(new THREE.SphereGeometry(0.048, 7, 6), matHand);
		hand.position.y = -0.32;
		joint.add(fore, hand);
		pivot.add(upper, joint);
		this.body.add(pivot);
		pivot.traverse((n) => {
			if (n.isMesh) n.castShadow = true;
		});
		return {
			pivot,
			joint,
			setMaterials(mArm, mSkin) {
				upper.material = mArm;
				fore.material = mArm;
				hand.material = mSkin;
			},
		};
	}

	// 每帧从玩家同步。avatar 不持有任何运动状态 ——
	// 它只是 player 的一个"可见投影"，player 不在时它什么都不是。
	update(dt, player) {
		this._t += dt;
		const P = this.cfg.player;

		this.root.position.set(player.pos.x, player.pos.y, player.pos.z);
		this.root.rotation.y = player.yaw;

		// ── 跑步混合系数 runK ─────────────────────────────────
		// 速度从 walk×1.12 到 run 平滑映射到 0..1。用指数趋近（2.6/s
		// ≈ 0.4 s 完成过渡）而不是直接赋值：奔跑的"启动"是一个动作 ——
		// 身体先倾、步幅先变大，然后才是速度上来。倒过来减速也一样。
		const norm = Math.min(1.5, player.speed / P.walk);
		const moving = norm > 0.08;
		const runTarget = moving
			? Math.max(0, Math.min(1, (player.speed - P.walk * 1.12) / Math.max(0.01, P.run - P.walk * 1.12)))
			: 0;
		this._runK += (runTarget - this._runK) * Math.min(1, dt * 2.6);
		const runK = this._runK;

		// ── 步态 ─────────────────────────────────────────────────
		// bobPhase 每步推进 2π（脚步声同源）。跑动的步频天然更高 ——
		// bobPhase 按**实际位移**推进，速度上去步频自动跟上。
		const ph = player.bobPhase;
		const strideAmp = (0.5 + runK * 0.35) * Math.min(1, norm);
		const swing = moving ? Math.sin(ph) * strideAmp : 0;

		// 大腿：walk ±0.5 → run ±0.85
		let thighL = swing;
		let thighR = -swing;

		// 膝：走路 0.35 / 跑步 1.35 的屈伸，峰在"腿从后往前收"的半程
		// （cos(ph+0.5) 的正半波）—— 脚跟踢向臀部，这是"在跑"最可读的证据。
		const kneeBase = 0.1 + runK * 0.12;
		const kneeDrive = 0.35 + runK * 1.0;
		let kneeL = -kneeBase - (moving ? Math.max(0, Math.cos(ph + 0.5)) * kneeDrive : 0);
		let kneeR = -kneeBase - (moving ? -Math.min(0, Math.cos(ph + 0.5)) * kneeDrive : 0);

		// 臂：与同侧腿反相。跑动时手肘固定弯起（拳到肋侧），摆幅加深。
		let armL = -swing * (0.75 + runK * 0.55);
		let armR = swing * (0.75 + runK * 0.55);
		const elbowBase = 0.28 + runK * 0.75;
		let elbowL = elbowBase + (moving ? Math.max(0, -Math.sin(ph)) * (0.15 + runK * 0.5) : 0);
		let elbowR = elbowBase + (moving ? Math.max(0, Math.sin(ph)) * (0.15 + runK * 0.5) : 0);

		// 腾空：起跳收腿（膝抬起）、下落伸展（准备触地）——
		// 用 vy 而不是固定姿势，同一跳的上升段和下降段不一样。
		if (!player.grounded) {
			const up = Math.max(-1, Math.min(1, player.vy / 4.6));
			thighL = 0.5 + up * 0.18;
			thighR = -0.28 + up * 0.1;
			kneeL = -0.55 - up * 0.25;
			kneeR = -0.22;
			armL = -0.42 - up * 0.1;
			armR = -0.42 - up * 0.1;
			elbowL = elbowBase + 0.25;
			elbowR = elbowBase + 0.25;
		}

		// 指数趋近而不是直接赋值：步态切换（走→停→跳）时四肢滑到位。
		const k = Math.min(1, dt * 9);
		const ease = (cur, target) => cur + (target - cur) * k;

		// ── 蹲伏（沿用 v1 的全部语义，stance-visual 在量这些）────
		// crouchK 从 player 暴露的 eyeHeight 反推，天然连续。
		const crouchK = Math.max(0, Math.min(1, (1 - player.eyeHeight / P.eye) / 0.45));
		const sneakK = player.stance === 'sneak' && crouchK < 0.3 ? 1 : 0;
		const duck = -crouchK * 0.42;
		const leanX = crouchK * 0.38 + sneakK * 0.1;
		const sneakDuck = -sneakK * 0.05;

		// 空中不做下蹲位移 —— 跳跃中身体是伸展的
		this._duck = ease(this._duck || 0, player.grounded ? duck + sneakDuck : 0);
		this._leanX = ease(this._leanX || 0, leanX);
		this.body.position.y = this._duck;
		this.body.rotation.x = this._leanX;
		this.body.rotation.y = 0;

		// 屈膝：蹲下时膝盖往前顶。空中恢复。
		const bendK = player.grounded ? crouchK * 0.7 : 0;
		thighL += bendK * 0.9;
		thighR += bendK * 0.9;
		kneeL -= bendK * 0.8;
		kneeR -= bendK * 0.8;

		// ── 奔跑与坡度的躯干姿态 ────────────────────────────────
		// 前倾随速度加深（0.17 rad ≈ 10°，冲刺的人躯干必然前压）；
		// 上坡更倾（player.slopeK < 1）、下坡微后仰 —— 坡度第一次
		// 在剪影上有了可读的形态，而不只是速度数字变了。
		const slopeK = player.slopeK ?? 1;
		const leanRun = player.grounded
			? runK * Math.min(1, norm - 0.9) * 0.17 + (1 - slopeK) * 0.35
			: 0;
		this._leanRun = ease(this._leanRun || 0, Math.max(-0.06, leanRun));
		this.body.rotation.x = this._leanX + this._leanRun;
		// 躯干反旋：肩膀与髋反相微转，跑步时加大 —— 摆臂的"对手"出现了
		this._yaw = ease(this._yaw || 0, moving ? Math.sin(ph) * (0.04 + runK * 0.08) * Math.min(1, norm) : 0);
		this.body.rotation.y = this._yaw;

		this._legL = ease(this._legL || 0, thighL);
		this._legR = ease(this._legR || 0, thighR);
		this._armL = ease(this._armL || 0, armL);
		this._armR = ease(this._armR || 0, armR);
		this._kneeL = ease(this._kneeL || 0, kneeL);
		this._kneeR = ease(this._kneeR || 0, kneeR);
		this._elbowL = ease(this._elbowL || 0, elbowL);
		this._elbowR = ease(this._elbowR || 0, elbowR);

		this.legL.pivot.rotation.x = this._legL;
		this.legR.pivot.rotation.x = this._legR;
		this.legL.joint.rotation.x = this._kneeL;
		this.legR.joint.rotation.x = this._kneeR;
		this.armL.pivot.rotation.x = this._armL;
		this.armR.pivot.rotation.x = this._armR;
		this.armL.joint.rotation.x = this._elbowL;
		this.armR.joint.rotation.x = this._elbowR;

		// 静止时的呼吸：胸腔微缩。站着不动的人也该看得见他在喘。
		const breathe = player.speed < 0.15 ? 1 + Math.sin(this._t * 1.35) * 0.014 : 1;
		this.body.scale.set(1, breathe, 1);

		// 走路时躯干轻微起伏：|sin| 每步两个峰，步频与脚步声同源。
		// 必须叠加在 this._duck 之上，不能覆盖它（v1 踩过的坑）。
		const rise =
			moving ? Math.abs(Math.sin(ph)) * (0.035 + runK * 0.045) * Math.min(1, norm) : 0;

		// ── 落地屈膝：下沉 + 膝盖额外弯曲 ────────────────────────
		// player.landDip 在 controller 里随落差注入、指数恢复 ——
		// 相机（第一人称）和化身（第三人称）共用同一个数，两种视角
		// 看到的是同一次膝盖弯曲。
		const dip = (player.landDip || 0) * 0.55;
		this._dip = ease(this._dip || 0, dip);
		this.body.position.y = this._duck + rise * (1 - crouchK * 0.75) - this._dip;
		this.legL.joint.rotation.x = this._kneeL - this._dip * 2.4;
		this.legR.joint.rotation.x = this._kneeR - this._dip * 2.4;

		// ── 围巾物理 ─────────────────────────────────────────────
		// 只在第三人称里模拟（第一人称看不见它，白算）。风 =
		// 玩家速度的反向（跑起来它向后飘）+ 两个异相颤动（站着也有微生）。
		if (this.root.visible) {
			this.scarfAnchor.getWorldPosition(_v1);
			_wind.set(
				-player.vel.x * 0.85 + Math.sin(this._t * 6.7) * 0.5,
				0,
				-player.vel.y * 0.85 + Math.cos(this._t * 5.3) * 0.5,
			);
			this._scarf.step(_v1, _wind, dt);
			this._scarf.render(this._scarfMeshes);
		}
	}

	setVisible(v) {
		this.root.visible = v;
	}
}
