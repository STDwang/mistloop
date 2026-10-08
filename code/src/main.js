// 启动装配：引擎 → 世界 → 玩家 → 导演 → 循环。
//
// 这个文件只做"接线"，不含任何玩法逻辑。
// 如果你发现自己在 main.js 里写 if (玩家做了X)，那就是放错地方了。

import * as THREE from 'three';
import { CFG } from './config.js';
import { bakePathField, pathInfluence } from './core/noise.js';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { Settings } from './core/settings.js';
import { createTerrain, snapTerrain } from './world/terrain.js';
import { Forest } from './world/forest.js';
import { Undergrowth } from './world/undergrowth.js';
import { Atmosphere } from './world/props.js';
import { Landmark } from './world/landmark.js';
import { Lightning } from './world/lightning.js';
import { Safehouse } from './world/safehouse.js';
import { Stalker } from './entities/stalker.js';
import { Player } from './player/controller.js';
import { Avatar } from './player/avatar.js';
import { Flashlight } from './player/flashlight.js';
import { AudioEngine } from './audio/audio.js';
import { Director } from './game/director.js';
import { Hud } from './ui/hud.js';

const canvas = document.getElementById('gl');
const engine = new Engine(canvas, CFG);
const settings = new Settings(CFG);
const input = new Input(canvas, CFG);
settings.applyTo(input);
const hud = new Hud(CFG, settings);
const audio = new AudioEngine(CFG);

