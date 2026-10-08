// 玩家控制器：移动、体力、碰撞、头部摆动、脚步、跳跃。
//
// 恐怖游戏的手感有一条特殊要求：**逃跑必须有代价**。
// 所以奔跑会消耗体力，而体力见底会让呼吸变重 —— 逃跑本身让你更响。
//
// ─────────────────────────────────────────────────────────────
// 【跳跃在这个游戏里的定位 · 改之前先读这段】
//
// 它不是"玩法"。它不解决任何问题：跳不过树、跳不过墙、
// 跳不出去 —— 因为这是个环面，没有"外面"。
//
// 它的唯一价值是**把玩家变成一个会喘、会落地、会踩响东西的肉体**。
// 所以三条纪律：
//   ① 跳跃不消耗体力，但会推高 exertion → 呼吸变重。代价是声音，不是数值。
//   ② 空中不允许有脚步声。悬空的脚步音会立刻暴露"这是程序"。
//   ③ 落地音量与**落差**成正比，而不是固定值。平地上蹦一下几乎不出声，
//      从路槽摔到林地里必须听得见。这一个比例关系就是"真实"的全部来源。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { terrainHeight } from '../core/noise.js';

export class Player {
	constructor(cfg, input, forest, camera) {
		this.cfg = cfg;
		this.input = input;
		this.forest = forest;
		this.camera = camera;

		this.pos = new THREE.Vector3(cfg.world.tile * 0.5, 0, cfg.world.tile * 0.5);
		this.vel = new THREE.Vector2(0, 0);
		this.yaw = 0;
		this.pitch = 0;

		this.stamina = cfg.player.staminaMax;
		this.travelled = 0;
		this.speed = 0;
		this.running = false;

		// 垂直：vy 只在腾空时有意义。y 始终是世界绝对高度，
		// 不存"离地高度" —— 那样一碰上斜坡就要两套坐标互相换算。
		this.vy = 0;
		this.airborne = false;
		// 本次腾空到达过的最高绝对高度。落地时用它算"落差"，
		// 而不是用"起跳点地面 - 落点地面"（往坡上跳会得到负数）。见 _tickVertical。
		this._apexY = 0;
		// 跳跃请求由 input.onKeyDown 投递，在 update 里被消费。
		// 为什么不当场起跳：keydown 发生在两帧之间，当场改 vy 会让
		// 同一帧里 pos 的积分与碰撞顺序被打乱（尤其是紧贴树干起跳时）。
		this._wantJump = false;
		// 用力程度的手动增量。下降速率决定了"跳一下之后呼吸多久才平复"。
		this._exertionBoost = 0;

		this.bobPhase = 0;
		this._prevBobSign = 0;
		this._roll = 0;
		this._fov = cfg.player.fov;
		// 运行时可变（来自设置）。0 = 完全不晃，适合晕 3D 的人。
		this.bobAmount = 1.0;

		// ── 物理手感（对外暴露给化身动画读）──────────────────
		// slopeK：本帧沿移动方向的坡度速度系数（1 = 平地）。
		// 上坡 <1、下坡 >1。化身用它做"上坡前倾 / 下坡后仰"。
		this.slopeK = 1;
		// landDip：落地屈膝下沉量（米），指数恢复。相机与化身共用，
		// 相机沉下去是"膝盖弯了"的第一人称证据，化身沉下去是第三人称证据。
		this.landDip = 0;

		// ── 视角模式 ─────────────────────────────────────────────
		// 'first' | 'third'。F 键切换（见 main.js）。
		// 切换本身不改任何运动逻辑 —— 移动、碰撞、脚步、体力全部照旧，
		// 只有 _apply() 里相机的摆放方式不同。
		// 这是刻意的设计：第三人称只是"换一台摄像机"，不是换一个游戏。
		this.viewMode = 'first';
		// 视角切换时通知外部（main.js 用它来换手电的挂点、开关化身可见性）
		this.onViewMode = null;
		// 第三人称机位的"当前回收距离"。遮挡回收必须平滑 ——
		// 树从镜头前掠过时相机一进一出的跳变比穿模本身更出戏。
		this._camDist = cfg.player.thirdPerson.distance;

		// ── 移动姿态 ─────────────────────────────────────────────
		// 目标姿态由键盘直接给出（input.stance），但**生效值**是平滑的：
		// this.stance 是已经收敛的结果，this._stanceK 是 0–1 的插值进度。
		//
		// 【为什么所有姿态参数都要插值，而不是切换时直接跳】
		// 眼高是其中之一。站起来的那一帧如果直接把 eye 从 0.91 m 提到 1.66 m，
		// 画面会"啪"地弹起来 75 厘米 —— 那不是起身，那是瞬移。
		// 视线高度是这个游戏最主要的身体感来源，它必须是连续的。
		// 同理，速度上限、步幅、头部摆动幅度都在同一个进度上插值，
		// 保证"蹲下"是一个动作，而不是四件同时发生的事。
		this.stance = 'walk';
		this._stanceK = 1; // 当前姿态的收敛进度（1 = 完全到位）
		this._stanceFrom = 'walk';
		// 姿态变化时通知外部（HUD 显示、化身动作可以据此改变）
		this.onStance = null;

		// 当前姿态下的实际参数，每帧算一次。音频与 director 从这里读，
		// 不自己去解释姿态字符串 —— 那是"音频不许反向读游戏状态"的延伸：
		// 给它一个数（响度），不要给它一个语义（"他在蹲着"）。
		this.noiseLevel = 1;
		this.eyeHeight = cfg.player.eye;

		// 奔跑升格用的计时器与体力滞后锁
		this._runHoldT = 0;
		this._runLocked = false;

		this.onStep = null;
		this.onLand = null;
		this.enabled = true;

		// 起步位置的地面高度
		this.pos.y = terrainHeight(this.pos.x, this.pos.z, cfg);
		this._apply();
	}

