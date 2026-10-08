// 输入：指针锁、键盘、鼠标增量，以及"转身累积量"。
//
// 转身累积量是本项目特有的一件事：导演需要知道"玩家是不是正在东张西望"，
// 因为那是他警觉度最低、也最适合让身影显形的时刻。
// 它用指数衰减维持一个滑动窗口，比环形缓冲便宜，且不需要每帧重算。
//
// ─────────────────────────────────────────────────────────────
// 【轴向约定 · 不要随手改成"看起来更顺"的写法】
//
// three.js 相机默认朝 -Z。摄像机的 rotation.y = yaw 时：
//   前方 = (-sin yaw, -cos yaw)，即 yaw 增大 = 向左转。
//
// 而浏览器给的 e.movementX：鼠标右移为正。
// 所以"鼠标右移应该向右转"，要求 yaw 随 dx 递减。
//   → yawDelta = -dx * sens * (invertX ? -1 : 1)
//
// v1 的 bug 就是漏了这个负号：鼠标右移，视线往左偏，整个操作是镜像的。
// 这类错误的隐蔽之处在于"走路看起来是对的"——W 还是朝前，
// 只有转头的时候才会发现方向拧了。
//
// 灵敏度不再写死在这里：它来自 CFG.input.lookSensitivity，
// 并且可以被 Settings 在运行时改写 + 持久化到 localStorage。
// ─────────────────────────────────────────────────────────────

const MOVE_KEYS = new Set([
	'KeyW',
	'KeyA',
	'KeyS',
	'KeyD',
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
]);

export class Input {
	constructor(canvas, cfg) {
		this.canvas = canvas;
		this.cfg = cfg;
		this.keys = new Set();
		this.locked = false;
		this.enabled = true;

		this._dx = 0;
		this._dy = 0;
		this.yawDelta = 0;
		this.turnWindow = 0; // 转身累积量（弧度），指数衰减
		this.onKeyDown = null;
		this.onLockChange = null;

		// 运行时可变：由 Settings 写入
		this.sensitivity = cfg ? cfg.input.lookSensitivity : 0.0012;
		this.invertX = cfg ? cfg.input.invertX : false;
		this.invertY = cfg ? cfg.input.invertY : false;
		// 平滑：鼠标增量按帧合并后直接乘灵敏度，会有"一格一格"的阶梯感。
		// 把一部分增量留到下一帧（指数留尾）能显著改善手感，
		// 代价只有不到一帧的延迟。
		this.smoothing = cfg ? cfg.input.lookSmoothing : 0.35;
		this._carryX = 0;
		this._carryY = 0;

		this._bind();
	}

	_bind() {
		this.canvas.addEventListener('click', () => {
			if (this.enabled && !this.locked) this.canvas.requestPointerLock();
		});

		document.addEventListener('pointerlockchange', () => {
			this.locked = document.pointerLockElement === this.canvas;
			// 解锁时清空累积增量，否则下次锁定时会"甩"一下
			if (!this.locked) {
				this.keys.clear();
				this._dx = 0;
				this._dy = 0;
				this._carryX = 0;
				this._carryY = 0;
			}
			if (this.onLockChange) this.onLockChange(this.locked);
		});

		document.addEventListener('mousemove', (e) => {
			if (!this.locked) return;
			this._dx += e.movementX || 0;
			this._dy += e.movementY || 0;
		});

		window.addEventListener('keydown', (e) => {
			// Space 必须拦：浏览器默认行为是"滚动页面 / 再次激活按钮"，
			// 而它在本作里是跳跃。不拦的话每跳一次页面都会晃一下。
			if (e.code === 'F1' || e.code === 'Tab' || e.code === 'Space') e.preventDefault();
			// Ctrl+S / Ctrl+D / Ctrl+A 必须拦：蹲下是按住 Ctrl 的，
			// 而蹲着的时候手还在 WASD 上 —— 于是"蹲下往前走"会稳定地
			// 触发浏览器的保存页面（Ctrl+S）或收藏（Ctrl+D）弹框，
			// 把正在逃跑的人直接打断。这是蹲下键位最容易被忽略的副作用。
			//
			// 只拦这几个明确有害的组合，**不**拦整个 Ctrl ——
			// 那会废掉 Ctrl+Shift+I 之类用户可能真的需要的快捷键。
			if (
				e.ctrlKey &&
				(e.code === 'KeyS' || e.code === 'KeyD' || e.code === 'KeyA' || e.code === 'KeyW')
			) {
				e.preventDefault();
			}
			if (!this.keys.has(e.code) && this.onKeyDown) this.onKeyDown(e.code);
			this.keys.add(e.code);
		});

		window.addEventListener('keyup', (e) => {
			this.keys.delete(e.code);
		});

		window.addEventListener('blur', () => {
			this.keys.clear();
		});
	}