// ── 天空：一块跟着相机走的渐变球。阴天，没有太阳。 ────────────────
function createSky(cfg) {
	const R = 420;
	const geo = new THREE.SphereGeometry(R, 28, 18);
	const pos = geo.attributes.position;
	const colors = new Float32Array(pos.count * 3);
	const top = new THREE.Color(cfg.atmosphere.skyTop);
	const bottom = new THREE.Color(cfg.atmosphere.skyBottom);
	const c = new THREE.Color();
	for (let i = 0; i < pos.count; i++) {
		const h = pos.getY(i) / R;
		// 地平线附近必须正好是雾色，否则会看见一条接缝
		const k = Math.pow(Math.max(0, h), 0.5);
		c.copy(bottom).lerp(top, k);
		colors[i * 3] = c.r;
		colors[i * 3 + 1] = c.g;
		colors[i * 3 + 2] = c.b;
	}
	geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	const mat = new THREE.MeshBasicMaterial({
		vertexColors: true,
		side: THREE.BackSide,
		fog: false,
		depthWrite: false,
		toneMapped: false,
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.renderOrder = -1;
	mesh.frustumCulled = false;
	return mesh;
}

const sky = createSky(CFG);
engine.scene.add(sky);
// 背景色用同一个 Color 实例，闪电时才可能一起被提亮 ——
// 每次 new 一个新对象的话，帧循环里就改不到它了。
engine.scene.background = new THREE.Color(CFG.atmosphere.fogColor);
// 闪电的"配套提亮"用的基准色与目标色。雾必须被点亮，
// 否则远处的树会像贴纸一样浮在一层没变的雾上（见 lightning.js 顶部注释）。
const FOG_BASE = new THREE.Color(CFG.atmosphere.fogColor);
const FOG_FLASH = new THREE.Color(0xc9d6e4);
const SKY_BASE = new THREE.Color(1, 1, 1);
const SKY_FLASH = new THREE.Color(0xdce6f4);

// ── 光照：没有太阳。只有阴天的漫射 + 手电。 ──────────────────────
const hemi = new THREE.HemisphereLight(
	CFG.atmosphere.hemiSky,
	CFG.atmosphere.hemiGround,
	CFG.atmosphere.hemiIntensity,
);
engine.scene.add(hemi);

// 一盏很弱的方向光，只为让物体有体积感，不投影
const overcast = new THREE.DirectionalLight(0x8e9a92, CFG.atmosphere.overcast);
overcast.position.set(0.35, 1, 0.28).multiplyScalar(60);
engine.scene.add(overcast);

// ── 世界 ────────────────────────────────────────────────────────
// 先烘路。地形 11.6 万顶点、树、草全都要查"离路多远"，
// 不先烘焙的话每次查询都是几百次三角函数 —— 首帧会卡死几秒。
const bakeMs = bakePathField(CFG);
console.log(`[路] 距离场烘焙完成：${bakeMs.toFixed(0)} ms`);

const terrain = createTerrain(CFG);
engine.scene.add(terrain);

const forest = new Forest(CFG, engine.scene);
const undergrowth = new Undergrowth(CFG, engine.scene);
const atmosphere = new Atmosphere(CFG, engine.scene);
const landmark = new Landmark(CFG, engine.scene);
const lightning = new Lightning(CFG, engine.scene);
const safehouse = new Safehouse(CFG, engine.scene);

// ── 玩家 / 实体 ─────────────────────────────────────────────────
const player = new Player(CFG, input, forest, engine.camera);
const flashlight = new Flashlight(CFG, engine.camera);
engine.scene.add(engine.camera);
const avatar = new Avatar(CFG, engine.scene);
const stalker = new Stalker(CFG, engine.scene);

// 设置改动要即时反映到手感上：灵敏度 / 反转直接改 input 实例；
// 头部摆动是玩家侧的量，写进 player，由 controller 每帧读取。
// 必须放在 player 创建之后 —— settings.onChange 会立刻回调一次。
settings.onChange((v) => {
	settings.applyTo(input);
	player.bobAmount = v.bobAmount;
});

// ── 导演 ────────────────────────────────────────────────────────
const director = new Director({
	cfg: CFG,
	player,
	input,
	stalker,
	audio,
	hud,
	landmark,
	atmosphere,
	forest,
	undergrowth,
	camera: engine.camera,
	// 这一版新增的三个：定身判定要真实光束、显形可见度要闪电、目标要安全屋。
	flashlight,
	lightning,
	safehouse,
});

// 雷声：闪电负责"什么时候"和"从哪边来"，音频负责"听起来是什么"。
// 两者之间只有这一个接口，传两个数：near（音色：近雷脆、远雷闷）与
// az（世界方位角）。延迟已经由 lightning 算完了（距离 / 343 m/s），
// 音频不需要知道任何关于距离的事 —— 它只需要知道 pan。
//
// 【pan 的几何】雷在 380 m 之外，方向可以当作纯水平方位：
// 雷的方向 = (sin az, cos az)；玩家前方 = (-sin yaw, -cos yaw)，
// 右方 = (cos yaw, -sin yaw)。雷的方向点乘右方 = sin(az - yaw)，
// 正 = 雷在右边。StereoPanner 的 +1 恰好也是右耳。
//
// 【Number.isFinite 的防御不是多余的】storm-probe 会以 onThunder(near)
// 单参数回调这里（它只关心延迟，不关心声像）—— 没有这道防线，
// sin(undefined - yaw) = NaN 会被写进声像参数，整个雷声链炸掉。
lightning.onThunder = (near, az) => {
	const pan = Number.isFinite(az) ? Math.sin(az - player.yaw) : 0;
	audio.oneShot('thunder', near, 'floor', pan);
};

// ── 声音事件接线 ────────────────────────────────────────────────
// 地表判定：路上（pathInfluence→1）是压实的土，路外是枯叶层。
// 两种地表的脚步合成完全不同（见 audio.js footstep 注释）——
// 这是"走动时和环境有交互"的声音面。
const stepSurface = (x, z) => (pathInfluence(x, z, CFG) > 0.5 ? 'road' : 'floor');

player.onStep = (power) => {
	audio.oneShot('footstep', power, stepSurface(player.pos.x, player.pos.z));
	// 偶尔踩断枯枝：让脚步不是单调循环
	if (Math.random() < 0.08) audio.oneShot('snap', power);
};

// 落地。音量与**落差**成正比，不是固定值 —— 这个比例关系就是"真实"的来源。
// 平地上无聊地蹦一下应该几乎听不见；从路槽边摔到林地里必须听得见。
player.onLand = (fallHeight) => {
	const P = CFG.player;
	// 归一化：以 1.2 m 为"满力"参考。跳跃最高点约 1.08 m，所以
	// 平地起跳落地大约落在 0.9 —— 响亮但不满。
	const norm = Math.min(1, fallHeight / 1.2);
	const ref = Math.max(P.fallSoftHeight, 1.2);
	if (fallHeight < P.fallSoftHeight * 0.5) return; // 小到不值得出声
	const power = Math.min(P.landPowerMax, 0.45 + 0.95 * (fallHeight / ref));
	audio.oneShot('footstep', power, stepSurface(player.pos.x, player.pos.z));
	// 落得够狠才踩断枯枝。概率本身也随高度上升，所以"跳得高"和"响"是同一件事。
	if (fallHeight > P.fallSoftHeight && Math.random() < P.landTwigChance * norm) {
		audio.oneShot('snap', power * 0.9);
	}
	// 落叶层：踩进枯叶堆的沙沙。它与枯枝是两种不同的失败方式 ——
	// 枯枝是"脆响"，落叶是"闷沙"，玩家不需要知道区别，但耳朵会知道。
	if (Math.random() < 0.3) audio.oneShot('rustle', power * 0.55);
};

// ── 暂停 / 指针锁 ───────────────────────────────────────────────
let paused = true;
let helpVisible = false;

hud.onStart = () => {
	audio.init();
	paused = false;
	canvas.requestPointerLock();
};
hud.onResume = () => {
	paused = false;
	canvas.requestPointerLock();
};
input.onLockChange = (locked) => {
	// 【为什么必须排掉 escaped】
	// 到家时我们会主动 exitPointerLock()，而那会触发这条回调 ——
	// 结果就是"你停下了"的暂停面板盖在结局面板上。
	// 锁定丢失是"玩家按了 Esc"，不是"玩家走到了终点"。
	// 这两件事在状态上都会表现为 locked=false，所以必须用 escaped 区分。
	if (director.escaped) return;
	if (!locked && hud.started) {
		paused = true;
		hud.showPause();
	} else if (locked) {
		paused = false;
		hud.hidePause();
	}
};
input.onKeyDown = (code) => {
	if (code === 'Space') {
		player.jump();
	} else if (code === 'KeyE') {
		// E = 手电。原 F 键位让位给视角切换 —— E 在左手食指的自然落点上，
		// 高频操作（开灯）应该比低频操作（换机位）更顺手。
		const on = flashlight.toggle();
		hud.subtitle(on ? '' : '你关掉了灯。', 2);
	} else if (code === 'KeyF') {
		// F = 第一/第三人称切换。真正的行为在 player.setViewMode 里，
		// 视觉后果（化身显隐、手电换挂点）由 onViewMode 回调完成。
		player.toggleView();
	} else if (code === 'F1') {
		helpVisible = !helpVisible;
		hud.toggleHelp();
	}
};

// ── 视角切换的视觉后果 ─────────────────────────────────────────
// 化身只在第三人称可见（第一人称里半截身体会糊在相机脸上）；
// 手电装具从相机换挂到化身头上 —— 光必须从"他的手"出发，
// 挂在相机上会让光从你脑后照过去，影子方向当场穿帮。
player.onViewMode = (mode) => {
	const third = mode === 'third';
	avatar.setVisible(third);
	flashlight.mountTo(third ? avatar.head : engine.camera);
	settings.set('viewMode', mode);
	hud.subtitle(third ? '第三人称。你看得到他了，他也看得到雾。' : '第一人称。', 2.2);
};

// 上次会话的视角偏好：setViewMode 对相同模式是 no-op，
// 所以默认第一人称的启动路径在这里什么都不做。
player.setViewMode(settings.values.viewMode === 'third' ? 'third' : 'first');

// ── 姿态切换的反馈 ──────────────────────────────────────────────
// HUD 上给一个"安静 / 几乎无声"的标签。
//
// 【为什么不弹字幕】
// 蹲下是高频操作（每次靠近点击都可能用），弹字幕会刷屏。
// 但也没有完全静默 —— 蹲下时耳朵听到的**变化本身**是最主要的反馈：
// 脚步变轻、环境声相对变响、你自己的呼吸声会盖过一切。
// HUD 那两个字只是给"我刚才那下按到了吗"一个确认。
player.onStance = (stance) => {
	hud.setStance(stance);
};
hud.setStance(player.stance);

// ── 初始状态 ────────────────────────────────────────────────────
forest.refresh(player.pos.x, player.pos.z, true);
undergrowth.refresh(player.pos.x, player.pos.z, true);
atmosphere.update(0, player.pos.x, player.pos.y, player.pos.z);
snapTerrain(terrain, player.pos.x, player.pos.z, CFG);
engine.scene.fog.density = CFG.atmosphere.fogMin;
hud.setLap(0);
hud.setPhase(0);

// ── 自适应画质 ──────────────────────────────────────────────────
engine.onDowngrade(() => {
	forest.reduceRadius(0.84);
	undergrowth.reduceRadius(0.72);
});
engine.onDowngrade(() => atmosphere.reduceQuality(1));
engine.onDowngrade(() => flashlight.reduceQuality());
engine.onDowngrade(() => engine.renderer.setPixelRatio(CFG.quality.minPixelRatio));
engine.onDowngrade(() => atmosphere.reduceQuality(2));

// ── 主循环 ──────────────────────────────────────────────────────
let statTimer = 0;

engine.onUpdate((dt, elapsed) => {
	hud.update(dt);

	if (!paused) {
		player.update(dt);
		input.tick(dt);
		director.update(dt, elapsed);

		forest.refresh(player.pos.x, player.pos.z);
		undergrowth.refresh(player.pos.x, player.pos.z);

		stalker.update(dt);
		avatar.update(dt, player);
		flashlight.update(dt, director.tension);
		audio.update(dt);
	}

	// 到家 = 世界停下。放在 `if (!paused)` 之外，因为这件事本身就是
	// 从"还在跑"变成"停下"的那一次转换，必须能在暂停检查之后立刻生效。
	if (director.escaped && !paused) {
		paused = true;
		input.enabled = false;
		if (document.pointerLockElement) document.exitPointerLock();
	}

	// 这几样必须在暂停时也更新：否则暂停画面里的雾会僵住，很出戏
	snapTerrain(terrain, player.pos.x, player.pos.z, CFG);
	atmosphere.update(paused ? 0 : dt, player.pos.x, player.pos.y, player.pos.z);
	engine.scene.fog.density += (director.fogDensity - engine.scene.fog.density) * Math.min(1, dt * 0.8);
	sky.position.copy(engine.camera.position);

	// ── 闪电的视觉后果 ──────────────────────────────────────────
	//
	// 【为什么必须同时做这四件事】
	// 闪电不是"给场景加一盏灯"，它是**整个山谷的空气被点亮了**。
	// 少做任何一样，那个体积感就会塌掉：
	//   · 只抬方向光 → 树亮了、雾没亮，远处的树像贴纸浮在没变的雾上
	//   · 只抬雾     → 整个画面像蒙了层白纱，完全没有方向感
	//   · 只抬天空   → 地面还是黑的，闪电像发生在另一个世界
	//   · 不抬环境光 → 背光面死黑，读不出"光从上面来"
	// 这也正是它和"全屏白闪"的根本区别：这四样抬起来的时候，
	// 森林的**每一个明暗关系**都真的变了，而不只是屏幕变亮了。
	const fl = Math.min(1.25, lightning.flash);
	const L = CFG.lightning;
	engine.scene.fog.color.copy(FOG_BASE).lerp(FOG_FLASH, Math.min(1, fl * L.fogBoost));
	engine.scene.background.copy(engine.scene.fog.color);
	// 天空：先往冷白偏，再整体过曝。闪电把云层打透的那个白是**过曝**，
	// 不是"颜色变亮"，所以额外乘一个大于 1 的系数让它真的溢出。
	sky.material.color.copy(SKY_BASE).lerp(SKY_FLASH, Math.min(1, fl * L.skyBoost * 0.5));
	sky.material.color.multiplyScalar(1 + fl * L.skyBoost * 0.42);

	// 阶段越高，环境光越弱（阴天进一步压暗）。闪电在这条基线上叠加 ——
	// 注意是**乘**在 dark 之后：闪电是加在天上的光，
	// 不该被"阴天有多暗"这个描述地面状况的系数稀释。
	const dark = 1 - Math.min(0.42, director.phase * 0.1 + director.weather * 0.12);
	hemi.intensity = CFG.atmosphere.hemiIntensity * dark * (1 + fl * L.hemiBoost);
	overcast.intensity = CFG.atmosphere.overcast * dark * (1 + fl * L.hemiBoost * 0.8);

	if (director.debug) {
		statTimer += dt;
		if (statTimer > 2) {
			statTimer = 0;
			console.log(
				`fps=${engine.fps.toFixed(0)} frame=${engine.frameMs.toFixed(1)}ms ` +
					`trees=${forest.types[0].count + forest.types[1].count} canopy=${forest.canopy.count} ` +
					`plants=${undergrowth.count} ` +
					`tension=${director.tension.toFixed(2)} dread=${director.dread.toFixed(2)} ` +
					`state=${director.state} laps=${director.wraps} q=${engine.qualityStep}`,
			);
		}
	}
});

// ── 帧耗时监测：抓"走着走着忽然顿一下" ────────────────────────
// 【为什么需要它】顿挫是最难回报的一类 bug：玩家只说"卡了一下"，
// 而所有性能指标都是平均值 —— 60 帧里 59 帧 4 ms、1 帧 400 ms，
// 平均只有 10.6 ms，看起来完全健康。
//
// 嫌疑最大的两个：① 林分 LOD 换批（树网格重建）② 音频一次性音效的
// 节点图分配（crack 每 16–75 s 一次，与"忽然"的时间尺度吻合）。
//
// 用 rAF 计帧间隔而不是 engine.fps：engine 的 fps 是滑动平均，
// 恰好会把孤立的长帧抹平 —— 那正是我们唯一关心的事件。
// p99 用 120 帧窗口（约 2 s），滞回阈 34 ms（低于 30fps 的界线）。
let ftTotal = 0;
const ft = {
	last: performance.now(),
	buf: new Float32Array(120),
	i: 0,
	n: 0,
	worst: 0,
	spikeT: 0,
	list: [],
	on: /(\?|&)ft(=|&|$)/.test(location.search),
};
function ftFrame() {
	const now = performance.now();
	const d = now - ft.last;
	ft.last = now;
	ft.buf[ft.i] = d;
	ft.i = (ft.i + 1) % ft.buf.length;
	ft.n = Math.min(ft.buf.length, ft.n + 1);
	if (d > ft.worst) ft.worst = d;

	// 帧间隔 >34 ms 就记一笔。冷却 0.5 s，避免卡顿连拍时把日志刷爆。
	if (d > 34 && now - ft.spikeT > 500 && !paused) {
		ft.spikeT = now;
		const s = {
			ms: d,
			t: ftTotal,
			dist: director.distance,
			tension: director.tension,
			state: director.state,
			strain: director.audio.strain ? director.audio.strain() : -1,
			audioNodes: director.audio.nodeCount ? director.audio.nodeCount() : -1,
			phase: director.phase,
			q: engine.qualityStep,
			pending: !!director.pending,
		};
		ft.list.push(s);
		if (ft.list.length > 12) ft.list.shift();
		// 【为什么连往哪转都记】转向换批是 LOD 类卡顿的典型成因：
		// 转头时视野里树的数量突变 → 实例网格重建 → 一帧变长。
		// 只记"卡了多久"分不清它和"走了多远"引起的卡顿。
		console.log(
			`[顿挫] ${d.toFixed(0)}ms  @${ftTotal.toFixed(1)}s  ` +
				`走${s.dist.toFixed(0)}m 阶段${s.phase} ` +
				`张力${s.tension.toFixed(2)} 态=${s.state} ` +
				`音效应变${s.strain} 音频节点${s.audioNodes} q${s.q}`,
		);
	}
	ftTotal += d / 1000;
}
function ftP99() {
	if (!ft.n) return 0;
	const a = Array.from(ft.buf.slice(0, ft.n)).sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.floor(a.length * 0.99))];
}
engine.onFrameGap(ftFrame);

