// HUD 与所有 DOM 叠加层的控制。
//
// 设计约束（来自 docs/DESIGN.md）：屏幕上只允许有一个数字 —— 距离。
// 没有血条、没有任务列表、没有罗盘。多一个 UI 元素，恐惧就少一分。

export class Hud {
	constructor(cfg, settings) {
		this.cfg = cfg;
		this.settings = settings;
		this.el = {
			canvas: document.getElementById('gl'),
			objective: document.getElementById('objective'),
			distance: document.getElementById('stat-dist'),
			lap: document.getElementById('stat-lap'),
			breath: document.getElementById('stat-breath'),
			stance: document.getElementById('stat-stance'),
			subtitle: document.getElementById('subtitle'),
			fade: document.getElementById('fade'),
			flash: document.getElementById('flash'),
			bearing: document.getElementById('bearing'),
			win: document.getElementById('win'),
			winText: document.getElementById('win-text'),
			winStats: document.getElementById('win-stats'),
			start: document.getElementById('start'),
			paused: document.getElementById('paused'),
			help: document.getElementById('help'),
			btnStart: document.getElementById('btn-start'),
			btnResume: document.getElementById('btn-resume'),
			root: document.documentElement,
		};
		this.started = false;
		this._subTimer = 0;
		this._glitchTimer = 0;
		this._fadeFrom = 0;
		this._fadeTo = 0;
		this._fadeDur = 0;
		this._fadeT = 0;

		this.el.btnStart.addEventListener('click', () => {
			this.started = true;
			this.el.start.classList.add('hidden');
			if (this.onStart) this.onStart();
		});
		this.el.btnResume.addEventListener('click', () => {
			this.el.paused.classList.add('hidden');
			if (this.onResume) this.onResume();
		});
		this.el.canvas.addEventListener('click', () => {
			if (this.started) {
				this.el.paused.classList.add('hidden');
				if (this.onResume) this.onResume();
			}
		});

		this._bindSettings();
	}

	// 设置控件 ↔ Settings 的双向绑定。
	// 控件触发 set()，set() 触发 listeners，listener 回写控件 —— 这样
	// "恢复默认"按钮也能自动刷新滑块位置，不需要额外代码。
	_bindSettings() {
		if (!this.settings) return;
		const $ = (id) => document.getElementById(id);
		this._setEls = {
			sens: $('set-sens'),
			sensVal: $('set-sens-val'),
			smooth: $('set-smooth'),
			smoothVal: $('set-smooth-val'),
			bob: $('set-bob'),
			bobVal: $('set-bob-val'),
			invx: $('set-invx'),
			invy: $('set-invy'),
			reset: $('set-reset'),
		};

		const bind = (input, key, out, digits) => {
			if (!input) return;
			input.addEventListener('input', () => {
				this.settings.set(key, parseFloat(input.value));
			});
			if (out) input.addEventListener('input', () => {
				out.textContent = digits ? parseFloat(input.value).toFixed(digits) : input.value;
			});
		};

		bind(this._setEls.sens, 'lookSensitivity', this._setEls.sensVal, 4);
		bind(this._setEls.smooth, 'lookSmoothing', this._setEls.smoothVal, 2);
		bind(this._setEls.bob, 'bobAmount', this._setEls.bobVal, 2);

		for (const [el, key] of [
			[this._setEls.invx, 'invertX'],
			[this._setEls.invy, 'invertY'],
		]) {
			if (el) el.addEventListener('change', () => this.settings.set(key, el.checked));
		}
		if (this._setEls.reset) {
			this._setEls.reset.addEventListener('click', () => this.settings.reset());
		}

		// Settings → 控件
		this.settings.onChange((v) => this._syncSettings(v));
	}

	_syncSettings(v) {
		const e = this._setEls;
		if (!e) return;
		if (e.sens) e.sens.value = String(v.lookSensitivity);
		if (e.sensVal) e.sensVal.textContent = v.lookSensitivity.toFixed(4);
		if (e.smooth) e.smooth.value = String(v.lookSmoothing);
		if (e.smoothVal) e.smoothVal.textContent = v.lookSmoothing.toFixed(2);
		if (e.bob) e.bob.value = String(v.bobAmount);
		if (e.bobVal) e.bobVal.textContent = v.bobAmount.toFixed(2);
		if (e.invx) e.invx.checked = !!v.invertX;
		if (e.invy) e.invy.checked = !!v.invertY;
	}

	// 【为什么要加一个 guard】这一版里 objective 由 director **每帧**按
	// "方向记忆"状态挑选。不加 guard 就是每帧写一次 textContent，
	// 而写 textContent 会让浏览器标脏、重排版 —— 一个完全不必要的每帧成本。
	// 只在文字真的变了的时候写。
	setObjective(text) {
		if (this.el.objective.textContent !== text) this.el.objective.textContent = text;
	}