	// 环面回绕由 Director 负责调用：把坐标挪回 [0, tile)
	warpTo(x, z) {
		this.pos.set(x, terrainHeight(x, z, this.cfg), z);
		this.vel.set(0, 0);
		// 传送会让人悬在半空，必须清掉垂直状态，
		// 否则 CLIMAX 之后会"从天上掉下来"，非常出戏
		this.vy = 0;
		this.airborne = false;
		this._wantJump = false;
		this._apply();
	}

	// 请求起跳。真正起跳发生在下一次 update —— 见 _wantJump 的注释。
	// 返回是否被接受（腾空中或已禁用时不接受）。
	jump() {
		if (!this.enabled || this.airborne) return false;
		this._wantJump = true;
		return true;
	}

	get grounded() {
		return !this.airborne;
	}

	// ── 视角切换 ────────────────────────────────────────────────
	setViewMode(mode) {
		if (mode !== 'first' && mode !== 'third') return;
		if (this.viewMode === mode) return;
		this.viewMode = mode;
		// 收近距离重置：切回来的瞬间不该带着上一视角的回收历史
		this._camDist = this.cfg.player.thirdPerson.distance;
		if (this.onViewMode) this.onViewMode(mode);
	}

	toggleView() {
		this.setViewMode(this.viewMode === 'first' ? 'third' : 'first');
		return this.viewMode;
	}

	// 姿态过渡是否已经完成。
	//
	// 【为什么需要单独暴露这个】
	// this.stance 是**目标**姿态，它在过渡开始的瞬间就变了；而 eyeHeight
	// 等参数要几百毫秒后才到位。这两件事都"对"，但混用会出错 ——
	// 验证探针就踩了这个坑：等到 stance==='sneak' 就去读 eyeHeight，
	// 读到的是蹲下尚未升起的 1.017 m，看起来像静步参数写错了。
	// 有了这个 getter，"我应该用哪个值"就不再靠猜。
	get stanceSettled() {
		return this._stanceK >= 1;
	}

	// ── 移动姿态 ────────────────────────────────────────────────

