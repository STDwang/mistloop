// 闪电。
//
// ─────────────────────────────────────────────────────────────
// 【这是本次改动里最需要解释的一个文件】
//
// 需求原文：「取消鬼影消失时的全屏突然闪一下，改为在有闪电照耀时能被观察到」
// 以及：「有雷声闪电，闪电带来的光效，对森林的光效影响要自然」
//
// "对森林的光效影响要自然"这句话直接排除了最省事的做法 ——
// 在 DOM 上盖一层白色 overlay 闪一下。那种"闪电"成本为零，
// 但它照不亮任何东西：玩家看到的是**屏幕**亮了，不是**森林**亮了。
// 更糟的是，它和"鬼影消失时的全屏闪"是同一类东西，
// 两个混在一起会让玩家分不清哪个是天气、哪个是超自然现象。
//
// 所以这里做的是一盏**真的方向光**：它从天上某个方位打下来，
// 树的一面被照亮、另一面沉下去，地形的起伏出现新的明暗关系。
// 三个必须配套的东西，缺一个就会露馅：
//
//   ① 雾色与天空同时提亮。真实闪电会把整个**雾的体积**点亮 ——
//      少了这一步，远处的树会像贴纸一样浮在一层没变的雾上。
//   ② 每次闪电的方位随机。连续两记从同一方向来，立刻就是"一盏灯"。
//   ③ 复击（multi-pulse）。真实的雷不是一记，是 2–4 记极快的连击，
//      间隔 30–120 ms。单脉冲读起来像相机闪光灯，复击才像雷。
//
// 【绝对不能做的事：把灯从场景里加进去/拿出来】
// three.js 的材质在编译时会把"场景里有几盏灯"烘进 shader program。
// 如果每次闪电都 scene.add(light) / remove(light)，那就是每一次闪电
// 都触发全场景材质重编译 —— 一个几百毫秒的硬卡顿，正好落在
// 最需要流畅的那一瞬间（闪电亮起的时候）。
// 所以这盏灯**永远在场景里**，平时 intensity = 0。
// 强度是 uniform，改它零成本。
//
// 【为什么不投影】方向光的阴影贴图要覆盖约 200 m 的可视范围，
// 分辨率不足就糊，而 castShadow 一旦为 true 就是**每帧**渲染 ——
// 哪怕闪电 20 秒才来一次。宁可不要那道影子，也不接受每帧的代价。
// 方向性本身（哪面亮哪面暗）已经足够读出"光是从哪来的"。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';

const TAU = Math.PI * 2;

export class Lightning {
	constructor(cfg, scene) {
		this.cfg = cfg;
		const L = cfg.lightning;

		// 冷白色的电光。比"纯白"更可信：闪电的光谱偏蓝紫，
		// 而纯白会让整片森林发黄，那是室内闪光灯的颜色。
		this.color = new THREE.Color(0xd8e4f2);

		this.light = new THREE.DirectionalLight(this.color, 0);
		this.light.castShadow = false;
		// 目标必须是场景图的一部分，方向光才会朝它照
		this.light.target.position.set(0, 0, 0);
		scene.add(this.light);
		scene.add(this.light.target);

		this.t = 0;
		// 当前亮度系数 0–1。main.js 读它去提亮雾/天空/半球光。
		this.flash = 0;
		// 下一记闪电的倒计时
		this._next = 6;
		this._pulses = [];
		this._thunder = [];
		// 被"预约"的闪电（导演要求对齐到某个时刻，见 request）
		this._pending = [];
		this.strikes = 0;
		this.closest = Infinity;

		// 由 director 接上（雷声是音频侧的事，闪电不该知道 AudioContext。
		// 回调签名 (near, az)：nearness 管音色，az 管"从哪边来"的声像）
		this.onThunder = null;
	}

	// 导演强制要求一记闪电（显形/消失时用）。
	// urgency 0–1：越高越可能是近雷。
	// delay：延后多少秒才打。用来把闪光对齐到某个时刻 ——
	// 导演在**显形前 0.4 秒**就请求，让闪光正好落在它出现的那一瞬间，
	// 而不是在它还没淡入的时候就先炸完了。
	request(urgency = 0.5, delay = 0) {
		if (delay <= 0) {
			this._strike(THREE.MathUtils.lerp(0.75, 0.15, urgency));
			return;
		}
		this._pending.push({ t0: this.t + delay, urgency });
	}

