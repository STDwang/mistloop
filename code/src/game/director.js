// 导演。这是整个游戏的"大脑"。
//
// 所有"什么时候发生什么"的决策都集中在这里：
//   环面回绕 · 轮次 · 恐惧值 · 天气 · 显形规则 R1–R6 · 距离阶梯 · 贴脸 · 地标阶段 · 字幕
//
// Stalker 和世界都是被动的。把决策散到各个类里，是这类项目最常见的自毁方式。

import { CFG } from '../config.js';

const TAU = Math.PI * 2;

function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function wrapAngle(a) {
	return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

export class Director {
	constructor(ctx) {
		this.cfg = CFG;
		this.player = ctx.player;
		this.input = ctx.input;
		this.stalker = ctx.stalker;
		this.audio = ctx.audio;
		this.hud = ctx.hud;
		this.landmark = ctx.landmark;
		this.atmosphere = ctx.atmosphere;
		this.forest = ctx.forest;
		this.undergrowth = ctx.undergrowth;
		this.camera = ctx.camera;
		// 这一版新增的三个依赖。全部是"必需项"而不是可选功能：
		this.flashlight = ctx.flashlight; // 定身判定要读真实光束
		this.lightning = ctx.lightning; // 显形的可见度来自它
		this.safehouse = ctx.safehouse; // 目标与方向
		this.debug = /(\?|&)debug(=|&|$)/.test(location.search);

		this.log = [];
		this.time = 0;

		this.phase = 0;
		this.wraps = 0;
		this.distance = 0;
		this.dread = 0.06;
		this.weather = 0.08;
		this.tension = 0;
		this.appearIndex = 0;
		this.state = 'DORMANT';
		this.cooldown = 11;
		this.life = 0;
		this.stareTime = 0;
		this.appearT = 0;
		this.hold = 0;
		this.vanishFrom = 0;
		this.sinceTravel = 0;
		this.idleTime = 0;
		this.pending = null;
		this.fogDensity = this.cfg.atmosphere.fogMin;
		this.stats = { manifests: 0, stared: 0, missed: 0, climaxes: 0, held: 0, escapes: 0 };

		// ── 手电定身 ────────────────────────────────────────────
		// lit 是**本帧的几何判定结果**（不是平滑值）—— 冻结移动这种事
		// 必须用精确值，用平滑值会让"照到"有一帧的延迟。
		// stalker 那边的 litTarget 只负责视觉上的柔和过渡。
		this.lit = false;
		this._wasLit = false;
		// 复用同一个对象，避免每帧分配（这个判定每帧都跑）
		this._aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 };

		// ── 方向记忆 ────────────────────────────────────────────
		// bearingKnown：此刻有多清楚（定住时上涨，松开后衰减）
		// bearingFloor：永久记住的部分（每次成功读到方向涨一点）
		// 两层缺一不可，理由见 config.js 的 safehouse 注释。
		this.bearingKnown = 0;
		this.bearingFloor = 0;
		this.bearingRel = 0; // 相对相机的方位角（给 HUD 画那个刻度）
		this.holdT = 0; // 连续照住的时长
		this.revealedThisManifest = false;
		this.escaped = false;
		this.state = 'DORMANT';
	}

	// ── 主循环 ───────────────────────────────────────────────────

	update(dt, elapsed) {
		const P = this.player;
		const T = this.cfg.world.tile;
		const A = this.cfg.atmosphere;
		this.time += dt;

		// ① 闪电。**必须在所有读它的代码之前更新**。
		// 它不只是特效：鬼影的可见度、雾的亮度、天光都从 flash 派生，
		// 晚一帧更新会让"闪电亮起"和"它显形"错开一帧 —— 肉眼看得出。
		this.lightning.update(dt, this.tension);
		this.stalker.setLightning(this.lightning.flash);

		// ② 环面回绕。
		// 玩家坐标挪回 [0, tile)；因为世界内容全是周期函数，画面上零变化。
		let wrapped = false;
		if (P.pos.x >= T) {
			P.pos.x -= T;
			wrapped = true;
		} else if (P.pos.x < 0) {
			P.pos.x += T;
			wrapped = true;
		}
		if (P.pos.z >= T) {
			P.pos.z -= T;
			wrapped = true;
		} else if (P.pos.z < 0) {
			P.pos.z += T;
			wrapped = true;
		}
		if (wrapped) this._onWrap();

		// 到家之后不再推进任何东西 —— 恐怖游戏在"安全"之后必须真的停下来。
		// 只留方向/HUD 的更新，好让结局画面里的方位刻度收敛而不是冻结在半路。
		if (this.escaped) {
			this._updateBearing(dt);
			return;
		}

		// ② 行进 / 静止统计
		//
		// 【姿态系统在这里真正生效】
		//
		// moved 不只是"走了多远"，它是全部"连续行进"类触发规则的燃料
		// （R2 的 sinceTravel）。所以用 noiseLevel 加权它，姿态就立即有了代价：
		//   · 正常走  → 1.0，走 40 m 触发身影
		//   · 静步    → 0.22，要走 180 m 才积累到同样的暴露
		//   · 蹲下    → 0.12，几乎不被"走得太久"这条规则抓住
		// 换句话说：慢下来不是浪费时间，是把暴露换成时间。
		//
		// distance（玩家自己的里程）**不加权** —— 那是给玩家看的路程，
		// 不该因为他踮着脚走就少算。两个计数器服务两个不同的读者。
		const noise = P.noiseLevel === undefined ? 1 : P.noiseLevel;
		const stepDist = P.speed * dt;
		this.distance += stepDist;
		this.sinceTravel += stepDist * noise;
		if (P.speed < 0.3 && this.state !== 'CLIMAX') this.idleTime += dt;
		else this.idleTime = 0;

		// ③ 恐惧值只升不降（阶段之间会回退一部分，但从不归零）
		const E = this.cfg.entity;
		this.dread = Math.min(1, this.dread + dt * (E.riseRate + 0.0031 * this.phase));

		// ④ 天气：阶段越高越糟，叠加一层缓慢起伏。
		// 基线来自 config（0.30 = 连阴雨），所以雨是**常驻**的。
		this.weather = clamp01(
			A.weatherBase + A.weatherPhase * this.phase + A.weatherWave * Math.sin(elapsed * 0.037),
		);

		// ⑤ 显形预兆：先听见，0.4 秒后出现（预兆纪律，不许颠倒）
		if (this.pending) {
			this.pending.t -= dt;
			if (this.pending.t <= 0) {
				const p = this.pending;
				this.pending = null;
				this._spawn(p.rule, p.behind);
			}
		}

		// ⑥ 实体状态机
		this._tickEntity(dt);

		// ⑦ 张力：恐惧值与"它有多近"取较大者
		const prox = this.stalker.active
			? clamp01(1 - this.stalker.distanceTo(P.pos) / 80)
			: 0;
		this.tension = Math.max(this.dread * 0.72, prox);
		this.audio.setTension(this.tension, P.getExertion());
		this.audio.setWeather(this.weather);

		// 女鬼呼吸的接近度（本次新增）：距离接近度 × 显形不透明度。
		// 【为什么必须乘 opacity】它溶解的时候"它"就不在了 —— 只看距离
		// 的话，淡出的 1.9 s 里呼吸还会挂着，DORMANT 期甚至会有一层
		// 没有主人的呼吸。乘上不透明度，呼吸和身影同生同灭。
		// 【为什么放在 setTension 之后】_tickEntity（⑥）刚把 opacity 写完，
		// 这里读到的是本帧的最新值；呼吸层用的是与 tension 无关的独立
		// 驱动 —— 玩家自己的紧张（tension）和"它在附近"（prox）是两件事。
		const AUD = this.cfg.audio;
		const gd = this.stalker.active ? this.stalker.distanceTo(P.pos) : Infinity;
		const gProx = clamp01(1 - (gd - AUD.ghostBreathNear) / (AUD.ghostBreathFar - AUD.ghostBreathNear));
		this.audio.setGhost(gProx * this.stalker.opacity);

		// ⑧ 地标
		if (this.landmark.update(dt, P.pos.x, P.pos.z)) this.audio.oneShot('bell', 0.9);
		this.landmark.setStage(Math.min(4, this.phase + Math.floor(this.wraps / 2)));

		// ⑨ 方向记忆 + 安全屋。到家判定也在这里。
		this._updateBearing(dt);
		if (this.safehouse.update(dt, P.pos.x, P.pos.z)) this._escape();

		// ⑩ 大气与 HUD
		this.fogDensity = Math.min(A.fogMax, A.fogMin + A.fogWeather * this.weather + A.fogPhase * this.phase);
		this.atmosphere.setWeather(this.weather);
		this.hud.setDistance(this.distance);
		this.hud.setTension(this.tension);
	}

	// ── 实体状态机 ───────────────────────────────────────────────

	_tickEntity(dt) {
		const E = this.cfg.entity;
		const P = this.player;

		if (this.state === 'DORMANT') {
			this.cooldown -= dt;
			if (this.cooldown <= 0 && !this.pending) this._checkTriggers(dt);
			return;
		}

		if (this.state === 'MANIFEST') {
			this.appearT += dt;
			const fadeIn = Math.min(1, this.appearT / 0.55);
			const dist = this.stalker.distanceTo(P.pos);
			const ang = Math.abs(this._angleToEntity());

			// 手电有没有照到它。这是纯粹的几何判定，不平滑 ——
			// "定住"必须在一帧内生效，慢一帧玩家会看到它在你光里滑了一下。
			const lit = this._litByTorch();
			this.lit = lit;
			this.stalker.litTarget = lit ? 1 : 0;
			// 照上去的那一瞬间给一次声音反馈。用"上升沿"而不是持续播放：
			// 持续播放会变成一条嗡鸣的底噪，而这件事应该是一次**事件**。
			if (lit && !this._wasLit) {
				this.audio.oneShot('hold', 1);
				this.stats.held++;
			}
			this._wasLit = lit;

			if (lit) {
				// ── 被光钉住 ──────────────────────────────────
				// 三件事同时发生，它们共同定义"定住"：
				//   ① 不移动（哪怕它本来在视野边缘、本该逼近）
				//   ② **寿命暂停**（它不会自己到期消失）
				//   ③ 注视驱逐变慢（holdStareK）—— 被钉住的东西不该这么快溶解
				//
				// ①②合起来意味着：只要光束在它身上，你可以一直把它留在那里。
				// 代价只有恐惧值（dreadOnHold）。这是一个自我平衡的循环：
				// 盯得越久 → 恐惧越高 → 松手时它越快越近。
				this.stareTime += dt * this.cfg.flashlight.holdStareK;
				this.dread = Math.min(1, this.dread + dt * E.dreadOnHold);
			} else {
				this.life -= dt;
				if (ang < E.stareAngle) {
					// 直视它 → 累积"注视"
					this.stareTime += dt;
				} else {
					this.stareTime = Math.max(0, this.stareTime - dt * 1.8);
					// 只有在视野之外（> freezeAngle）它才移动 —— 这是整条规则的心脏
					if (ang > E.freezeAngle) {
						const closing = E.closingMin + (E.closingMax - E.closingMin) * this.dread;
						this.stalker.advanceToward(P.pos, closing * dt);
					}
				}
			}

			this.stalker.setDistanceHint(dist);
			this.stalker.opacity = this._visibility() * fadeIn;

			if (dist < E.climaxDistance) this._enterClimax();
			else if (this.stareTime > E.stareLimit) this._vanish(true);
			else if (this.life <= 0) this._vanish(false);
			return;
		}

		if (this.state === 'VANISH') {
			// 慢慢淡化。fadeSeconds 是 1.9 s（原来 0.18 s）——
			// 这个数就是"取消全屏闪一下"这件事的实处：原来那 0.18 s
			// 加上一记反色闪，读起来是"啪一下没了"；1.9 s 才是"它散掉了"。
			//
			// 用 smoothstep 而不是线性：两端软、中间快。
			// 线性淡出会有一个"开始掉"的硬起点，看起来像改变不透明度；
			// smoothstep 看起来像**溶解**，这是两种不同的东西。
			this.hold -= dt;
			const k = Math.max(0, this.hold / E.fadeSeconds);
			this.stalker.opacity = this.vanishFrom * (k * k * (3 - 2 * k));
			if (this.hold <= 0) {
				this.stalker.hide();
				this.state = 'DORMANT';
				this.cooldown =
					E.cooldownMax - (E.cooldownMax - E.cooldownMin) * this.dread;
			}
			return;
		}

		if (this.state === 'CLIMAX') {
			this.hold += dt;
			if (this.hold < 0.5) {
				// 把它推到镜头正前方。这是全程唯一一次贴脸。
				const f = this.hold / 0.5;
				const d = E.climaxDistance - 3.1 * f;
				const x = P.pos.x - Math.sin(P.yaw) * d;
				const z = P.pos.z - Math.cos(P.yaw) * d;
				const y = P.pos.y + this.cfg.player.eye - 0.05 - 0.7 * f;
				this.stalker.place(x, z, y);
				this.stalker.faceTarget(P.pos.x, P.pos.z);
				this.stalker.opacity = 0.62 + 0.38 * f;
			} else {
				this.stalker.opacity = Math.max(0, 1 - (this.hold - 0.5) / 0.3);
			}
			if (this.hold > this.cfg.director.climaxHold + 0.4) this._endClimax();
		}
	}

	// 六条触发规则。这是"移动/转身/久站"全部落到代码里的地方。
	_checkTriggers(dt) {
		const E = this.cfg.entity;

		// R1 转身中东张西望 —— 玩家最放松的时刻
		if (this.input.turnWindow > 2.2 && Math.random() < (0.5 + 0.9 * this.dread) * dt) {
			return this._trigger('R1', false);
		}
		// R2 连续行进 —— 人进入自动驾驶
		const travel = E.travelMax + (E.travelMin - E.travelMax) * this.dread;
		if (this.sinceTravel > travel) return this._trigger('R2', false);
		// R3 久站 —— "我在听"的代价，出现在背后
		if (this.idleTime > E.idleSeconds) return this._trigger('R3', true);
		// R5 环境骰子 —— 保证低恐惧期也有偶发压迫
		if (Math.random() < E.dice * (0.4 + this.dread) * dt) return this._trigger('R5', false);
	}

	// 先出声，后显形。中间隔 0.4 秒。
	_trigger(rule, behind) {
		if (this.pending || this.stalker.active) return;
		this.pending = { rule, behind, t: 0.4 };
		this.audio.oneShot('crack', 0.55);
		// 闪电在显形**之前**就预约，延后 0.32 s：闪光要正好落在它淡入的
		// 那一刻（淡入 0.55 s），而不是在它还没出现时就先炸完了。
		//
		// 【这根线是整个改动里最关键的一根】
		// 没有它，"闪电下才看得清它"会退化成"运气好才看得清"——
		// 玩家永远不会把这两件事联系起来，而"看见"这件事也就失去了可控性。
		// 有了它，每一次显形都自带一次照明，机制才是可被学习的。
		if (Math.random() < this.cfg.lightning.manifestChance) {
			this.lightning.request(0.65, 0.32);
		}
	}

	_spawn(rule, behind) {
		const E = this.cfg.entity;
		const P = this.player;
		const idx = Math.min(this.appearIndex, E.distances.length - 1);
		const d = E.distances[idx];

		// R6：方位必须落在视野边缘，逼玩家自己转头去确认。
		// 但密林里随便挑一个方位大概率正对着树干 —— 所以一次试 8 个候选，
		// 选"落点是空地且视线走廊最通畅"的那个。宁可多算，也不能让它永远隐形。
		const cand = [];
		const signs = [1, -1];
		for (const sign of signs) {
			for (let k = 0; k < 4; k++) {
				const base = behind
					? Math.PI + (Math.random() - 0.5) * E.behindJitter * 2
					: sign * (E.angleMin + Math.random() * (E.angleMax - E.angleMin));
				cand.push(base);
			}
		}
		let best = null;
		for (const off of cand) {
			const a = P.yaw + off;
			const x = P.pos.x - Math.sin(a) * d;
			const z = P.pos.z - Math.cos(a) * d;
			// 出生点必须是空地；近处 8 米必须通畅（近处一根树干就能挡住整个画面）
			const gap = this.forest.treeCountNear(x, z, 1.8);
			const nearOcc = this.forest.corridorOcclusion(P.pos.x, P.pos.z, x, z, 8);
			const farOcc = this.forest.corridorOcclusion(P.pos.x, P.pos.z, x, z, Math.min(d, 32));
			const score = gap * 5 + nearOcc * 5 + farOcc * 1.5;
			if (!best || score < best.score) best = { off, x, z, score };
			if (best.score < 0.5) break;
		}

		const a = P.yaw + best.off;
		this.stalker.place(best.x, best.z);
		this.stalker.faceTarget(P.pos.x, P.pos.z);
		this.stalker.show();
		this.stalker.opacity = 0;
		this.stalker.setDistanceHint(d);

		this.state = 'MANIFEST';
		this.appearT = 0;
		this.stareTime = 0;
		this.life = E.lifeMax + (E.lifeMin - E.lifeMax) * this.dread;
		this.sinceTravel = 0;
		this.idleTime = 0;
		this.lit = false;
		this._wasLit = false;
		this.stalker.litTarget = 0;
		this.holdT = 0;
		this.revealedThisManifest = false;
		this.stats.manifests++;
		this._log(
			`manifest rule=${rule} dist=${d} index=${idx} behind=${behind} ` +
				`yawOff=${best.off.toFixed(2)} gapScore=${best.score.toFixed(2)}`,
		);
	}

	// ── 手电是否照在它身上 ───────────────────────────────────────
	//
	// 【为什么这是一个"三维"判定，而不是"它在屏幕中间吗"】
	// 鬼影有 2.55 m 高，而它是站在地上的。只比水平角的话，
	// 在 6 米处"看着它的脚"和"看着它的头"的水平角几乎一样 ——
	// 于是低头照它的脚也算照到。近处（也正是最需要判定准的时候）
	// 这个误差最大。所以判定瞄的是它身体的**中段**（aimAt），
	// 并且用一个真正的三维方向夹角（含俯仰）。
	//
	// 光束的起点与朝向取自 Flashlight.aim()，也就是**真实的挂点**：
	// 第一人称是相机、第三人称是化身的头。用相机去凑合会让第三人称下
	// 整体偏一个身位（见 flashlight.js 的注释）。
	_litByTorch() {
		const FL = this.flashlight;
		if (!FL || !FL.on) return false;
		const F = this.cfg.flashlight;
		const S = this.stalker;
		const a = FL.aim(this._aim);
		// 瞄身体中段
		const tx = S.pos.x - a.ox;
		const ty = S.pos.y + this.cfg.entity.height * F.aimAt - a.oy;
		const tz = S.pos.z - a.oz;
		const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
		if (d < 1e-3 || d > F.holdRange) return false;
		// a.d* 是单位向量（transformDirection 保长），所以点积就是 cos
		const cos = (tx * a.dx + ty * a.dy + tz * a.dz) / d;
		return cos > Math.cos(F.holdAngle);
	}

	_vanish(stared) {
		const E = this.cfg.entity;
		this.state = 'VANISH';
		this.hold = E.fadeSeconds;
		this.vanishFrom = this.stalker.opacity;
		this.lit = false;
		this._wasLit = false;
		this.stalker.litTarget = 0;

		// ── 这里原来有一次全屏反色闪烁（hud.glitch）。现在它没有了。 ──
		//
		// 需求原文是"取消鬼影消失时的全屏突然闪一下"。
		// 除了"用户要求"之外，这个删除本身也是对的：
		// 屏幕闪和闪电照是两种**性质完全不同**的"亮"——
		// 一个是后期叠加（照不亮任何东西），一个是真实光源。
		// 两者放在一起会互相拆台：玩家分不清哪次亮是天气、哪次是超自然现象，
		// 而"闪电下能看见它"这个机制恰恰要求这个区分是清晰的。
		//
		// 只留声音。声音不占屏幕，而且"它走了"这件事本来就该由听觉通报。
		if (stared) {
			this.dread = Math.min(1, this.dread + 0.12);
			this.audio.oneShot('sting', 0.85);
			this.stats.stared++;
		} else {
			this.audio.oneShot('stingSoft', 0.7);
			this.stats.missed++;
		}

		// 奖赏：这一次你读到方向了吗。
		// 判据是"照够时长"（revealedThisManifest），不是"照了一下"——
		// 所以"每成功读一次就永久多记住一点"这件事是有门槛的。
		const S = this.cfg.safehouse;
		if (this.revealedThisManifest) {
			this.bearingFloor = Math.min(S.floorMax, this.bearingFloor + S.floorStep);
			this._log(`remembered: bearingFloor -> ${this.bearingFloor.toFixed(2)}`);
		}

		// 有一半概率在它淡化时来一记闪电。
		// 这不是为了好看 —— 需求明确写了"然后慢慢淡化"：
		// 淡化只有被光照亮时才**看得见**，所以必须在淡化期间给一次照明，
		// 否则 1.9 s 的溶解过程在一团灰雾里等于不存在。
		if (Math.random() < 0.5) this.lightning.request(0.7, 0.1);

		// 注视不是逃脱，是延期：阶梯只会前进
		this.appearIndex = Math.min(this.cfg.entity.distances.length - 1, this.appearIndex + 1);
		this._log(`vanish stared=${stared} nextIndex=${this.appearIndex}`);
	}

	_enterClimax() {
		this.state = 'CLIMAX';
		this.hold = 0;
		this.stats.climaxes++;
		this.audio.oneShot('climax');
		// 【这里保留了 glitch，而 vanish 里的删掉了 —— 这不是漏改】
		// 用户要求取消的是"鬼影**消失**时"的全屏闪。被追上不是消失，
		// 它是全程唯一一次贴脸，需要一个硬切的标点。
		// 而且它紧跟着 fade(1, 0.4) 全黑，那记反色只能看到一帧 ——
		// 和"消失时闪一下"是两种完全不同的观感。
		// 如果你连这一处也不想要，删掉下面这行即可。
		this.hud.glitch(0.6);
		this.hud.fade(1, 0.4);
		this._log('CLIMAX');
	}

	_endClimax() {
		const T = this.cfg.world.tile;
		const x = Math.random() * T;
		const z = Math.random() * T;
		this.player.warpTo(x, z);
		// 传送会让实例网格大范围失效，必须强制重建
		this.forest.refresh(x, z, true);
		this.undergrowth.refresh(x, z, true);

		this.phase += 1;
		this.appearIndex = Math.min(8, 4 + this.phase);
		this.dread = Math.min(1, 0.42 + this.phase * 0.07);
		this.stalker.hide();
		this.state = 'DORMANT';
		this.cooldown = 9;
		this.pending = null;
		this.lit = false;
		this._wasLit = false;
		this.holdT = 0;

		// 被弄糊涂了：这一次的"清楚"没了，但**永久记住的部分不受影响**。
		// 这是惩罚的边界 —— 一次被抓不该等于重开，
		// 否则"一点一点想起回家的路"这个进程会被反复清零，
		// 玩家会觉得自己在原地打转（而那正是这个游戏要让人摆脱的感觉）。
		const DD = this.cfg.director;
		this.bearingKnown = this.bearingFloor * DD.climaxBearingKeep;

		const D = this.cfg.director;
		this.hud.fade(0, 1.4);
		this.hud.setPhase(this.phase);
		this.hud.subtitle(D.climaxLines[Math.floor(Math.random() * D.climaxLines.length)], 5);
		this._log(`phase -> ${this.phase}`);
	}

	_onWrap() {
		this.wraps += 1;
		this.hud.setLap(this.wraps);
		const D = this.cfg.director;
		const line = D.wrapLines[Math.min(this.wraps - 1, D.wrapLines.length - 1)];
		this.hud.subtitle(line, 5.5);
		// R4：每次回绕必触发。把"轮回"和"它"绑定成同一件事。
		if (this.state === 'DORMANT' && !this.pending) this._trigger('R4', false);
		else this.audio.oneShot('crack', 0.6);
		this._log(`wrap #${this.wraps}`);
	}

	// ── 方向记忆 ─────────────────────────────────────────────────
	//
	// 【为什么"知道回家的路"必须是一个会衰减的量】
	// 如果方向一旦获得就永久保留，玩法的后半段会退化成"照着箭头走"，
	// 鬼影彻底变成一个障碍物 —— 而"用鬼影指路"这个设计的意思正相反：
	// 它是你**唯一的信息来源**，你必须一次次回去问它。
	//
	// 所以拆成两层（见 config 的 safehouse 注释）：
	//   bearingKnown 会衰减 —— 逼你反复回到它面前
	//   bearingFloor 不衰减 —— 保证你在**进步**，而不是原地打转
	// 只有前者，玩法会变成"每 15 米去找一次鬼"，极其烦人；
	// 只有后者，就退化成"照着箭头走"。两个一起才对。
	_updateBearing(dt) {
		const S = this.cfg.safehouse;
		const P = this.player;

		if (this.lit) {
			this.holdT += dt;
			// 连续照够时长才开始"读"到方向。
			// 门槛是必要的：如果一照到就有方向，那"定住"就只是个开关，
			// 玩家不会意识到自己是在**读**什么东西。
			if (this.holdT >= S.holdToReveal) {
				this.revealedThisManifest = true;
				const before = this.bearingKnown;
				this.bearingKnown = Math.min(1, this.bearingKnown + S.gainRate * dt);
				if (before < 0.5 && this.bearingKnown >= 0.5) this._onReveal();
			}
		} else {
			this.holdT = 0;
			if (this.bearingKnown > this.bearingFloor) {
				this.bearingKnown = Math.max(
					this.bearingFloor,
					this.bearingKnown - S.decayRate * dt,
				);
			}
		}

		// 相对相机的方位角，给 HUD 画那个刻度
		this.bearingRel = wrapAngle(this.safehouse.bearing - P.yaw);
		this.hud.setBearing(this.bearingRel, this.bearingKnown);

		const D = this.cfg.director;
		this.hud.setObjective(this.bearingKnown > 0.04 ? D.objectiveFound : D.objectiveLost);
	}

	// bearing 第一次越过"可用"的那一瞬间。只播一次，避免每帧刷字幕。
	_onReveal() {
		const S = this.cfg.safehouse;
		this.hud.subtitle(S.revealLines[Math.floor(Math.random() * S.revealLines.length)], 3.4);
		// 用 stingSoft 而不是新做的音效：它是一记已经调好的低频下扫，
		// 语义正好是"有什么东西被登记进去了"，而且不像铃铛那样有奖励感。
		this.audio.oneShot('stingSoft', 0.45);
		this._log(`bearing revealed (floor=${this.bearingFloor.toFixed(2)})`);
	}

	// ── 工具 ─────────────────────────────────────────────────────

	_angleToEntity() {
		const P = this.player;
		const dx = this.stalker.pos.x - P.pos.x;
		const dz = this.stalker.pos.z - P.pos.z;
		const targetYaw = Math.atan2(-dx, -dz);
		return wrapAngle(targetYaw - P.yaw);
	}

	// ── 到家 ─────────────────────────────────────────────────────
	//
	// 【为什么"赢"必须是一个真正的结局，而不是继续玩】
	// 恐怖游戏的紧张感来自"不知道什么时候结束"。一旦玩家知道自己安全了，
	// 恐惧会瞬间归零 —— 继续留在场上只会把那一口气泄掉。
	// 所以到家就是终点：鬼影退场、指针释放、面板接管。
	_escape() {
		if (this.escaped) return;
		this.escaped = true;
		this.stats.escapes++;
		this.state = 'ESCAPED';
		this.lit = false;
		this._wasLit = false;
		this.stalker.hide();
		this.audio.oneShot('bell', 0.9);
		const D = this.cfg.director;
		this.hud.setEscaped(
			D.winLines[Math.floor(Math.random() * D.winLines.length)],
			this.time,
			this.wraps,
		);
		this._log(`ESCAPED t=${this.time.toFixed(0)}s wraps=${this.wraps}`);
	}

	// 雾中可见度：远处只是一个"糊掉的黑条"，近处才是实心黑
	_visibility() {
		const E = this.cfg.entity;
		const d = this.stalker.distanceTo(this.player.pos);
		const fog = Math.min(1, 0.16 + 0.84 * clamp01(1 - d / 95));
		// 闪电：黑剪影的可见度**全靠背后那层雾有多亮**。
		// 这是本次"改为在有闪电照耀时能被观察到"在代码里的全部实现 ——
		// 它不是一个开关，是一个乘子：平时雾灰暗，那一圈几乎不可见；
		// 一记闪电把雾点亮，同一圈立刻跳出来。
		const back = 1 + E.backlight * this.lightning.flash;
		// 被手电照住时给它一个下限：它就在你的光锥正中央，
		// 不该因为"离得远"或"雾太浓"而看不清。
		const lit = this.lit ? E.litOpacity : 0;
		return Math.min(1, Math.max(lit, fog * back));
	}

	_log(msg) {
		if (!this.debug) return;
		const line = `[t=${this.time.toFixed(1)}s] ${msg}`;
		this.log.push(line);
		console.log(line);
	}
}