	// 把 input.stance（离散意图）推进成 this.stance + this._stanceK（连续结果），
	// 返回当前生效参数的混合结果。
	//
	// 【插值的做法：混合"参数"而不是"混合进度"】
	// 每个参数单独按同一个 k 混合：eye = mix(eyeFrom, eyeTo, k)。
	// 不这么做的话就要维护四份各自不同的进度，而它们必然不同步 ——
	// 结果是起身到一半时"眼高已经到位但步幅还没变"这种拼接感。
	// 用同一个 k 驱动全部，身体就是一个整体。
	//
	// 【状态只有两个变量：this.stance（目标）+ this._stanceFrom（起点）】
	// 过渡中再次改键（蹲下到一半又想静步）时，起点就地冻结成"当前生效姿态"，
	// k 归零重走。因为生效姿态是 from→stance 的插值，
	// 冻结时必须把它算出来存回 from —— 否则会从旧起点重新插值，画面回弹一下。
	// 上面 `const cur = this._mixStance(this._stanceK)` 一行就是这件事。
	_resolveStance(dt) {
		const P = this.cfg.player;
		const S = P.stance;
		const want = this.input.stance;

		if (want !== this.stance) {
			// 改键：把此刻的连续生效姿态冻结为新的起点
			this._stanceFrom = this._stanceK >= 1 ? this.stance : this._mixStance();
			this.stance = want;
			this._stanceK = 0;
			if (this.onStance) this.onStance(want);
		}

		this._stanceK = Math.min(1, this._stanceK + dt * P.stanceLerp);

		const k = this._stanceK;
		const A = S[this._stanceFrom] || S.walk;
		const B = S[this.stance] || S.walk;
		const mix = (a, b) => a + (b - a) * k;

		return {
			speedK: mix(A.speedK, B.speedK),
			eyeK: mix(A.eyeK, B.eyeK),
			stepK: mix(A.stepK, B.stepK),
			noise: mix(A.noise, B.noise),
			bobK: mix(A.bobK, B.bobK),
			// 加速度倍率按**目标**姿态取，占位到过渡结束 ——
			// 它是阻尼系数，插值会让手感在两帧之间变得不可预测。
			accelK:
				this.stance === 'crouch'
					? P.stanceAccelK.crouch
					: this.stance === 'sneak'
						? P.stanceAccelK.sneak
						: 1,
		};
	}

	// 当前连续生效的姿态参数（不推进时间）。用于在改键瞬间冻结起点。
	_mixStance() {
		const S = this.cfg.player.stance;
		const A = S[this._stanceFrom] || S.walk;
		const B = S[this.stance] || S.walk;
		const k = this._stanceK;
		const mix = (a, b) => a + (b - a) * k;
		return {
			speedK: mix(A.speedK, B.speedK),
			eyeK: mix(A.eyeK, B.eyeK),
			stepK: mix(A.stepK, B.stepK),
			noise: mix(A.noise, B.noise),
			bobK: mix(A.bobK, B.bobK),
		};
	}