	has(code) {
		return this.keys.has(code);
	}

	// 取出并清空本帧的鼠标增量。
	// 返回 pitch 用 -dy：鼠标下移为正，而"往下看"是 pitch 减小。
	consumeLook() {
		// 把本帧增量与上一帧留下的尾巴合并
		const raw = this._dx + this._carryX;
		const rawY = this._dy + this._carryY;
		this._dx = 0;
		this._dy = 0;

		// 留尾：留下 smoothing 比例给下一帧
		this._carryX = raw * this.smoothing;
		this._carryY = rawY * this.smoothing;

		const sens = this.sensitivity;
		const sx = this.invertX ? 1 : -1;
		const sy = this.invertY ? 1 : -1;

		this.yawDelta = sx * raw * sens;
		return { yaw: this.yawDelta, pitch: sy * rawY * sens };
	}

	// 每帧推进衰减。窗口时间常数 0.6 s，约等于"最近一秒半的转身总量"。
	tick(dt) {
		this.turnWindow += Math.abs(this.yawDelta);
		this.turnWindow *= Math.exp(-dt / 0.6);
		if (this.turnWindow > 12) this.turnWindow = 12;
	}

	get moving() {
		if (!this.enabled) return false;
		for (const k of MOVE_KEYS) {
			if (this.keys.has(k)) return true;
		}
		return false;
	}

	get running() {
		return this.has('ShiftLeft') || this.has('ShiftRight');
	}

	// 移动姿态。'walk' | 'sneak' | 'crouch'。
	//
	// 【Shift 的两个身份，以及为什么这不矛盾】
	//
	// Shift 在上一版里是"奔跑"。现在它是"静步"。
	//
	// 换个别的键来当静步？问题是左边小指的自然落点只有 Shift 和 Ctrl，
	// 而 Ctrl 已经是蹲下。把奔跑挪到别处（比如按住 W 双击）会毁掉
	// "想跑就按住"这个肌肉记忆 —— 那是最不该动的一种操作。
	//
	// 真正的解决办法是**让 Shift 保持"修饰移动"这一个语义**：
	//   Shift      = 压低（静步）
	//   Shift+W…   = 压低着移动
	// 而"跑"不再需要修饰键 —— 见下面的 `runIntent`：
	// 持续按住前进超过一小段距离，人会自己进入小跑，松开即停。
	// 这在恐怖游戏里是对的：恐惧驱动你加速，而不是你主动去按一个加速键。
	get stance() {
		if (!this.enabled) return 'walk';
		// 蹲下优先于静步：同时按住时取更保守的那个。
		if (this.has('ControlLeft') || this.has('ControlRight')) return 'crouch';
		if (this.running) return 'sneak';
		return 'walk';
	}

	// 是否处于"想跑"的意图。由 controller 结合体力和持续时间判断。
	// 这里只回答"玩家有没有按着方向键"—— 真正的门槛在 controller：
	// 按住前进 1.1 秒后才升格为奔跑（见 CFG.player.runHold）。
	get wantsForward() {
		return this.has('KeyW') || this.has('ArrowUp');
	}

	// 归一化的移动意图（相机局部空间）：x = 右，z = 前
	moveIntent() {
		if (!this.enabled) return { x: 0, z: 0 };
		let x = 0;
		let z = 0;
		if (this.has('KeyW') || this.has('ArrowUp')) z += 1;
		if (this.has('KeyS') || this.has('ArrowDown')) z -= 1;
		if (this.has('KeyD') || this.has('ArrowRight')) x += 1;
		if (this.has('KeyA') || this.has('ArrowLeft')) x -= 1;
		const len = Math.hypot(x, z);
		if (len > 1e-4) {
			x /= len;
			z /= len;
		}
		return { x, z };
	}
}
