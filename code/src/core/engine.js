// 渲染器 + 相机 + 主循环 + 自适应画质。
// 刻意不做后处理链：颗粒/暗角/故障用 DOM 叠加层实现（见 ui/ui.css）。
// 理由：首帧更快、零兼容风险，而且恐怖片里的颗粒本来就是"贴在画面上的"。

import * as THREE from 'three';

export class Engine {
	constructor(canvas, cfg) {
		this.cfg = cfg;

		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			powerPreference: 'high-performance',
			stencil: false,
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.quality.maxPixelRatio));
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.setClearColor(cfg.atmosphere.fogColor, 1);
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		// 曝光来自 CFG.atmosphere —— 它是"画面阴郁程度"里最有效的一格，
		// 所以必须和天空/雾色一起放在同一张表里调，不能散落在代码里。
		this.renderer.toneMappingExposure = cfg.atmosphere ? cfg.atmosphere.exposure : 1.02;
		this.renderer.shadowMap.enabled = true;
		// r186 起不再有 PCFSoftShadowMap，PCF 在这个雾度下差别看不出来
		this.renderer.shadowMap.type = THREE.PCFShadowMap;

		this.scene = new THREE.Scene();
		this.scene.fog = new THREE.FogExp2(cfg.atmosphere.fogColor, cfg.atmosphere.fogMin);

		this.camera = new THREE.PerspectiveCamera(
			cfg.player.fov,
			window.innerWidth / window.innerHeight,
			0.08,
			520,
		);
		this.camera.rotation.order = 'YXZ';

		// 不用 THREE.Clock（r186 起已废弃）。自己算 delta，简单且无告警
		this._last = 0;
		this.updaters = [];
		this.downgrades = [];
		this.running = false;
		this.elapsed = 0;
		this.fps = 60;

		this._frameMs = 0;
		this._slowCount = 0;
		this._qualityStep = 0;
		this._statAcc = 0;
		this._statFrames = 0;

		this._onResize = this._onResize.bind(this);
		window.addEventListener('resize', this._onResize);
	}

	_onResize() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
	}

	onUpdate(fn) {
		this.updaters.push(fn);
	}

	// 每帧最早触发的钩子，拿真实的帧间隔（未经 dt 夹取）。
	// 诊断用：见 main.js 的 ftFrame。
	onFrameGap(fn) {
		this.onFrameGap = fn;
	}

	// 注册"降画质"钩子。按帧时间排序，慢帧累计到阈值就依次调用。
	onDowngrade(fn) {
		this.downgrades.push(fn);
	}

	start() {
		if (this.running) return;
		this.running = true;
		this._last = performance.now();
		this._loop();
	}

	stop() {
		this.running = false;
	}

	_loop() {
		if (!this.running) return;
		requestAnimationFrame(() => this._loop());

		// 帧间隔钩子。必须在取 now **之前**调用：它自己读一次
		// performance.now() 来算相邻帧的间隔。放在这里而不是 updaters 里，
		// 是因为 updaters 拿到的是**被夹住的 dt**（max 0.05 s）——
		// 夹住的 dt 会把 400 ms 的长帧显示成 50 ms，正是要抓的东西被抹掉。
		if (this.onFrameGap) this.onFrameGap();

		const now = performance.now();
		// 标签页切回来时 dt 会很大，必须夹住，否则所有基于 dt 的推进都会瞬移
		const dt = Math.min((now - this._last) / 1000, 0.05);
		this._last = now;
		this.elapsed += dt;

		for (let i = 0; i < this.updaters.length; i++) {
			this.updaters[i](dt, this.elapsed);
		}

		this.renderer.render(this.scene, this.camera);

		const ms = performance.now() - now;
		this._frameMs = this._frameMs * 0.9 + ms * 0.1;
		this._statFrames++;
		this._statAcc += dt;
		if (this._statAcc >= 0.5) {
			this.fps = this._statFrames / this._statAcc;
			this._statAcc = 0;
			this._statFrames = 0;
			this._checkQuality();
		}
	}

	_checkQuality() {
		if (this._frameMs > this.cfg.quality.slowFrameMs) {
			this._slowCount++;
		} else {
			this._slowCount = Math.max(0, this._slowCount - 2);
		}
		if (this._slowCount >= 8 && this._qualityStep < this.downgrades.length) {
			const fn = this.downgrades[this._qualityStep++];
			fn();
			this._slowCount = 0;
		}
	}

	get frameMs() {
		return this._frameMs;
	}

	get qualityStep() {
		return this._qualityStep;
	}
}
