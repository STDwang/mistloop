// 定身 + 回家 探针：验证「手电照住鬼影 → 读到家的方向 → 满足条件才能到家」。
//
// ─────────────────────────────────────────────────────────────
// 【这个探针要回答的问题】
// 需求原文：
//   ② 「手电筒可以照到鬼影，鬼影被照到后会被定住，鬼是杀不死的」
//   ③ 「游戏目标是逃回自己的山洞安全屋，受限于鬼影的规则影响，
//       玩家需要满足一定条件才能找到安全屋的方向」
//
// 拆开：
//   A 判定几何：光束"照到没照到"这件事本身对不对
//   B 定身：被照住时它是不是**真的**一动不动、寿命暂停
//   C 方向记忆：必须"连续照够一段时间"才读得到方向；读到之后会忘，
//                但永久记住的那部分不会忘
//   D 环面方位：箭头指的是**最短的那一条路**（不是绕远路的那一条）
//   E 到家与不死：进洞就是终点；被抓住不是死，是被弄糊涂
//
// ─────────────────────────────────────────────────────────────
// 【为什么这个探针里几乎每一格都要手算"预期值"】
//
// "照到"是一个**几何判定**，它有一个可以直接算出来的正确答案。
// 如果只看"探针摆了一个明显的姿势，然后 lit === true"，那这个测试
// 对参数改动毫无抵抗：把 holdAngle 从 0.34 改成 2.0（等于取消锥体），
// 所有正例照样通过。所以这里的做法是：
//
//   ① 把相机俯仰**精确地对准**它身体的某个高度（算出来的，不是试出来的）
//   ② 于是到"中段"的三维夹角正好是 0，到"脚"的夹角是一个可算的量
//   ③ 然后断言：对准中段 → 照得到；对准脚 → 照**不**到
//
// 第③条里的第二个分支（对准脚却照不到）是这个探针最值钱的一条断言：
// 只有当判定瞄的是**身体中段**而不只是水平方向时，它才会成立。
// 如果有人把 _litByTorch 简化回"只比水平角"，它立刻变红。
//
// ─────────────────────────────────────────────────────────────
// 【为什么全部手动定步】
// 同 storm-probe：headless 下物理时间只以墙钟的零头前进，
// "等 N 秒再断言"测的是耐心不是游戏。这里 pause(true) 停掉 rAF 里的
// director，然后手动 update(1/60)。顺便还带来一个好处 ——
// 每一步都是精确的 1/60，于是"1.15 s 的门槛"这种断言可以卡到帧。
// ─────────────────────────────────────────────────────────────

import { chromium } from 'playwright-core';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.png': 'image/png',
};

const server = createServer((req, res) => {
	const url = (req.url || '/').split('?')[0];
	let file = normalize(join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url)));
	if (!file.startsWith(normalize(DIST))) file = join(DIST, 'index.html');
	try {
		if (statSync(file).isDirectory()) file = join(file, 'index.html');
	} catch {
		file = join(DIST, 'index.html');
	}
	res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
	createReadStream(file).pipe(res);
});
const port = await new Promise((r) =>
	server.listen(0, '127.0.0.1', () => r(server.address().port)),
);