// ── 环面无缝性自检（只在 ?debug 下跑）───────────────────────────
if (director.debug) {
	const T = CFG.world.tile;
	const a = forest.sampleAround(0.5, 60, 6);
	const b = forest.sampleAround(T + 0.5, 60, 6);
	const same = JSON.stringify(a) === JSON.stringify(b);
	console.log(
		`[环面无缝性自检] ${same ? 'PASS' : 'FAIL'} — 周期=${T} m，` +
			`采样格点 ${a.length} 个，(0.5,60) 与 (${T + 0.5},60) 的相对布局${same ? '完全一致' : '不一致'}`,
	);
	console.log(
		`[世界] 树格 ${(T / CFG.world.treeCells).toFixed(2)} m × ${CFG.world.treeCells} = ${T} m；` +
			`雾密度 ${CFG.atmosphere.fogMin}（50% 遮蔽约 ${(0.832 / CFG.atmosphere.fogMin).toFixed(0)} m）`,
	);
	console.log('[提示] 控制台里 window.mist.director.log 可以拿到完整的显形日志');
}

// 调试入口：方便在控制台里调参、导出显形日志
window.mist = {
	CFG,
	// AudioEngine 类本身：离线频谱探针要在页面里 new 一个真类
	//（ constitution：探针必须 import 真实源码，不许手抄接线 ）
	AudioEngine,
	engine,
	settings,
	input,
	forest,
	undergrowth,
	atmosphere,
	landmark,
	lightning,
	safehouse,
	flashlight,
	player,
	stalker,
	director,
	audio,
	hud,
	// 化身与一个可复用的 Vector3。姿态视觉探针要在世界坐标里
	// 读"躯干到底降了多少"—— 那需要经矩阵变换的世界位置，
	// 而 getWorldPosition 必须传一个目标向量。
	// 提供一个工厂而不是共享实例：探针连续调用两次时，
	// 共享实例会让第一次的结果被第二次覆盖（一个很隐蔽的别名 bug）。
	avatarRef: avatar,
	THREE_V3: () => new THREE.Vector3(),
	// 同上：姿态视觉探针量"头顶世界高"用的是包围盒顶 ——
	// GLB 换装后网格原点在脚底（几何烘焙到角色空间），
	// getWorldPosition 量到的是脚，不是头顶。
	THREE_BOX3: () => new THREE.Box3(),
	// 自动化测试用：绕过指针锁直接控制暂停状态
	pause: (v) => {
		paused = v;
	},
	isPaused: () => paused,
	// 帧耗时诊断。见 ftFrame 上方的注释 —— 这些数据不参与游戏逻辑，
	// 只为了让"走着走着忽然顿一下"这类只在真人游玩时出现的现象
	// 可以被量化、被复现、被归因。
	frameTimes: () => ({
		p99: ftP99(),
		worst: ft.worst,
		spikes: ft.list.slice(),
		n: ft.n,
	}),
	frameReset: () => {
		ft.worst = 0;
		ft.list.length = 0;
		ft.n = 0;
		ft.i = 0;
	},
};

engine.start();
// 目标文案由 director 每帧按"方向记忆"状态挑选（objectiveLost / objectiveFound），
// 这里只负责把初始那一句摆上去，不要在这里判断状态。
hud.setObjective(CFG.director.objectiveLost);
