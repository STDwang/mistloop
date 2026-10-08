// 跳跃运动学探针。
//
// 【为什么这个探针必须 import 真源码，而不是把 controller.js 抄一遍】
//
// 这个项目已经吃过一次亏：audio-probe.mjs 当年是"照着 audio.js 手抄了
// 一遍接线"，结果真文件里的 `ambSrc.start()` 被调了两次（抛
// InvalidStateError，直接打断 rAF 循环 → 画面冻结 + 玩家动不了），
// 而手抄的那份没有这个 bug，探针全绿。一个 bug，两个症状，探针没抓到。
//
// 所以这里不抄任何公式。它 import 真的 Player / 真的 config，
// 用真的 forest 做碰撞，只把 input、camera 换成桩件 ——
// 这两个是外部设备（DOM/WebGL），本来就不该在 Node 里跑。
//
// 用法：cd code && node tools/jump-probe.mjs
//
// 验收标准：
//   ① 最高点 ≈ 1.0–1.15 m
//   ② 滞空 ≈ 0.85–1.05 s
//   3 落地后 pos.y 严格等于 terrainHeight（不许陷地，不许悬空）
//   ④ 腾空期间不产生任何 onStep（悬空脚步音会当场露馅）
//   5 落地恰好触发一次 onLand，且 fallHeight 与真实落差一致
//   ⑥ 空中不能二段跳
//   ⑦ 大 dt（引擎上限 0.05 s）下不穿透地面

import { CFG } from '../src/config.js';
import { Player } from '../src/player/controller.js';
import { terrainHeight } from '../src/core/noise.js';

// ── 桩件：input 与 camera ──────────────────────────────────────
function makeInput() {
	return {
		_running: false,
		keys: new Set(),
		consumeLook: () => ({ yaw: 0, pitch: 0 }),
		moveIntent: () => ({ x: 0, z: 0 }),
		tick: () => {},
		get running() {
			return this._running;
		},
		has(code) {
			return this.keys.has(code);
		},
	};
}

function makeCamera() {
	return {
		fov: CFG.player.fov,
		position: { set() {} },
		rotation: { set() {} },
		updateProjectionMatrix() {},
	};
}

// ── 桩件：forest ───────────────────────────────────────────────
// 真实 forest 需要 scene 与 InstancedMesh。这里只实现 resolve 的语义：
// 把玩家推到半径之外。跳跃探针不关心树的位置，只关心"resolve 会改 x/z"。
function makeForest(pushTo) {
	return {
		resolve: (x, z) => (pushTo ? { x: pushTo.x, z: pushTo.z } : { x, z }),
	};
}

// ── 测试脚手架 ─────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`);
	}
}

function newPlayer(opts = {}) {
	const input = makeInput();
	const camera = makeCamera();
	camera.fov = CFG.player.fov;
	const player = new Player(CFG, input, makeForest(opts.pushTo), camera);
	if (opts.start) player.warpTo(opts.start.x, opts.start.z);
	// 【探针自己的账本】onStep / onLand 回调发生在 update 内部，
	// 而场景里一次跳跃会横跨几十帧。回调里必须带上"哪一帧"，
	// 否则后面的断言只能看到"最终状态"，中间过程全部丢失 ——
	// 初版就是这么漏掉了"落地 fall 值"和"空中 exertion"两件事。
	let frame = 0;
	const steps = [];
	const lands = [];
	player.onStep = (p) => steps.push({ frame, p });
	player.onLand = (fall) => lands.push({ frame, fall });
	return {
		player,
		input,
		steps,
		lands,
		get frame() {
			return frame;
		},
		// 推进 n 帧，同时推进账本的帧号
		advance(dt, n, hook) {
			for (let i = 0; i < n; i++) {
				if (hook) hook(i, frame);
				player.update(dt);
				frame++;
			}
		},
	};
}

const DT = 1 / 60;

// 推进到落地（或超时）。返回逐帧轨迹，供断言使用。
function jumpAndTrace(sc, dt = DT) {
	const trace = [];
	sc.player.jump();
	const g = () => terrainHeight(sc.player.pos.x, sc.player.pos.z, CFG);
	let minClearance = Infinity;
	let airFrames = 0;
	let guard = 0;
	// 先把起跳那一帧走掉
	sc.advance(dt, 1);
	while (sc.player.airborne && guard++ < 400) {
		const clearance = sc.player.pos.y - g();
		if (clearance < minClearance) minClearance = clearance;
		trace.push({ frame: sc.frame, clearance, vy: sc.player.vy });
		sc.advance(dt, 1);
		airFrames++;
	}
	const apex = trace.length ? Math.max(...trace.map((r) => r.clearance)) : 0;
	const apexFrame = trace.length ? trace.find((r) => r.clearance === apex).frame : 0;
	return { trace, apex, apexFrame, minClearance, airFrames, airTime: airFrames * dt };
}


// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 1. 跳跃剖面（平地起跳）══════');
{
	const sc = newPlayer();
	const { player, steps, lands } = sc;
	// 用起跳点的地面做参照，而不是落地点的 —— 这一跳会往前飘一点
	sc.advance(DT, 6);
	const ground = terrainHeight(player.pos.x, player.pos.z, CFG);
	check('站立时贴地', Math.abs(player.pos.y - ground) < 1e-9, `y=${player.pos.y.toFixed(6)}`);

	player.jump();
	check('起跳请求被接受', player._wantJump === true);

	const R = jumpAndTrace(sc);
	const jumpHeight = R.apex;
	const airTime = R.airTime;

	console.log(`  最高点 ${jumpHeight.toFixed(3)} m @ 第 ${R.apexFrame} 帧`);
	console.log(`  滞空   ${airTime.toFixed(3)} s（${R.airFrames} 帧 @ ${(1 / DT).toFixed(0)}fps）`);
	console.log(`  离地最小间隙 ${R.minClearance.toFixed(4)} m（不应为负）`);

	// 腾空期间只有起跳那一下允许出声，之后必须绝对安静
	check('腾空期间无脚步（除起跳那一下）', steps.length === 1, `腾空中的 onStep 次数=${steps.length}（应为 1）`);
	check('起跳那一下确实响了', steps.length >= 1 && steps[0].p > 0, steps.length ? `p=${steps[0].p}` : '无');

	check('最高点 1.0–1.15 m', jumpHeight > 1.0 && jumpHeight < 1.15, `${jumpHeight.toFixed(3)} m`);
	check('滞空 0.85–1.05 s', airTime > 0.85 && airTime < 1.05, `${airTime.toFixed(3)} s`);
	check('腾空全程不穿地', R.minClearance >= -1e-9, `min=${R.minClearance.toExponential(2)}`);

	check('落地后 airborne=false', player.airborne === false);
	check('落地后贴地', Math.abs(player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG)) < 1e-9);
	check('落地后 vy 归零', player.vy === 0);
	check('落地触发恰好一次 onLand', lands.length === 1, `次数=${lands.length}`);
	if (lands.length) {
		// 【这一条是最容易写错的地方】fall 必须用"起跳时的绝对高度 - 落点的地面高度"。
		// 初版用的是落地那一帧的 pos.y（已经被钳在地面上），所以算出 0。
		const expect = Math.abs(lands[0].fall - jumpHeight);
		check('落差与最高点一致（< 6 cm）', expect < 0.06, `fall=${lands[0].fall.toFixed(3)} vs 最高点=${jumpHeight.toFixed(3)}`);
		check('落差既不是 0 也不是负', lands[0].fall > 0.9, `fall=${lands[0].fall.toFixed(3)}`);
	}

	const theory = (CFG.player.jumpImpulse ** 2) / (2 * CFG.player.gravity);
	console.log(`  理论最高点 v²/2g = ${theory.toFixed(4)} m`);
	check('与解析解一致（< 9%，差的是离散积分误差）', Math.abs(jumpHeight - theory) / theory < 0.09);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 2. 空中操控与二段跳禁令 ══════');
{
	const sc = newPlayer();
	const { player } = sc;
	sc.advance(DT, 4);
	player.jump();
	sc.advance(DT, 10);

	check('腾空中 airborne=true', player.airborne === true);
	check('空中二次跳跃被拒绝', player.jump() === false);
	check('被拒绝后也没有积压请求', player._wantJump === false);

	// 空中仍然有阻尼（只是被 airControl 削弱），落地后恢复完整阻尼
	const sc2 = newPlayer();
	const p2 = sc2.player;
	sc2.advance(DT, 4);
	sc2.input.moveIntent = () => ({ x: 0, z: 1 });
	sc2.advance(DT, 90);
	const groundSpeed = p2.speed;
	check('地面加速起来了', groundSpeed > 2.0, `${groundSpeed.toFixed(2)} m/s`);

	sc2.input.moveIntent = () => ({ x: 0, z: 0 });
	p2.jump();
	sc2.advance(DT, 30);
	check('空中松手仍会减速（不是零阻力）', p2.speed < groundSpeed * 0.85, `${groundSpeed.toFixed(2)} → ${p2.speed.toFixed(2)} m/s`);
	sc2.advance(DT, 120);
	check('落地后彻底停住', p2.speed < 0.05, `${p2.speed.toFixed(4)} m/s`);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 3. 大 dt 稳健性（引擎把 dt 钳在 0.05 s）══════');
{
	const sc = newPlayer();
	sc.advance(0.05, 6);
	const R = jumpAndTrace(sc, 0.05);
	check('dt=0.05 时不穿地', R.minClearance >= -1e-9, `min=${R.minClearance.toExponential(2)}`);
	check('dt=0.05 时能正常落地', sc.player.airborne === false);
	// 大 dt 下差值积分会低估跳跃高度（半个步长的误差），只要还在合理区间即可
	check('dt=0.05 时滞空仍在合理区间', R.airTime > 0.7 && R.airTime < 1.2, `${R.airTime.toFixed(3)} s`);
	console.log(`  dt=0.05 下的最高点 ${R.apex.toFixed(3)} m（dt=1/60 时约 1.04 —— 差值是离散积分误差）`);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 4. 变 dt 抖动（真实 rAF 的帧时间不齐）══════');
{
	const sc = newPlayer();
	const player = sc.player;
	// 固定种子的伪随机 dt，模拟 16–33 ms 的抖动
	let s = 0x1234;
	const rnd = () => {
		s = (Math.imul(s ^ (s >>> 15), 2246822519) + 374761393) | 0;
		return ((s >>> 8) & 0xffff) / 0xffff;
	};
	const step = () => sc.advance(0.016 + rnd() * 0.017, 1);

	for (let i = 0; i < 10; i++) step();
	player.jump();
	// 【踩坑】jump() 只是投递请求，airborne 要等下一帧 update 才变 true。
	// 初版把 while (player.airborne) 写在最前面，条件第一次求值就是 false，
	// 循环体一次都没跑 —— 于是 lands=0、minC=Infinity，三条断言全假失败。
	// 正确的写法是先无条件走一帧，再进入循环。
	step();
	let minC = Infinity;
	let guard = 0;
	while (player.airborne && guard++ < 400) {
		// 只在仍然腾空时采样：落地那一帧的间隙本来就是 0
		minC = Math.min(minC, player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG));
		step();
	}
	check('抖动 dt 下确实起飞了', guard > 1, `腾空 ${guard} 帧`);
	check('抖动 dt 下不穿地', minC >= -1e-9, `min=${minC.toExponential(2)}`);
	check('抖动 dt 下仍会落地', player.airborne === false);
	check('抖动 dt 下只落地一次', sc.lands.length === 1, `次数=${sc.lands.length}`);
	check('落地后严格贴地', Math.abs(player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG)) < 1e-9);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 5. warpTo 必须清掉垂直状态 ══════');
{
	const sc = newPlayer();
	const { player } = sc;
	sc.advance(DT, 4);
	player.jump();
	sc.advance(DT, 12);
	check('warp 前在空中', player.airborne === true);

	// Director 在 CLIMAX 之后会这样传送玩家（director.js: _endClimax）
	player.warpTo(30, 90);
	check('warp 后 airborne 清掉', player.airborne === false);
	check('warp 后 vy 归零', player.vy === 0);
	check('warp 后贴在新地面上', Math.abs(player.pos.y - terrainHeight(30, 90, CFG)) < 1e-9);
	check('warp 后清掉积压的跳跃请求', player._wantJump === false);

	// 传送不该让玩家"从天上掉下来"：推进 60 帧，y 必须一直贴地
	let drifted = false;
	let maxClear = 0;
	sc.advance(DT, 60, () => {
		maxClear = Math.max(maxClear, Math.abs(player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG)));
	});
	drifted = maxClear > 1e-9;
	check('传送后不会悬空漂移', !drifted, `最大离地 ${maxClear.toExponential(2)} m`);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 6. exertion 通道（跳跃 → 呼吸，不扣体力）══════');
{
	const sc = newPlayer();
	const { player } = sc;
	sc.advance(DT, 6);
	const stamina0 = player.stamina;
	const ex0 = player.getExertion();

	player.jump();
	check('起跳请求已投递', player._wantJump === true);
	// 【关键】必须在 update 之后立刻检查，不能等 30 帧 ——
	// boost 每帧衰减 dt/2.2，30 帧后已经掉到 0.13 以下，看不出"上升"。
	sc.advance(DT, 1);
	const ex1 = player.getExertion();
	check('起跳后 exertion 立刻上升', ex1 > ex0 + 0.2, `${ex0.toFixed(3)} → ${ex1.toFixed(3)}`);
	check('boost 已被写入', player._exertionBoost > 0.3, `boost=${player._exertionBoost.toFixed(3)}`);
	check('跳跃不扣体力（代价是声音，不是数值）', player.stamina === stamina0, `stamina=${player.stamina.toFixed(3)}`);

	// 跑完整个跳跃 + 等 6 s，boost 必须自己退掉
	sc.advance(DT, 120);
	sc.advance(DT, 360);
	check('boost 会自己退掉', player._exertionBoost < 0.03, `boost=${player._exertionBoost.toFixed(4)}`);
	// 而且退干净后 getExertion 只由体力与速度决定
	check('退掉后 exertion 回到基线', Math.abs(player.getExertion() - (1 - player.stamina / CFG.player.staminaMax) * 0.7) < 1e-6);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 7. forest.resolve 改动 x/z 后，地面高度必须重新取 ══════');
{
	// 让 forest.resolve 每帧把玩家钉在固定点，模拟"贴着树干起跳"
	const pushTo = { x: 12.0, z: 7.5 };
	const sc = newPlayer({ pushTo });
	const { player } = sc;
	sc.advance(DT, 6);
	const expected = terrainHeight(pushTo.x, pushTo.z, CFG);
	check('被推开后站在新位置的地面上', Math.abs(player.pos.y - expected) < 1e-9, `y=${player.pos.y.toFixed(6)}`);

	const R = jumpAndTrace(sc);
	check('在世界里起跳也全程不穿地', R.minClearance >= -1e-9, `min=${R.minClearance.toExponential(2)}`);
	check('落点仍以最终 (x,z) 的地面为准', Math.abs(player.pos.y - expected) < 1e-9);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n══════ 8. 连续跳跃（急促地蹦）══════');
{
	const sc = newPlayer();
	const { player } = sc;
	sc.advance(DT, 6);

	let jumps = 0;
	let refused = 0;
	let airJumpsAccepted = 0;
	let groundedAndAirborne = 0;
	let maxGroundError = 0;
	let previousAirborne = false;

	// 每帧都尝试起跳，持续 4 s。诉求：只有在地面上才会被接受。
	// 这个循环同时是**不变量检查**：任何一帧结束后，若已落地，
	// y 必须严格等于该点地面 —— 一次也不许例外。
	for (let i = 0; i < 240; i++) {
		// 上一帧结束时还在空中，这一帧却接受了跳跃 → 二段跳漏了
		const accepted = player.jump();
		if (accepted) {
			jumps++;
			if (previousAirborne) airJumpsAccepted++;
		} else {
			refused++;
		}
		sc.advance(DT, 1);
		// 帧末不变量
		if (player.airborne) {
			// 腾空时不许"陷在地面以下"
			const c = player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG);
			if (c < -1e-9) groundedAndAirborne++;
		} else {
			maxGroundError = Math.max(
				maxGroundError,
				Math.abs(player.pos.y - terrainHeight(player.pos.x, player.pos.z, CFG)),
			);
		}
		previousAirborne = player.airborne;
	}

	// 4 秒 / 每次约 0.92 s ≈ 4–5 次成功起跳
	check('连续按跳跃只在落地时被接受（4 s 内 4–6 次）', jumps >= 4 && jumps <= 6, `接受 ${jumps} 次，拒绝 ${refused} 次`);
	check('从未发生空中二段跳', airJumpsAccepted === 0, `空中被接受的跳跃 ${airJumpsAccepted} 次`);
	check('腾空期间从不低于地面', groundedAndAirborne === 0);
	check('每一次落地结算都严格贴地', maxGroundError < 1e-9, `最大误差 ${maxGroundError.toExponential(2)} m`);

	// 落地次数与起跳次数的关系：差值恰好是"循环结束时还在空中的那一次"
	const stillAirborne = player.airborne ? 1 : 0;
	check(
		'onLand 次数 = 起跳次数 - 仍在空中的次数',
		sc.lands.length === jumps - stillAirborne,
		`onLand ${sc.lands.length} / 起跳 ${jumps} / 结束时腾空 ${stillAirborne}`,
	);
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n══════ 结果：${pass} PASS / ${fail} FAIL ══════\n`);
process.exit(fail ? 1 : 0);