const exe = [
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!exe) {
	console.error('找不到 Chrome/Edge');
	server.close();
	process.exit(2);
}

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}  ${detail}`);
}
function near(a, b, tol) {
	return Math.abs(a - b) < tol;
}

let browser;
try {
	browser = await chromium.launch({
		executablePath: exe,
		headless: true,
		args: [
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--enable-webgl',
			'--ignore-gpu-blocklist',
			'--disable-gpu-sandbox',
			'--no-sandbox',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	const errors = [];
	page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});

	await page.goto(`http://127.0.0.1:${port}/?debug`, { waitUntil: 'load', timeout: 60000 });
	await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
	await page.locator('button:has-text("进入林子")').click();
	await page.evaluate('window.mist.pause(false)');
	await page.waitForFunction('window.mist.audio.ready === true', null, { timeout: 30000 });
	await page.waitForFunction('window.mist.director.time > 0.25', null, { timeout: 30000 });

	// ── 在页面里搭一套确定性脚手架 ────────────────────────────────
	//
	// 关键约定（照抄源码里的轴向语义，别自己发明）：
	//   · yaw 增大 = 向左转；前方 = (-sin yaw, -cos yaw)
	//   · 相机 rotation.order = 'YXZ'，rotation.x 为正 = 抬头
	//   · 手电挂点在第一人称下就是相机（rig 的局部位置是原点），
	//     所以光束起点 = 相机位置、方向 = 相机的 -Z
	await page.evaluate(`
		(() => {
			const m = window.mist;
			// 视角固定成第一人称：第三人称时 rig 挂在化身的头上，
			// 那样"光束起点"就不是相机了，本节的前提会变。
			m.player.setViewMode('first');
			m.pause(true);

			const P = m.player;
			const cam = m.engine.camera;
			const S = m.stalker;
			const FL = m.flashlight;
			const d = m.director;
			const E = m.CFG.entity;
			const F = m.CFG.flashlight;
			let elapsed = 0;

			// 手动定步：顺序照抄 main.js 的帧循环（只留与判定相关的三个）
			const step = (n) => {
				for (let i = 0; i < n; i++) {
					elapsed += 1 / 60;
					d.update(1 / 60, elapsed);
					S.update(1 / 60);
					FL.update(1 / 60, d.tension);
				}
			};

			// 关掉所有自主行为，保证每一步都在我们控制下
			const quiet = () => {
				d.cooldown = 1e9;
				d.pending = null;
				m.lightning._next = 1e9;
				m.lightning._pulses.length = 0;
				m.lightning._pending.length = 0;
				m.lightning.flash = 0;
			};

			// 把玩家和相机摆到确定状态
			const place = (px, pz, yaw, pitch) => {
				P.warpTo(px, pz);
				P.yaw = yaw;
				P.pitch = pitch;
				cam.position.set(P.pos.x, P.pos.y + P.eyeHeight, P.pos.z);
				cam.rotation.set(pitch, yaw, 0);
				cam.updateMatrixWorld(true);
				return pitch;
			};

			// 把它放到"相对于当前 yaw 的某个方位、某个距离"上
			const ghostAt = (dist, azOff) => {
				const a = P.yaw + azOff;
				const gx = P.pos.x - Math.sin(a) * dist;
				const gz = P.pos.z - Math.cos(a) * dist;
				S.show();
				S.place(gx, gz);
				S.faceTarget(P.pos.x, P.pos.z);
				return { gx, gz, gy: S.pos.y };
			};

			// 两个"手算预期值"用的小函数：
			// 从真实光束起点看过去，某个身体高度出现在多少仰角上。
			// 把相机 pitch 设成这个值，光束就精确穿过那个高度。
			const elevOf = (offsetY) => {
				const a = FL.aim({});
				const dy = S.pos.y + offsetY - a.oy;
				const dh = Math.hypot(S.pos.x - a.ox, S.pos.z - a.oz);
				return Math.atan2(dy, dh);
			};
			// 光束与"某个身体高度"的三维夹角。**只用于打印诊断**，
			// 断言用的是 director 自己的 _litByTorch()。
			const angleTo = (offsetY) => {
				const a = FL.aim({});
				const tx = S.pos.x - a.ox;
				const ty = S.pos.y + offsetY - a.oy;
				const tz = S.pos.z - a.oz;
				const dd = Math.sqrt(tx * tx + ty * ty + tz * tz);
				const cos = (tx * a.dx + ty * a.dy + tz * a.dz) / dd;
				return Math.acos(Math.min(1, Math.max(-1, cos)));
			};

			window.__H = {
				m, P, cam, S, FL, d, E, F,
				step, quiet, place, ghostAt, elevOf, angleTo,
				midOffset: E.height * F.aimAt,
				holdAngle: F.holdAngle,
				holdRange: F.holdRange,
			};
		})()
	`);

	// ══════════ A 判定几何 ══════════
	console.log('\n══════ A 「照到没照到」的判定几何 ══════');

	const geo = await page.evaluate(`
		(() => {
			const H = window.__H;
			const { P, S, FL, d } = H;
			const out = {};
			const run = (name, dist, azOff, kind) => {
				H.place(98, 98, 0, 0);
				const g = H.ghostAt(dist, azOff);
				// 先算"对准中段/对准脚"分别需要多少仰角，再设成其中之一个
				const pMid = H.elevOf(H.midOffset);
				const pBase = H.elevOf(0);
				const pitch = kind === 'mid' ? pMid : kind === 'base' ? pBase : kind;
				H.place(98, 98, 0, pitch);
				out[name] = {
					dist,
					azOff,
					pitch,
					pMid,
					pBase,
					midAngle: H.angleTo(H.midOffset),
					baseAngle: H.angleTo(0),
					lit: d._litByTorch(),
					gy: g.gy,
					camY: H.cam.position.y,
				};
				// 脚的高度处，从光束起点看过去的夹角 —— 用于后面那条
				// "如果判定瞄的是脚"的反证
				out[name].wouldHitIfAimedAtFeet = H.angleTo(0) < H.holdAngle;
			};

			run('对准中段_10m', 10, 0, 'mid');
			run('对准脚_1_7m', 1.7, 0, 'base');
			run('抬头_10m', 10, 0, 0.9);
			run('方位偏出_10m', 10, 0.6, 'mid');
			run('方位在界内_10m', 10, 0.15, 'mid');
			run('太远_32m', 32, 0, 'mid');

			// 关灯
			H.place(98, 98, 0, 0);
			H.ghostAt(10, 0);
			H.place(98, 98, 0, H.elevOf(H.midOffset));
			FL.on = false;
			out['关灯_10m'] = { lit: d._litByTorch(), midAngle: H.angleTo(H.midOffset) };
			FL.on = true;
			out['开灯_复核'] = { lit: d._litByTorch() };
			return out;
		})()
	`);

	const holdAngle = await page.evaluate('window.__H.holdAngle');
	const holdRange = await page.evaluate('window.__H.holdRange');

	for (const [k, v] of Object.entries(geo)) {
		console.log(
			`  ${k.padEnd(16)} lit=${String(v.lit).padEnd(5)} ` +
				(v.midAngle !== undefined
					? `到中段${v.midAngle.toFixed(3)}rad` +
						(v.baseAngle !== undefined ? ` 到脚${v.baseAngle.toFixed(3)}rad ` : ' ')
					: '') +
				`（门槛 ${holdAngle.toFixed(2)}rad）`,
		);
	}

	check('正对着它、瞄它身体中段、10 m 内 → 照得到', geo['对准中段_10m'].lit === true, `lit=${geo['对准中段_10m'].lit}`);
	check(
		'判定瞄的是**身体中段**而不是脚（瞄准脚 → 照不到）',
		geo['对准脚_1_7m'].lit === false && geo['对准脚_1_7m'].wouldHitIfAimedAtFeet === true,
		`lit=${geo['对准脚_1_7m'].lit}；到中段${geo['对准脚_1_7m'].midAngle.toFixed(3)}rad ` +
			`> 门槛，但如果只看脚(${geo['对准脚_1_7m'].baseAngle.toFixed(3)}rad)就会误判成"照到了"`,
	);
	check(
		'判定包含俯仰（抬头看天 → 照不到，即使方位正对）',
		geo['抬头_10m'].lit === false,
		`lit=${geo['抬头_10m'].lit} 到中段${geo['抬头_10m'].midAngle.toFixed(3)}rad`,
	);
	check(
		'方位角偏出光锥 → 照不到',
		geo['方位偏出_10m'].lit === false,
		`lit=${geo['方位偏出_10m'].lit} 夹角${geo['方位偏出_10m'].midAngle.toFixed(3)}rad`,
	);
	check(
		'方位角在光锥内 → 照得到（不是"永远判不到"）',
		geo['方位在界内_10m'].lit === true,
		`lit=${geo['方位在界内_10m'].lit} 夹角${geo['方位在界内_10m'].midAngle.toFixed(3)}rad`,
	);
	check(
		'超出射程 → 照不到（衰减后本来也照不亮）',
		geo['太远_32m'].lit === false,
		`lit=${geo['太远_32m'].lit} 距离 32 m > ${holdRange.toFixed(0)} m`,
	);
	check('关灯 → 照不到', geo['关灯_10m'].lit === false, `lit=${geo['关灯_10m'].lit}`);
	check('重新开灯 → 又照得到', geo['开灯_复核'].lit === true, `lit=${geo['开灯_复核'].lit}`);

	// ══════════ B 定身 ══════════
	console.log('\n══════ B 被照住 = 定住（真的不动） ══════');

	const hold = await page.evaluate(`
		(() => {
			const H = window.__H;
			const { P, S, FL, d, E } = H;
			H.quiet();

			// 让它显形，然后**把它搬到光束正中央**（_spawn 会把它放在
			// 视野边缘，那是显形规则，不是我们要测的东西）。
			d._spawn('R5', false);
			H.place(98, 98, 0, 0);
			H.ghostAt(10, 0);
			H.place(98, 98, 0, H.elevOf(H.midOffset));
			// 光束还没打开的那一帧就要取初值
			S.update(1 / 60);

			const t0 = {
				_t: S._t,
				rootYaw: S.root.rotation.y,
				bodyScaleY: S.body.scale.y,
				life: d.life,
				stare: d.stareTime,
				dread: d.dread,
				limb: S.limbs[0].rotation.x,
			};

			// ── 先单独测"照到 → 定住"的**上升延迟** ─────────────
			//
			// 【为什么这一格必须单独测，而不是直接步进 30 帧再看】
			// stalker 那边的 lit 是平滑量（litRise 0.1 s），而"冻结"是从
			// held（lit > 0.5）那一刻开始的。也就是说**照到之后有几帧它还在动**。
			// 直接步进 30 帧再断言"一动没动"会被这几帧弄红 —— 而红得毫无意义，
			// 因为问题不在"冻结"，在"上升有多快"。
			// 所以拆成两条各自独立的断言：
			//   ① 上升要多快（rampFrames）
			//   ② 从 held 成立那一刻起，是不是真的一动不动
			let rampFrames = 0;
			while (!S.held && rampFrames < 40) {
				H.step(1);
				rampFrames++;
			}
			const tHeld = {
				_t: S._t,
				rootYaw: S.root.rotation.y,
				bodyScaleY: S.body.scale.y,
				limb: S.limbs[0].rotation.x,
			};

			// 继续照住，一直到淡入结束（0.55 s）之后再读数 ——
			// 否则测到的透明度里还含着一个没走完的淡入
			const total = rampFrames + 30;
			H.step(30);

			const held = {
				lit: d.lit,
				litTarget: S.litTarget,
				smoothLit: S.lit,
				held: S.held,
				heldStayed: S.held,
				_t: S._t,
				rootYaw: S.root.rotation.y,
				bodyScaleY: S.body.scale.y,
				limb: S.limbs[0].rotation.x,
				life: d.life,
				stare: d.stareTime,
				dread: d.dread,
				holdT: d.holdT,
				bearingKnown: d.bearingKnown,
				bearingFloor: d.bearingFloor,
				appearT: d.appearT,
				opacity: S.opacity,
				rim: S.rim.material.opacity,
				dist: S.distanceTo(P.pos),
				heldStat: d.stats.held,
				state: d.state,
			};

			// ── 松手：抬头把光移开 ──────────────────────────────
			// stareTime 归零，是为了在下面 0.75 s 里不会撞到"注视驱逐"
			// 的 1.1 s 期限 —— 我们要测的是"没被照住"，不是"它溶解了"。
			d.stareTime = 0;
			const stareBefore = d.stareTime;
			H.place(98, 98, 0, 0.9);          // 抬头看天
			const lifeBefore = d.life;
			const releasedFrames = 45;
			H.step(releasedFrames);            // 0.75 s

			const released = {
				lit: d.lit,
				litTarget: S.litTarget,
				smoothLit: S.lit,
				held: S.held,
				_t: S._t,
				life: d.life,
				stareRate: (d.stareTime - stareBefore) / (releasedFrames / 60),
				holdT: d.holdT,
				state: d.state,
				lifeBefore,
			};

			const dt = 1 / 60;
			return {
				t0, tHeld, held, released, rampFrames, total,
				frozenRoom: total - rampFrames,
				dt,
				holdStareK: H.F.holdStareK,
				litRise: H.F.litRise,
				litFall: H.F.litFall,
			};
		})()
	`);

	console.log(
		`  照到 → 定住用 ${hold.rampFrames} 帧（${((hold.rampFrames / 60) * 1000).toFixed(0)} ms，` +
			`litRise=${hold.litRise}）；之后又照住 ${hold.frozenRoom} 帧`,
	);
	console.log(
		`  照住 ${(hold.total / 60).toFixed(2)} s：lit=${hold.held.lit} 平滑=${hold.held.smoothLit.toFixed(3)} ` +
			`held=${hold.held.held} 透明度=${hold.held.opacity.toFixed(3)}（淡入进度 ${hold.held.appearT.toFixed(2)}s）` +
			` 亮边=${hold.held.rim.toFixed(3)}`,
	);
	console.log(
		`  它冻结那一刻的时间轴：_t ${hold.tHeld._t.toFixed(4)} → ${hold.held._t.toFixed(4)}；` +
			`寿命 ${hold.t0.life.toFixed(3)} → ${hold.held.life.toFixed(3)}`,
	);
	console.log(
		`  松手 0.75 s：held=${hold.released.held} _t=${hold.released._t.toFixed(3)} ` +
			`寿命 ${hold.released.lifeBefore.toFixed(3)} → ${hold.released.life.toFixed(3)}`,
	);

	check('照到 → 导演判定 lit 为真', hold.held.lit === true, `lit=${hold.held.lit}`);
	check('照到 → 目标值写进了它的 litTarget', hold.held.litTarget === 1, `litTarget=${hold.held.litTarget}`);
	check('照到 → 平滑后认定为"被定住"（held）', hold.held.held === true, `held=${hold.held.held}`);
	check(
		'照到的反馈是**立刻**的（litRise 0.1 s，实测 <= 8 帧 / 133 ms）',
		hold.rampFrames <= 8,
		`${hold.rampFrames} 帧 = ${((hold.rampFrames / 60) * 1000).toFixed(0)} ms`,
	);
	check(
		'定住 = **时间轴完全冻结**（held 成立之后 _t 一个刻度都没走）',
		hold.held._t === hold.tHeld._t,
		`定住后 ${hold.frozenRoom} 帧里 ${hold.tHeld._t.toFixed(6)} → ${hold.held._t.toFixed(6)}`,
	);
	check(
		'定住 = 三个动画量都没动（呼吸缩放 / 摇摆 / 手臂）',
		hold.held.bodyScaleY === hold.tHeld.bodyScaleY &&
			hold.held.rootYaw === hold.tHeld.rootYaw &&
			hold.held.limb === hold.tHeld.limb,
		`scaleY ${hold.tHeld.bodyScaleY.toFixed(5)}=${hold.held.bodyScaleY.toFixed(5)} ` +
			`yaw ${hold.tHeld.rootYaw.toFixed(5)}=${hold.held.rootYaw.toFixed(5)} ` +
			`arm ${hold.tHeld.limb.toFixed(5)}=${hold.held.limb.toFixed(5)}`,
	);
	check(
		'定住 = **寿命暂停**（它不会自己到期消失）',
		hold.held.life === hold.t0.life && hold.held.state === 'MANIFEST',
		`life ${hold.t0.life.toFixed(4)} → ${hold.held.life.toFixed(4)} state=${hold.held.state}`,
	);
	check(
		'定住 = 它不会靠近（距离严格不变）',
		near(hold.held.dist, 10, 1e-6),
		`距离=${hold.held.dist.toFixed(6)} m`,
	);
	check(
		'被照住时它一定看得见（可见度下限生效，淡入也已走完）',
		hold.held.opacity > 0.9 && hold.held.appearT > 0.55,
		`opacity=${hold.held.opacity.toFixed(3)}（该帧淡入进度 ${hold.held.appearT.toFixed(3)}s）`,
	);
	check(
		'被照住时有前向散射的亮边（否则"照一个纯黑的东西"只会更黑）',
		hold.held.rim > 0.4,
		`亮边不透明度=${hold.held.rim.toFixed(3)}`,
	);

	// stare / dread 从**第一帧**就开始累积（导演那边 lit 是精确的几何判定，
	// 不等 stalker 的平滑量），所以按 total 帧数算。
	const expectStare = (hold.total / 60) * hold.holdStareK;
	check(
		`定住时注视累积被抑制到 ${hold.holdStareK}×（${expectStare.toFixed(3)} s）`,
		near(hold.held.stare, expectStare, 0.006),
		`实测 stareTime=${hold.held.stare.toFixed(4)}s（照住 ${hold.total} 帧）`,
	);
	const expectDread = (hold.total / 60) * 0.055;
	check(
		'盯住有代价：恐惧值按 dreadOnHold 上涨（0.055/s）',
		near(hold.held.dread - hold.t0.dread, expectDread, 0.005),
		`Δdread=${(hold.held.dread - hold.t0.dread).toFixed(4)}（理论 ${expectDread.toFixed(4)}）`,
	);
	check('照上去的那一刻记了一次事件（上升沿，不是持续计数）', hold.held.heldStat >= 1, `stats.held=${hold.held.heldStat}`);

	check('松手后不再判定为照到', hold.released.lit === false && hold.released.litTarget === 0, `lit=${hold.released.lit}`);
	check(
		'松手后解除定身（平滑下降，手抖一下不会立刻恢复移动）',
		hold.released.held === false && hold.released.smoothLit < hold.held.smoothLit,
		`smoothLit ${hold.held.smoothLit.toFixed(3)} → ${hold.released.smoothLit.toFixed(3)} held=${hold.released.held}`,
	);
	check(
		'松手后时间轴恢复推进',
		hold.released._t > hold.held._t,
		`_t ${hold.held._t.toFixed(4)} → ${hold.released._t.toFixed(4)}`,
	);
	check(
		'松手后寿命恢复倒计时',
		hold.released.life < hold.released.lifeBefore,
		`${hold.released.lifeBefore.toFixed(4)} → ${hold.released.life.toFixed(4)}`,
	);
	check(
		'松手后注视累积回到 1×（是 holdStareK 的倒数倍）',
		near(hold.released.stareRate, 1, 0.05),
		`实测 ${hold.released.stareRate.toFixed(3)}/s（照住时是 ${hold.holdStareK}/s）`,
	);

	// ══════════ C 方向记忆 ══════════
	console.log('\n══════ C 方向：必须"连续照够一段时间"才读得到 ══════');

	const bearing = await page.evaluate(`
		(() => {
			const H = window.__H;
			const { P, S, d } = H;
			H.quiet();
			const S_ = H.m.CFG.safehouse;

			// 重置方向记忆，重新显形
			d.bearingKnown = 0;
			d.bearingFloor = 0;
			d.holdT = 0;
			d.escaped = false;
			d._spawn('R5', false);
			H.place(98, 98, 0, 0);
			H.ghostAt(10, 0);
			H.place(98, 98, 0, H.elevOf(H.midOffset));
			S.update(1 / 60);

			// ① 门槛之前：什么都不该读到
			H.step(60);                                  // 1.0 s < holdToReveal 1.15
			const before = {
				holdT: d.holdT,
				known: d.bearingKnown,
				floor: d.bearingFloor,
				revealed: d.revealedThisManifest,
				objective: document.getElementById('objective').textContent,
			};

			// ② 越过门槛：开始读到
			H.step(20);                                  // 合计 1.333 s
			const after = {
				holdT: d.holdT,
				known: d.bearingKnown,
				floor: d.bearingFloor,
				revealed: d.revealedThisManifest,
				objective: document.getElementById('objective').textContent,
			};

			// ③ 消失时才发奖（bearingFloor 只在 _vanish 里涨）
			d.stareTime = 99;
			H.step(1);
			const atVanish = { floor: d.bearingFloor, known: d.bearingKnown, state: d.state };
			// 让它淡完
			let g = 0;
			while (d.state !== 'DORMANT' && g < 400) { H.step(1); g++; }

			// ④ 衰减：会忘，但忘不到比"永久记住的"更低
			d.bearingKnown = 0.5;
			d.bearingFloor = 0.13;
			H.step(300);                                 // 5 s，decayRate 0.1 → 0.5 的衰减量
			const decayed = { known: d.bearingKnown, floor: d.bearingFloor };
			H.step(300);                                 // 再 5 s
			const decayed2 = { known: d.bearingKnown, floor: d.bearingFloor };

			return { before, after, atVanish, decayed, decayed2, cfg: S_, state: d.state };
		})()
	`);

	console.log(
		`  1.00 s（门槛 ${bearing.cfg.holdToReveal} s 之前）：holdT=${bearing.before.holdT.toFixed(3)} ` +
			`known=${bearing.before.known.toFixed(3)} objective="${bearing.before.objective}"`,
	);
	console.log(
		`  1.33 s（越过门槛）：holdT=${bearing.after.holdT.toFixed(3)} ` +
			`known=${bearing.after.known.toFixed(3)} objective="${bearing.after.objective}"`,
	);
	console.log(
		`  5 s 后：known=${bearing.decayed.known.toFixed(4)} floor=${bearing.decayed.floor.toFixed(4)}；` +
			`再 5 s：known=${bearing.decayed2.known.toFixed(4)} floor=${bearing.decayed2.floor.toFixed(4)}`,
	);

	check(
		'照住但还没够时长 → **读不到方向**（"定住"不是一个即时的开关）',
		bearing.before.known === 0 && bearing.before.revealed === false,
		`holdT=${bearing.before.holdT.toFixed(3)} < ${bearing.cfg.holdToReveal} → known=${bearing.before.known}`,
	);
	check(
		'目标文案此时是"找回你的方向"',
		bearing.before.objective === '找回你的方向',
		`"${bearing.before.objective}"`,
	);
	check(
		'连续照够时长 → 开始读到方向',
		bearing.after.known > 0 && bearing.after.revealed === true,
		`holdT=${bearing.after.holdT.toFixed(3)} → known=${bearing.after.known.toFixed(4)}`,
	);
	check(
		'读到时目标文案变成"往家的方向走"',
		bearing.after.objective === '往家的方向走',
		`"${bearing.after.objective}"`,
	);
	check(
		'读到方向的速率 = gainRate（1.15/s）',
		// 容差里含着一次"离散化误差"：连续写法是 (holdT - holdToReveal) × gainRate，
		// 但实际是从 holdT 第一次越过门槛的**那一帧**才开始涨的，
		// 所以真值会比连续式大最多一帧的量（1.15/60 ≈ 0.019）。
		near(bearing.after.known, (bearing.after.holdT - bearing.cfg.holdToReveal) * bearing.cfg.gainRate, 0.035),
		`已知 ${bearing.after.known.toFixed(4)}，理论 ` +
			`${((bearing.after.holdT - bearing.cfg.holdToReveal) * bearing.cfg.gainRate).toFixed(4)}`,
	);
	check(
		'永久记忆只在**成功读到之后**才发奖（+floorStep）',
		bearing.atVanish.floor === bearing.cfg.floorStep,
		`bearingFloor=${bearing.atVanish.floor}（floorStep=${bearing.cfg.floorStep}）`,
	);
	check(
		'松开后会"忘"（bearingKnown 衰减）',
		bearing.decayed.known < 0.5,
		`0.5 → ${bearing.decayed.known.toFixed(4)}`,
	);
	check(
		'但忘不到比永久记住的更低 —— 所以你始终在**进步**，不是原地打转',
		near(bearing.decayed.known, bearing.decayed.floor, 1e-9) &&
			near(bearing.decayed2.known, bearing.decayed.floor, 1e-9),
		`5 s：${bearing.decayed.known.toFixed(6)}；10 s：${bearing.decayed2.known.toFixed(6)} ` +
			`（floor=${bearing.decayed.floor}）`,
	);

	// ══════════ D 环面方位 ══════════
	console.log('\n══════ D 箭头指的是环面上最短的那一条路 ═══════');

	const torus = await page.evaluate(`
		(() => {
			const H = window.__H;
			const { P, S, d, m } = H;
			H.quiet();
			d.bearingKnown = 1;
			d.bearingFloor = 0.3;

			const T = m.CFG.world.tile;
			const hx = m.safehouse.x;
			const hz = m.safehouse.z;

			// 一个"直接相减会绕远路"的位置：玩家在 x=10，山洞在 x=154.84，
			// 被 196 m 的周期一折，真正的方向是 **-51.16 m**（往 -x 走），
			// 而不是 +144.84 m（往 +x 走）。两者的方位角正好差 π ——
			// 也就是"直接相减"会让玩家**掉头走反**。
			const px = 10;
			const pz = hz;
			const naiveDx = hx - px;
			const naive = Math.abs(naiveDx);
			const naiveYaw = Math.atan2(-naiveDx, 0);

			P.warpTo(px, pz);
			P.yaw = 0;
			d.safehouse.update(1 / 60, P.pos.x, P.pos.z);
			const got = { dist: d.safehouse.dist, bearing: d.safehouse.bearing };

			// HUD 的刻度
			d.update(1 / 60, 0);
			const el = document.getElementById('bearing');
			const rel = d.bearingRel;
			const cssBearing = el.style.getPropertyValue('--bearing');
			const visibleWhenKnown = !el.classList.contains('hidden') && parseFloat(el.style.opacity) > 0.9;

			// 方向"忘光了" → 刻度必须消失（不透明度**就是**这个机制）
			d.bearingKnown = 0;
			d.bearingFloor = 0;
			d.update(1 / 60, 0);
			const hiddenWhenUnknown = el.classList.contains('hidden');
			d.bearingKnown = 1;
			d.bearingFloor = 0.3;

			// ── 端到端：照 HUD 的指示转过去、往前走 40 m，距离应该少了 40 ──
			P.warpTo(px, pz);
			P.yaw = 0;
			d.update(1 / 60, 0);
			const rel2 = d.bearingRel;
			const before = d.safehouse.dist;
			// "按刻度转 rel2" = 把 yaw 设成 rel2
			//（+ 是偏左，而 yaw 增大也是向左转）
			P.yaw = rel2;
			const step = 4;
			for (let k = 0; k < 10; k++) {
				P.pos.x += -Math.sin(P.yaw) * step;
				P.pos.z += -Math.cos(P.yaw) * step;
				d.safehouse.update(1 / 60, P.pos.x, P.pos.z);
			}
			const after = d.safehouse.dist;

			// ── 反证：按"直接相减"的方位走同样 40 m ────────────────
			// 注意这里**不能**拿 naive（144.84）当基准比。走 40 m 之后，
			// 环面上的最短差会从 51.16 变成 91.16 —— 它比 144.84 小，
			// 但比"照正确方位走"的结果（11.16）大一倍。所以基准必须是
			// before（正确起点=51.16），不是 naive。
			P.warpTo(px, pz);
			P.yaw = naiveYaw;
			for (let k = 0; k < 10; k++) {
				P.pos.x += -Math.sin(P.yaw) * step;
				P.pos.z += -Math.cos(P.yaw) * step;
				d.safehouse.update(1 / 60, P.pos.x, P.pos.z);
			}
			const naiveAfter = d.safehouse.dist;

			// 两个方位角差多少
			let diff = naiveYaw - got.bearing;
			diff = ((((diff + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

			return {
				T, hx, hz, px, pz, naive, naiveAfter, naiveYaw,
				got, rel, rel2, cssBearing,
				visibleWhenKnown, hiddenWhenUnknown,
				before, after, travelled: step * 10, bearingDiff: diff,
			};
		})()
	`);

	console.log(`  玩家 x=${torus.px}，山洞 x=${torus.hx.toFixed(2)}（周期 ${torus.T} m）`);
	console.log(
		`  直接相减 → ${torus.naive.toFixed(2)} m；wrapDelta → ${torus.got.dist.toFixed(2)} m（方位差 ` +
			`${torus.bearingDiff.toFixed(3)} rad ≈ ${((torus.bearingDiff / Math.PI) * 180).toFixed(0)}°）`,
	);
	console.log(
		`  照刻度转身走 ${torus.travelled} m：${torus.before.toFixed(2)} → ${torus.after.toFixed(2)} m`,
	);
	console.log(
		`  照"直接相减"的方位走 ${torus.travelled} m：${torus.before.toFixed(2)} → ${torus.naiveAfter.toFixed(2)} m`,
	);

	check(
		'距离走的是环面上的最短差（而不是直接相减的绕远路值）',
		torus.got.dist < torus.T / 2 && torus.got.dist < torus.naive - 50,
		`${torus.got.dist.toFixed(2)} m（直接相减会是 ${torus.naive.toFixed(2)} m）`,
	);
	check(
		'方位角符合 yaw 语义（可直接与 player.yaw 相减）',
		near(
			torus.got.bearing,
			Math.atan2(
				-(
					torus.hx -
					torus.px -
					Math.round((torus.hx - torus.px) / torus.T) * torus.T
				),
				0,
			),
			1e-6,
		),
		`bearing=${torus.got.bearing.toFixed(4)} rad`,
	);
	check(
		'直接相减的方位与正确方位差 180°（跟错方向就是掉头走反）',
		Math.abs(Math.abs(torus.bearingDiff) - Math.PI) < 0.02,
		`差 ${((torus.bearingDiff / Math.PI) * 180).toFixed(1)}°`,
	);
	check(
		'HUD 刻度的相对角 = 方位角 − 玩家朝向',
		near(torus.rel, torus.got.bearing - 0, 1e-6),
		`bearingRel=${torus.rel.toFixed(4)}`,
	);
	check(
		'CSS 的 --bearing 取了负号（yaw 增大向左转，而 CSS rotate 正方向是顺时针）',
		near(parseFloat(torus.cssBearing), -torus.rel2, 0.002),
		`--bearing = ${torus.cssBearing}，-bearingRel = ${(-torus.rel2).toFixed(4)}rad`,
	);
	check(
		'方向清楚时刻度出现（不透明度**就是**这个机制）',
		torus.visibleWhenKnown === true,
		`visible=${torus.visibleWhenKnown}`,
	);
	check(
		'方向忘光后刻度消失（不给你一个可以一直照着走的箭头）',
		torus.hiddenWhenUnknown === true,
		`hidden=${torus.hiddenWhenUnknown}`,
	);
	check(
		'照着刻度转身并前进 → 距离**减少**了（箭头真的指向家）',
		near(torus.before - torus.after, torus.travelled, 1.0),
		`少了 ${(torus.before - torus.after).toFixed(2)} m（走了 ${torus.travelled} m）`,
	);
	check(
		'反证：照"直接相减"的方位走同样距离 → 距离反而变大',
		torus.naiveAfter > torus.before + 30,
		`${torus.before.toFixed(2)} → ${torus.naiveAfter.toFixed(2)} m`,
	);

	// ══════════ E 不死 + 到家 ══════════
	console.log('\n══════ E 鬼杀不死；进洞就是终点 ══════');

	const endgame = await page.evaluate(`
		(() => {
			const H = window.__H;
			const { P, S, d, m } = H;
			H.quiet();

			// ── 杀不死：被追上（CLIMAX）不是死，是被弄糊涂 ──────────
			d.bearingFloor = 0.26;
			d.bearingKnown = 0.5;
			d.escaped = false;
			const before = { phase: d.phase, index: d.appearIndex, floor: d.bearingFloor, lines: d.log.length };
			d._enterClimax();
			let g = 0;
			while (d.state === 'CLIMAX' && g < 400) { H.step(1); g++; }
			const after = {
				phase: d.phase,
				index: d.appearIndex,
				floor: d.bearingFloor,
				known: d.bearingKnown,
				state: d.state,
				active: S.active,
				cooldown: d.cooldown,
				escaped: d.escaped,
				// "没死"最实在的证据：玩家坐标还在，还能继续走
				playerOk: Number.isFinite(P.pos.x) && Number.isFinite(P.pos.z),
			};
			// 它会不会回来？把冷却推完再看一眼。
			let g2 = 0;
			while (d.state === 'DORMANT' && g2 < 3000) { H.step(1); g2++; }
			const cameBack = d.state === 'MANIFEST' || !!d.pending;

			// ── 到家 ────────────────────────────────────────────
			d.cooldown = 1e9;
			d.pending = null;
			S.hide();
			d._spawn('R5', false);
			S.hide();
			d.state = 'DORMANT';
			d.cooldown = 1e9;

			const arriveR = m.CFG.safehouse.arriveRadius;
			// 先放在门外的位置，确认**不会**误触发
			P.warpTo(m.safehouse.x + arriveR + 12, m.safehouse.z);
			H.step(2);
			const outside = { dist: m.safehouse.dist, escaped: d.escaped };

			// 再走进去
			P.warpTo(m.safehouse.x + 1.4, m.safehouse.z);
			H.step(1);
			const inside = {
				dist: m.safehouse.dist,
				escaped: d.escaped,
				state: d.state,
				escapes: d.stats.escapes,
				stalkerActive: S.active,
				winHidden: document.getElementById('win').classList.contains('hidden'),
				winText: document.getElementById('win-text').textContent,
				winStats: document.getElementById('win-stats').textContent,
			};
			// 再推一会儿：结局画面不该被重复触发
			H.step(120);
			const later = {
				escapes: d.stats.escapes,
				winText: document.getElementById('win-text').textContent,
				escaped: d.escaped,
			};

			return { before, after, cameBack, outside, inside, later, arriveR };
		})()
	`);

	console.log(
		`  被追上：阶段 ${endgame.before.phase} → ${endgame.after.phase}，` +
			`距离阶梯 ${endgame.before.index} → ${endgame.after.index}，floor ` +
			`${endgame.before.floor} → ${endgame.after.floor}；它后来又出现了：${endgame.cameBack}`,
	);
	console.log(
		`  门外 ${endgame.outside.dist.toFixed(2)} m（半径 ${endgame.arriveR}）→ escaped=${endgame.outside.escaped}；` +
			`洞里 ${endgame.inside.dist.toFixed(2)} m → escaped=${endgame.inside.escaped}`,
	);

	check(
		'被追上 = 换一个阶段重新开始，而不是死（玩家坐标依然有效）',
		endgame.after.phase === endgame.before.phase + 1 && endgame.after.playerOk && endgame.after.escaped === false,
		`阶段 ${endgame.before.phase} → ${endgame.after.phase}，state=${endgame.after.state}`,
	);
	check(
		'它**没有死**：被抓住之后它还会回来（只是更近了）',
		endgame.cameBack && endgame.after.index > endgame.before.index,
		`阶梯 ${endgame.before.index} → ${endgame.after.index}，之后重新显形=${endgame.cameBack}`,
	);
	check(
		'被抓住是"被弄糊涂"，不是清零 —— 永久记住的那部分不受影响',
		endgame.after.floor === endgame.before.floor && endgame.after.known > 0 && endgame.after.known < 0.5,
		`floor ${endgame.before.floor} → ${endgame.after.floor}，known=0.5 → ${endgame.after.known.toFixed(3)}`,
	);
	check(
		'站在洞外（半径 + 12 m）**不会**误触发结局',
		endgame.outside.escaped === false,
		`距离 ${endgame.outside.dist.toFixed(2)} m > ${endgame.arriveR} → escaped=${endgame.outside.escaped}`,
	);
	check(
		'走进洞口半径内 → 到达结局',
		endgame.inside.escaped === true && endgame.inside.state === 'ESCAPED',
		`距离 ${endgame.inside.dist.toFixed(2)} m  state=${endgame.inside.state}`,
	);
	check(
		'到达结局后它退场（安全之后必须真的停下来）',
		endgame.inside.stalkerActive === false,
		`stalker.active=${endgame.inside.stalkerActive}`,
	);
	check(
		'结局面板出现，并带一个可以自己核对的结果',
		endgame.inside.winHidden === false && endgame.inside.winText.length > 0 && /秒/.test(endgame.inside.winStats),
		`"${endgame.inside.winText}" / "${endgame.inside.winStats}"`,
	);
	check(
		'结局只结算一次（继续更新也不会重复触发）',
		endgame.later.escapes === endgame.inside.escapes && endgame.later.winText === endgame.inside.winText,
		`escapes=${endgame.later.escapes}`,
	);

	console.log('\n══════ 控制台 ══════');
	if (errors.length === 0) console.log('  无错误');
	else errors.forEach((e) => console.log('  ERROR: ' + e));

	check('全程无 JS 报错', errors.length === 0, errors.length ? errors[0] : '0 条');

	console.log(`\n  hold-probe: ${pass} PASS / ${fail} FAIL`);
} finally {
	await browser.close();
	server.close();
}

process.exit(fail === 0 ? 0 : 1);