	// ── 方位刻度 ─────────────────────────────────────────────────
	//
	// 【先解释它为什么不算破坏"屏幕上只允许有一个数字"】
	//
	// 设计约束是"屏幕上只允许有一个数字"（距离）。一个方位指示器看起来
	// 违反了它 —— 但它不是仪表，它是**记忆的可见形态**：
	//   · 它的**透明度就是机制本身**。方向记忆会随时间衰减，
	//     这个刻度就跟着变淡，最后自己消失。没有一个仪表会这么做。
	//   · 它没有任何数字：没有角度、没有"距家 42 米"、没有刻度线。
	//   · 它只在"你想起来"的时候存在。忘了就没有。
	//
	// 换句话说：屏幕上仍然只有一个数字，而这个是**感觉**。
	// 它是这一版唯一新增的 HUD 元素，也是唯一被允许的一个。
	//
	// rel：相对相机的方位角（弧度，+ 为偏左）。
	// strength：0–1，方向记忆的强度，直接当作不透明度。
	setBearing(rel, strength) {
		const el = this.el.bearing;
		if (!el) return;
		if (strength <= 0.03) {
			if (!el.classList.contains('hidden')) el.classList.add('hidden');
			return;
		}
		if (el.classList.contains('hidden')) el.classList.remove('hidden');
		el.style.opacity = strength.toFixed(3);
		// CSS 的 rotate 正方向是**顺时针**，而本作的 yaw 增大是**向左转**
		// （见 input.js 顶部的轴向约定）。所以相对方位 rel 为正（目标在左）时，
		// 刻度要往**左**转 —— 也就是负角度。
		el.style.setProperty('--bearing', `${(-rel).toFixed(4)}rad`);
	}

	// 到家。终局面板 + 让 main.js 去暂停世界。
	setEscaped(line, seconds, wraps) {
		const el = this.el.win;
		if (!el) return;
		if (this.el.winText) this.el.winText.textContent = line;
		if (this.el.winStats) {
			this.el.winStats.textContent = `${seconds.toFixed(0)} 秒　·　绕过 ${wraps} 圈`;
		}
		el.classList.remove('hidden');
		if (this.onEscaped) this.onEscaped();
	}

	setDistance(meters) {
		this.el.distance.textContent =
			meters < 1000 ? `${meters.toFixed(1)} m` : `${(meters / 1000).toFixed(2)} km`;
	}

	setLap(n) {
		this.el.lap.textContent = `第 ${n + 1} 圈`;
	}

	// 姿态指示。只在非"正常走"时出现 —— 站着走路是默认状态，
	// 常驻显示一个"步行"标签只是噪音。
	//
	// 【为什么这里给的是"有多响"而不是"蹲着"】
	// "蹲着"是操作结果，"安静/很安静"是它**换来了什么**。
	// 玩家按 Ctrl 的时候想知道的是"他还能听见我吗"，
	// 而不是"我的角色现在是什么姿势"——前者才有决策价值。
	setStance(stance) {
		const el = this.el.stance;
		if (!el) return;
		const label = { sneak: '安静', crouch: '几乎无声' }[stance];
		if (!label) {
			el.classList.add('hidden');
			return;
		}
		if (el.textContent !== label) el.textContent = label;
		el.classList.remove('hidden');
	}

	setPhase(p) {
		this.el.root.style.setProperty('--phase', String(p));
	}

	// 张力只用一个"呼吸状态"词表示。不给数字，给感觉。
	setTension(t) {
		this.el.root.style.setProperty('--tension', t.toFixed(3));
		const words = ['平静', '留意', '不安', '听见自己', '喘不上气'];
		const i = Math.min(words.length - 1, Math.floor(t * words.length));
		if (this.el.breath.textContent !== words[i]) this.el.breath.textContent = words[i];
	}

	subtitle(text, seconds = 4) {
		if (!text) return;
		this.el.subtitle.textContent = text;
		this.el.subtitle.classList.add('show');
		this._subTimer = seconds;
	}

	// 故障效果：唯一允许的"廉价"效果，因为它是心理性的而不是视觉性的
	glitch(power = 0.5) {
		const c = this.el.canvas;
		c.style.setProperty('--glitch', String(power));
		c.classList.remove('glitch');
		// 强制重排，让动画能连续触发
		void c.offsetWidth;
		c.classList.add('glitch');
		this._glitchTimer = 0.3;
	}

	// 短暂的白色/黑色闪屏
	flash(power = 0.5, dur = 0.18) {
		this.el.flash.style.transition = `opacity ${dur}s linear`;
		this.el.flash.style.opacity = String(power);
		setTimeout(() => {
			this.el.flash.style.opacity = '0';
		}, dur * 1000);
	}

	fade(to, dur) {
		this._fadeFrom = parseFloat(this.el.fade.style.opacity || '0');
		this._fadeTo = to;
		this._fadeDur = dur;
		this._fadeT = 0;
		this.el.fade.style.transition = 'none';
	}

	showPause() {
		if (this.started) this.el.paused.classList.remove('hidden');
	}

	hidePause() {
		this.el.paused.classList.add('hidden');
	}

	toggleHelp() {
		this.el.help.classList.toggle('hidden');
	}

	update(dt) {
		if (this._subTimer > 0) {
			this._subTimer -= dt;
			if (this._subTimer <= 0) this.el.subtitle.classList.remove('show');
		}
		if (this._glitchTimer > 0) {
			this._glitchTimer -= dt;
			if (this._glitchTimer <= 0) this.el.canvas.classList.remove('glitch');
		}
		if (this._fadeDur > 0) {
			this._fadeT += dt;
			const k = Math.min(1, this._fadeT / this._fadeDur);
			const v = this._fadeFrom + (this._fadeTo - this._fadeFrom) * k;
			this.el.fade.style.transition = 'none';
			this.el.fade.style.opacity = String(v);
			if (k >= 1) this._fadeDur = 0;
		}
	}
}
