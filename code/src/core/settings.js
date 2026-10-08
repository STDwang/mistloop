// 运行时设置：视角手感 + 画质。
//
// 设计取舍：为什么不做成"设置菜单"，而是塞进 F1 那张操作表？
//
// 因为 docs/DESIGN.md 有一条铁律：屏幕上只允许有一个数字（距离）。
// 一个独立的设置面板会立刻把游戏降格成"软件"。
// 把滑块藏进 F1 的说明页，玩家需要时找得到，不需要时永远看不见。
//
// 持久化用 localStorage。键名带版本号 —— 以后改结构时
// 老数据会被自然丢弃，而不是让玩家卡在一个坏掉的配置上。

const STORE_KEY = 'mistloop.settings.v1';

// 视角灵敏度的取值范围。中位数落在 config.js 给自己的默认值附近，
// 但允许玩家往上开到 4 倍（有人就是喜欢甩枪式的转头）。
export const SENS_MIN = 0.0004;
export const SENS_MAX = 0.005;

export class Settings {
	constructor(cfg) {
		this.cfg = cfg;
		this.values = {
			lookSensitivity: cfg.input.lookSensitivity,
			invertX: cfg.input.invertX,
			invertY: cfg.input.invertY,
			lookSmoothing: cfg.input.lookSmoothing,
			bobAmount: cfg.input.bobAmount,
			// 视角偏好（'first' | 'third'）。F 键切换时写入。
			// 存字符串而不是布尔，是给将来可能出现的第三种机位留路。
			viewMode: 'first',
		};
		this._load();
		this._listeners = [];
	}

	onChange(fn) {
		this._listeners.push(fn);
		fn(this.values);
	}

	_load() {
		try {
			const raw = localStorage.getItem(STORE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw);
			if (!data || typeof data !== 'object') return;
			for (const k of Object.keys(this.values)) {
				if (!(k in data)) continue;
				// 类型必须与默认值一致，否则视为脏数据丢弃。
				// 手改过 localStorage 也不能把游戏弄坏 —— 下面的 clamp 是第二道保险。
				if (typeof data[k] !== typeof this.values[k]) continue;
				if (typeof data[k] === 'boolean') this.values[k] = !!data[k];
				else if (Number.isFinite(data[k])) this.values[k] = data[k];
				// 字符串值（viewMode）：非法取值不影响安全 —— 使用方
				// （player.setViewMode）会校验，不认识就当默认值处理。
				else if (typeof data[k] === 'string') this.values[k] = data[k];
			}
			this.values.lookSensitivity = clamp(this.values.lookSensitivity, SENS_MIN, SENS_MAX);
			this.values.lookSmoothing = clamp(this.values.lookSmoothing, 0, 0.7);
			this.values.bobAmount = clamp(this.values.bobAmount, 0, 1.6);
		} catch {
			// localStorage 被禁用（隐私模式）就静默用默认值，不影响游戏
		}
	}

	_save() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(this.values));
		} catch {
			/* 存不下就算了，本次会话仍然生效 */
		}
	}

	set(key, value) {
		if (!(key in this.values)) return;
		this.values[key] = value;
		this._save();
		for (const fn of this._listeners) fn(this.values);
	}

	// 把设置应用到一个 input 实例上
	applyTo(input) {
		input.sensitivity = this.values.lookSensitivity;
		input.invertX = this.values.invertX;
		input.invertY = this.values.invertY;
		input.smoothing = this.values.lookSmoothing;
	}

	reset() {
		this.values.lookSensitivity = this.cfg.input.lookSensitivity;
		this.values.invertX = this.cfg.input.invertX;
		this.values.invertY = this.cfg.input.invertY;
		this.values.lookSmoothing = this.cfg.input.lookSmoothing;
		this.values.bobAmount = this.cfg.input.bobAmount;
		this.values.viewMode = 'first';
		this._save();
		for (const fn of this._listeners) fn(this.values);
	}
}

function clamp(v, a, b) {
	return Math.max(a, Math.min(b, v));
}