	update(dt) {
		const P = this.cfg.player;

		if (!this.enabled) {
			this._apply();
			return;
		}

		// ── 视角 ──────────────────────────────────────────────
		const look = this.input.consumeLook();
		this.yaw += look.yaw;
		this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + look.pitch));

		// ── 姿态 ──────────────────────────────────────────────
		// 先解算姿态，因为速度、步幅、眼高、响度全部由它决定。
		// 注意顺序：姿态必须在速度之前 —— 否则这一帧会用上一帧的姿态跑，
		// 蹲下的第一帧看起来"没生效"。
		const st = this._resolveStance(dt);

		// ── 移动意图 → 世界方向 ───────────────────────────────
		const intent = this.input.moveIntent();
		const wantsMove = intent.x !== 0 || intent.z !== 0;

		// ── 奔跑的升格与降级 ──────────────────────────────────
		// 按住前进累计到 runHold 秒后自动小跑，松开清零。
		// 静步/蹲下时永不奔跑 —— Shift 是"压低"，它和"加速"是互斥的意图，
		// 同时按住的话以压低为准（人的身体不会一边踮脚一边冲刺）。
		if (this.input.wantsForward && wantsMove && this.stance === 'walk') {
			this._runHoldT += dt;
		} else {
			this._runHoldT = 0;
		}
		// 体力门槛用滞后：低于下限就锁住，必须回满到 runStaminaGate 才解锁。
		// 没有这个滞后，体力在 0 附近抖动会让速度反复跳变。
		const gate = P.staminaMax * P.runStaminaGate;
		if (this.stamina <= 1) this._runLocked = true;
		else if (this.stamina >= gate) this._runLocked = false;

		this.running =
			this.stance === 'walk' &&
			this._runHoldT >= P.runHold &&
			!this._runLocked &&
			wantsMove;

		const speed = (this.running ? P.run : P.walk) * st.speedK;
		const sy = Math.sin(this.yaw);
		const cy = Math.cos(this.yaw);
		// 相机前方 = (-sin, -cos)，右方 = (cos, -sin)
		let tx = (-sy * intent.z + cy * intent.x) * speed;
		let tz = (-cy * intent.z - sy * intent.x) * speed;

		// ── 坡度物理 ──────────────────────────────────────────
		// 【为什么在目标速度上乘，而不是在位移上乘】
		// 加速度模型是"实际速度 → 目标速度"的指数趋近。把坡度折进目标，
		// 上坡时玩家会看到自己真实地慢下来（加速度在对抗重力），
		// 松开方向键后也自然恢复 —— 动量模型一处不改，坡度只是"重力的水平分量"。
		//
		// 梯度用 ±1.1 m 的中心差分：小于步幅、大于地形网格（1.15 m）半格，
		// 恰好滤掉脚下的小凸点、留下真正的坡。
		// 腾空时不做 —— 空中没有"坡"可言。
		if (wantsMove && !this.airborne) {
			const e = 1.1;
			const gx =
				(terrainHeight(this.pos.x + e, this.pos.z, this.cfg) -
					terrainHeight(this.pos.x - e, this.pos.z, this.cfg)) /
				(2 * e);
			const gz =
				(terrainHeight(this.pos.x, this.pos.z + e, this.cfg) -
					terrainHeight(this.pos.x, this.pos.z - e, this.cfg)) /
				(2 * e);
			const vl = Math.hypot(tx, tz) || 1;
			// 沿移动方向的高度变化率：正 = 上坡
			const slope = (gx * tx + gz * tz) / vl;
			const k = Math.max(0.78, Math.min(1.14, 1 - slope * P.slopeK));
			tx *= k;
			tz *= k;
			this.slopeK += (k - this.slopeK) * Math.min(1, dt * 6);
		} else {
			this.slopeK += (1 - this.slopeK) * Math.min(1, dt * 6);
		}

		const rate = (wantsMove ? P.accel : P.damp) * (this.airborne ? P.airControl : 1) * st.accelK;
		const k = 1 - Math.exp(-rate * dt);
		this.vel.x += (tx - this.vel.x) * k;
		this.vel.y += (tz - this.vel.y) * k;

		// ── 位移 ──────────────────────────────────────────────
		const prevX = this.pos.x;
		const prevZ = this.pos.z;
		this.pos.x += this.vel.x * dt;
		this.pos.z += this.vel.y * dt;

		const fixed = this.forest.resolve(this.pos.x, this.pos.z, P.radius);
		this.pos.x = fixed.x;
		this.pos.z = fixed.z;

		const moved = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ);
		this.travelled += moved;
		this.speed = dt > 0 ? moved / dt : 0;

		// ── 垂直：跳跃与重力 ──────────────────────────────────
		this._tickVertical(dt);

		// 屈膝下沉的恢复。6.5/s 的速率 ≈ 0.35 s 收到 1/e ——
		// 比"跳起来"慢、比"站起来"快，读起来是膝盖在弹性缓冲。
		this.landDip *= Math.exp(-dt * 6.5);

		// ── 体力 ──────────────────────────────────────────────
		if (this.running) {
			this.stamina = Math.max(0, this.stamina - P.staminaDrain * dt);
		} else {
			this.stamina = Math.min(P.staminaMax, this.stamina + P.staminaRegen * dt);
		}
		// 跳跃不扣体力，只留下一个会自己退掉的"用力痕迹"。
		// 时间常数 2.2 s 是个折中：跳一下大约让呼吸重两秒，
		// 连跳三次才会明显喘 —— 再短就感觉不到，再长就像在做有氧。
		this._exertionBoost = Math.max(0, this._exertionBoost - dt / 2.2);

		// ── 头部摆动与脚步 ────────────────────────────────────
		const norm = Math.min(1.6, this.speed / (P.walk * st.speedK || P.walk));
		// 步频随姿态变化：st.stepK 是 stepsPerMeter 的倍率。
		// 静步的 0.72 让同样距离步数更少（步幅更长），这是设计意图，见 config。
		this.bobPhase += this.speed * dt * P.stepsPerMeter * st.stepK * Math.PI * 2;
		// 腾空时头部摆动必须归零。人跳起来的时候脑袋不会上下颠 ——
		// 那是走路才有的东西，留着它会让跳跃看起来像"原地跑步"。
		const airFactor = this.airborne ? 0 : 1;
		// st.bobK 让蹲下的晃动明显变小 —— 压低身体时头是稳的。
		const amp = P.bobAmp * norm * this.bobAmount * st.bobK * airFactor;
		const bob = Math.sin(this.bobPhase) * amp;
		const sway = Math.cos(this.bobPhase * 0.5) * amp * 0.7;

		// 脚步声不受"头部摆动"设置影响 —— 关掉晃动不该让脚步声消失，
		// 那是听觉信息，不是视觉不适的来源。
		// 同理：腾空时把相位标记也冻结，落地那一步才不会"补发"。
		//
		// 脚步音的力度要乘 st.noise：这是姿态系统与音频层的关键接口。
		// 下限取 0.25 而不是直接用 st.noise —— 蹲着走如果力度趋近 0，
		// 脚步音会完全消失，而"完全没有声音"比"很轻的声音"更假：
		// 玩家会意识到声音被关掉了，而不是自己被藏起来了。
		const sign = Math.sign(Math.sin(this.bobPhase));
		if (!this.airborne && norm > 0.22 && sign !== 0 && sign !== this._prevBobSign) {
			if (this.onStep) {
				this.onStep(Math.min(1.4, norm * (this.running ? 1.25 : 1)) * (0.25 + 0.75 * st.noise));
			}
		}
		this._prevBobSign = sign;

		// 奔跑时轻微拉远视野：制造生理上的"加速"错觉
		const targetFov = this.running ? P.fovRun : P.fov;
		if (Math.abs(targetFov - this._fov) > 0.05) {
			this._fov += (targetFov - this._fov) * Math.min(1, dt * 4);
			this.camera.fov = this._fov;
			this.camera.updateProjectionMatrix();
		}

		this._roll = -sway * 9;
		this._bobOffset = bob;
		this._swayOffset = sway;

		// 对外暴露的两个数：眼高与响度。director 与音频层读它们，
		// 不直接解释 this.stance —— 音频层不该认识"蹲"这个语义，
		// 它只需要知道"现在有多响"。
		this.eyeHeight = P.eye * st.eyeK;
		this.noiseLevel =
			st.noise * Math.min(1, this.speed / (P.walk * st.speedK || P.walk) + 0.15);


		// ── 第三人称机位的遮挡回收 ─────────────────────────────
		// 目标距离 = 沿"头 → 期望机位"的连线采样，第一棵树之前的那段。
		// 平滑只作用于这一个标量（8/s 收敛 ≈ 0.12 s）：
		// 相机位置本身保持刚性 —— 刚性是"跟得紧"，这个标量的弹性是"不跳"。
		if (this.viewMode === 'third') {
			const C = P.thirdPerson;
			const sy2 = Math.sin(this.yaw);
			const cy2 = Math.cos(this.yaw);
			const wantDist = C.distance;
			// 采样 10 步：步长 0.34 m，对半径 0.9 m 的树干判定足够密
			const steps = 10;
			let allowed = wantDist;
			for (let i = 1; i <= steps; i++) {
				const d = (wantDist * i) / steps;
				const px = this.pos.x + sy2 * d;
				const pz = this.pos.z + cy2 * d;
				if (this.forest.treeCountNear(px, pz, 0.9) > 0) {
					allowed = Math.max(C.minDist, ((i - 1) / steps) * wantDist);
					break;
				}
			}
			this._camDist += (allowed - this._camDist) * Math.min(1, dt * 8);
		}

		this._apply();
	}

	// 垂直一帧。这是整个跳跃的全部物理 —— 一段积分 + 一次地面判定。
	//
	// 【为什么必须放在水平位移与碰撞"之后"】
	// forest.resolve 会同时改动 x 和 z，而地面高度是 (x,z) 的函数。
	// 如果在 resolve 之前取地面，玩家被树推开的那一瞬间脚下高度就错了 ——
	// 表现为"贴着树走会轻微陷进地里"。
	//
	// 【落差为什么不能用"起跳点地面 - 落点地面"来算】
	// 这是第一版踩过的坑：跳跃会让人往前飘一两米，而地形是 1–3 m 尺度的
	// 周期噪声，落点的地面对比起跳点完全可能**更高**（往坡上跳）。
	// 两者相减得到负数，被 clamp 成 0 —— 于是从半米高的地方跳下来
	// 一点声音都没有，而声明的 onLand(fall) 参数永远是 0，
	// 所有"按落差决定音量"的设计当场失效。
	//
	// 正确的量是**腾空期间的净下降高度**：记录最高点（绝对高度），
	// 与落点地面相减。它和地形怎么起伏无关，只回答"我从多高掉下来"。
	_tickVertical(dt) {
		const P = this.cfg.player;

		if (this._wantJump) {
			this._wantJump = false;
			if (!this.airborne) {
				this.vy = P.jumpImpulse;
				this.airborne = true;
				// 起跳瞬间的绝对高度就是当前的"最高点"，之后每帧往上抬
				this._apexY = this.pos.y;
				this._exertionBoost = P.jumpExertion;
				// 起跳要有声音：蹬地那一下。power 给得很小，
				// 因为它和落地声是"一对"，两个都响就变成拍手了。
				if (this.onStep) this.onStep(0.34);
			}
		}

		const ground = terrainHeight(this.pos.x, this.pos.z, this.cfg);

		if (this.airborne) {
			this.vy -= P.gravity * dt;
			this.pos.y += this.vy * dt;
			if (this.pos.y > this._apexY) this._apexY = this.pos.y;
			// 落地判定用 <= 而不是 <：地形是 1.15 m 一格的离散网格，
			// 恰好等于地面的概率不低，而 > 会让人"停"在离地 1e-9 米处不下来。
			if (this.pos.y <= ground) {
				const fall = Math.max(0, this._apexY - ground);
				this.pos.y = ground;
				this.vy = 0;
				this.airborne = false;
				this._exertionBoost = Math.max(this._exertionBoost, P.jumpExertion * 0.8);
				// ── 落地物理：屈膝下沉 + 动量去处 ────────────────
				// 下沉量与落差成正比（landDipK），指数恢复 —— 相机和化身
				// 都读这个值，"这一落有多重"第一次有了视觉形态。
				this.landDip = Math.min(0.26, fall * P.landDipK);
				// 重落地吃掉一截水平速度：跳下路坎不能落地即冲刺。
				// 只在落差真正超过门槛时生效，平地蹦跶不受影响。
				if (fall > P.landSlowFall) {
					const s = Math.max(0.78, 1 - fall * P.landSlowK);
					this.vel.x *= s;
					this.vel.y *= s;
				}
				if (this.onLand) this.onLand(fall);
			}
			return;
		}

		// 在地面上：脚踩实地。走上坡时贴着地形抬升，走下坡时不会飞起来
		// （真正的下落只在跳起来之后才有 —— 下坡"吸地"在山径上比自由落体更舒服）。
		this.pos.y = ground;
	}

	_apply() {
		const P = this.cfg.player;
		if (this.viewMode === 'third') {
			this._applyThird();
			return;
		}
		const sy = Math.sin(this.yaw);
		const cy = Math.cos(this.yaw);
		const sway = this._swayOffset || 0;
		// 用 this.eyeHeight 而不是 P.eye —— 蹲下时视线必须真的降下来。
		// 这是姿态系统在画面上唯一必须立刻可见的证据：
		// 眼高从 1.66 m 降到 0.91 m，地面细节、草的高度、
		// 以及"从下往上看树干"的角度都会跟着变。
		this.camera.position.set(
			this.pos.x + cy * sway,
			this.pos.y + this.eyeHeight + (this._bobOffset || 0) - (this.landDip || 0),
			this.pos.z - sy * sway,
		);
		this.camera.rotation.set(this.pitch, this.yaw, (this._roll || 0) * 0.0022);
	}

	// 第三人称机位：人物后上方，俯视背影。
	//
	// 【为什么不用 lookAt】
	// camera.lookAt 会把 rotation 的完整控制权拿走，roll 永远是 0，
	// 且每帧都会与 rotation.order（YXZ）打架。这里直接手动算出
	// 俯角与偏航，用和第一人称同一套 rotation 赋值 —— 两种视角
	// 的数学是同构的，切换时不会有任何"跳"。
	_applyThird() {
		const P = this.cfg.player;
		const C = P.thirdPerson;
		const sy = Math.sin(this.yaw);
		const cy = Math.cos(this.yaw);

		// 机位高度：基准 + 俯仰调节。往下看（pitch<0）→ 相机升高 = 更俯。
		// clamp 防止两个极端：贴地(0.1) 和 飞到树上(基准的 2.2 倍)。
		const lift = Math.max(
			0.1,
			Math.min(C.height * 2.2, C.height - this.pitch * C.heightPitchK),
		);
		const dist = Math.max(C.minDist, this._camDist);

		let cx = this.pos.x + sy * dist;
		let cz = this.pos.z + cy * dist;
		let cyy = this.pos.y + this.eyeHeight + lift;

		// 机位绝不入地：地形起伏比"机位被树挡住"更常见（下坡回头看）
		const groundAtCam = terrainHeight(cx, cz, this.cfg);
		if (cyy < groundAtCam + 0.3) cyy = groundAtCam + 0.3;

		this.camera.position.set(cx, cyy, cz);

		// 注视点：头顶上方 lookAhead 处 → 人物被压到画面下 1/3，
		// 且前方留出大量雾区 —— 俯视的"内容"是人物的背影 + 他面前的未知。
		const tx = this.pos.x - sy * 2.0;
		const tz = this.pos.z - cy * 2.0;
		const ty = this.pos.y + this.eyeHeight + C.lookAhead;
		const dx = tx - cx;
		const dy = ty - cyy;
		const dz = tz - cz;
		const flat = Math.hypot(dx, dz);
		// yaw：机位在人物正后方，所以视线方向 = 前方 = (-sy, -cy)。
		// atan2(-dx, -dz) 与 stalker.faceTarget 同一套约定。
		const yaw = Math.atan2(-dx, -dz);
		const pitch = Math.atan2(dy, flat);
		this.camera.rotation.set(pitch, yaw, 0);
	}

	// 供音频层使用的"用力程度"：体力越低、跑得越快，数值越高。
	// 跳跃通过 _exertionBoost 汇入同一条通道 —— 音频层不需要知道"跳跃"这个概念，
	// 它只认 exertion，这符合"音频不许反向读游戏状态"的纪律。
	getExertion() {
		const P = this.cfg.player;
		const spent = 1 - this.stamina / P.staminaMax;
		const motion = Math.min(1, this.speed / P.run);
		return Math.max(0, Math.min(1, spent * 0.7 + motion * 0.5 + this._exertionBoost));
	}

	setQuality(fovLimit) {
		this.cfg.player.fov = Math.min(this.cfg.player.fov, fovLimit);
	}
}