	// distK：0 = 尽量远，1 = 尽量近
	_strike(distK) {
		const L = this.cfg.lightning;
		this.strikes++;

		// 距离。distBias > 1 让远雷更常见 —— 真实雷暴里近雷是少数,
		// 而"远处的闷雷"恰恰是最有氛围的一种。
		const k = Math.pow(Math.random(), L.distBias);
		const d = L.distMin + (L.distMax - L.distMin) * THREE.MathUtils.lerp(k, 1 - k, distK);
		this.closest = Math.min(this.closest, d);

		// 近雷更亮。用 1/sqrt 而不是 1/r²：眼睛会自动适应，
		// 真正的 1/r² 会让远雷彻底看不见，而那正是我们要保留的东西。
		const near = 1 - (d - L.distMin) / (L.distMax - L.distMin);
		const brightness = 0.42 + 0.58 * near;

		// 每次从不同方位来。仰角保持高（55°–78°），闪电在云里，
		// 不是从地平线打过来的。
		const az = Math.random() * TAU;
		const el = THREE.MathUtils.lerp(0.96, 1.36, Math.random());
		const ce = Math.cos(el);
		this.light.position.set(Math.sin(az) * ce * 120, Math.sin(el) * 120, Math.cos(az) * ce * 120);
		this.light.target.position.set(0, 0, 0);
		this._az = az;

		// 复击：2–4 记脉冲，间隔越来越长（真实的雷是"先密后疏"）
		const n = L.pulses[0] + Math.floor(Math.random() * (L.pulses[1] - L.pulses[0] + 1));
		let t = 0;
		for (let i = 0; i < n; i++) {
			// 后续脉冲比第一记弱：主放电只有一次
			const p = brightness * (i === 0 ? 1 : 0.34 + Math.random() * 0.36);
			this._pulses.push({ t0: this.t + t, peak: p });
			t += L.pulseGap[0] + Math.random() * (L.pulseGap[1] - L.pulseGap[0]) * (1 + i * 0.6);
		}

		// 雷声：光的到达是瞬时的，声音不是。
		// 这个除法是整个世界最诚实的一个公式 —— 每一记雷的延迟都不同，
		// 而且都和它自己的距离严格对应。
		// az（方位角）一并入队：雷空间化需要"从哪边来"，延迟和方位
		// 是同一次放电的两个属性，必须一起抵达音频侧。
		const delay = d / L.soundSpeed;
		this._thunder.push({ t0: this.t + delay, near, az });

		return { distance: d, near, delay };
	}

	singlePulse(x) {
		const L = this.cfg.lightning;
		if (x < 0) return 0;
		// 上升很快（放电几乎瞬时），衰减是指数尾（余晖）
		const rise = 1 - Math.exp(-x / L.attack);
		const fall = Math.exp(-x / L.decay);
		return rise * fall;
	}

	update(dt, tension) {
		const L = this.cfg.lightning;
		this.t += dt;

		// 张力越高闪电越密 —— 天气随恐惧恶化。
		const T = Math.min(1, Math.max(0, tension));
		const lo = THREE.MathUtils.lerp(L.intervalCalm[0], L.intervalTense[0], T);
		const hi = THREE.MathUtils.lerp(L.intervalCalm[1], L.intervalTense[1], T);

		this._next -= dt;
		if (this._next <= 0) {
			this._next = lo + Math.random() * (hi - lo);
			this._strike(0.5);
		}

		// 预约到期的闪电
		for (let i = this._pending.length - 1; i >= 0; i--) {
			if (this.t >= this._pending[i].t0) {
				const p = this._pending[i];
				this._pending.splice(i, 1);
				this._strike(THREE.MathUtils.lerp(0.75, 0.15, p.urgency));
			}
		}

		// 把所有活跃脉冲叠起来。用数组求和而不是一个"当前脉冲"状态：
		// 复击的脉冲会**重叠**（间隔 30 ms < 衰减 115 ms），
		// 单状态机会在第二记到来时把第一记的余晖整个丢掉。
		let sum = 0;
		for (let i = this._pulses.length - 1; i >= 0; i--) {
			const p = this._pulses[i];
			const x = this.t - p.t0;
			if (x > 1.4) {
				this._pulses.splice(i, 1);
				continue;
			}
			sum += p.peak * this.singlePulse(x);
		}
		this.flash = Math.min(1.25, sum);
		this.light.intensity = this.flash * L.peak;

		// 雷声到期就交给音频侧。近雷先到（延迟短），远雷后到。
		// 方位角一并交出：延迟回答"多远"，az 回答"哪边"。
		for (let i = this._thunder.length - 1; i >= 0; i--) {
			const th = this._thunder[i];
			if (this.t >= th.t0) {
				this._thunder.splice(i, 1);
				if (this.onThunder) this.onThunder(th.near, th.az);
			}
		}
	}

	// 当前闪电的视觉强度，0–1（给 HUD / 探针用）
	get level() {
		return Math.min(1, this.flash);
	}
}
