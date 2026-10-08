// 浏览器跳跃验证：接真键盘事件，拍跳跃过程的多帧截图。
//
// 【为什么光有 Node 探针不够】
// jump-probe.mjs 直接调 player.update()，绕开了整条真实链路：
//   keydown → input.onKeyDown → player.jump() → rAF 里的 update
// 这条链路上任何一环断了（Space 没进 onKeyDown、preventDefault 漏了、
// pause 状态下不更新、相机没跟着抬），Node 探针都是绿的。
// 这个项目已经因为"探针全过、浏览器白屏"吃过一次亏，所以必须跑真浏览器。
//
// 用法：node tools/jump-verify.mjs
// 前置：vite dev server 跑在 127.0.0.1:5199

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const URL = 'http://127.0.0.1:5199/?debug';
const OUT = 'out';
const CANDIDATES = [
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
	process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const exe = CANDIDATES.find((p) => p && existsSync(p));
if (!exe) {
	console.error('找不到 Chrome/Edge');
	process.exit(2);
}

const browser = await chromium.launch({
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
	],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.mist, { timeout: 45000 });
await page.waitForTimeout(2500);

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`);
	}
};

// 进入游戏并锁定鼠标（headless 下指针锁会失败，但我们只关心键盘链路）
await page.evaluate(() => document.getElementById('btn-start').click());
await page.waitForTimeout(900);
await page.evaluate(() => {
	// 停掉 rAF 驱动，改手动固定步长 —— headless 的虚拟时间会让物理抖动
	window.mist.pause(true);
});

console.log('\n══════ 1. 真实键盘事件 → 跳跃 ══════');
{
	// 先站稳
	await page.evaluate(() => {
		const p = window.mist.player;
		for (let i = 0; i < 8; i++) p.update(1 / 60);
	});
	const before = await page.evaluate(() => ({
		y: window.mist.player.pos.y,
		ground: window.mist.player.pos.y, // 已贴地
		airborne: window.mist.player.airborne,
	}));
	check('起跳前在地面上', before.airborne === false);

	// 用真实 keydown。注意前面所有代码都没碰过 player.jump()。
	await page.keyboard.press('Space');
	const queued = await page.evaluate(() => window.mist.player._wantJump);
	check('Space 触发了跳跃请求（keydown 链路通）', queued === true);

	// 手动推进并记录相机高度曲线
	const profile = await page.evaluate(() => {
		const m = window.mist;
		const p = m.player;
		const camYs = [];
		const baseY = m.engine.camera.position.y;
		let landedAt = -1;
		let landed = false;
		const origLand = p.onLand;
		p.onLand = (f) => {
			landed = true;
			window.__landFall = f;
		};
		for (let i = 0; i < 120; i++) {
			p.update(1 / 60);
			camYs.push(m.engine.camera.position.y);
			if (landed && landedAt < 0) landedAt = i;
			if (landed) break;
		}
		p.onLand = origLand;
		const ground = p.pos.y; // 落地后贴地
		return {
			minY: Math.min(...camYs),
			maxY: Math.max(...camYs),
			baseY,
			groundY: ground,
			apexClearance: Math.max(...camYs) - ground,
			landedAt,
			frames: camYs.length,
			landFall: window.__landFall,
			eye: m.CFG.player.eye,
			airborne: p.airborne,
			grounded: Math.abs(p.pos.y - ground) < 1e-9,
			bobOffset: p._bobOffset,
		};
	});

	console.log(`  相机 y: ${profile.baseY.toFixed(3)} → 峰值 ${profile.maxY.toFixed(3)}`);
	console.log(`  峰值离地 ${profile.apexClearance.toFixed(3)} m，${profile.frames} 帧后落地`);
	console.log(`  落地 onLand fall = ${profile.landFall === undefined ? '未触发' : profile.landFall.toFixed(3)}`);

	check('相机确实抬起来了（不是只动了 pos.y）', profile.maxY > profile.baseY + 0.8, `Δ=${(profile.maxY - profile.baseY).toFixed(3)} m`);
	check('相机峰值离地 ≈ 眼睛高度 + 跳跃高度', profile.apexClearance > profile.eye + 0.9, `${profile.apexClearance.toFixed(3)} m（eye=${profile.eye}）`);
	check('相机最低点不低于眼睛高度', profile.minY >= profile.groundY + profile.eye - 1e-9, `min=${(profile.minY - profile.groundY).toFixed(3)}`);
	check('落地回调被真实触发', profile.landFall !== undefined && profile.landFall > 0.9, `fall=${profile.landFall}`);
	check('落地后 airborne=false', profile.airborne === false);
	check('落地后严格贴地', profile.grounded === true);
	check('落地时相机回到眼睛高度', Math.abs(profile.minY - (profile.groundY + profile.eye)) < 0.02);
}

console.log('\n══════ 2. 腾空期间头部摆动必须归零 ══════');
{
	const r = await page.evaluate(() => {
		const p = window.mist.player;
		// 让人在走动，这样 bobPhase 在转
		window.mist.input.keys.add('KeyW');
		for (let i = 0; i < 60; i++) p.update(1 / 60);
		const bobsWalk = [];
		for (let i = 0; i < 20; i++) {
			p.update(1 / 60);
			bobsWalk.push(Math.abs(p._bobOffset));
		}
		const walkMax = Math.max(...bobsWalk);

		// 起跳，然后看 bob
		p.jump();
		p.update(1 / 60); // 消费请求
		const bobsAir = [];
		while (p.airborne) {
			p.update(1 / 60);
			if (p.airborne) bobsAir.push(Math.abs(p._bobOffset));
		}
		window.mist.input.keys.delete('KeyW');
		return { walkMax, airMax: bobsAir.length ? Math.max(...bobsAir) : -1, airFrames: bobsAir.length };
	});
	console.log(`  走路时 bob 峰值 ${r.walkMax.toFixed(5)}，腾空时 ${r.airMax.toFixed(5)}（${r.airFrames} 帧）`);
	check('走路时确实有头部摆动', r.walkMax > 0.005, `${r.walkMax.toFixed(5)}`);
	check('腾空时头部摆动完全归零', r.airMax === 0, `airMax=${r.airMax}`);
}

console.log('\n══════ 3. 截图：跳跃的四个瞬间 ══════');
{
	await page.evaluate(() => {
		const m = window.mist;
		const p = m.player;
		// 放到路上，朝切线方向，方便看出高度变化
		const T = m.CFG.world.tile;
		const H = [
			[2, 0.026, 0.0],
			[3, 0.014, 1.9],
		];
		const center = (t) => {
			let u = 0.5 + 0.235 * Math.cos(2 * Math.PI * t);
			let v = 0.5 + 0.208 * Math.sin(2 * Math.PI * t);
			for (const [k, a, ph] of H) {
				u += a * Math.cos(2 * Math.PI * k * t + ph);
				v += a * Math.sin(2 * Math.PI * k * t + ph * 0.7);
			}
			return { u, v };
		};
		const t0 = 0.55;
		const c = center(t0);
		p.warpTo(c.u * T, c.v * T);
		const dt = 0.001;
		const a = center(t0 - dt);
		const b = center(t0 + dt);
		const tx = (b.u - a.u) * T;
		const tz = (b.v - a.v) * T;
		p.yaw = Math.atan2(-tx, -tz);
		p.pitch = -0.12;
		m.forest.refresh(p.pos.x, p.pos.z, true);
		m.undergrowth.refresh(p.pos.x, p.pos.z, true);
		m.atmosphere.update(0.016, p.pos.x, p.pos.y, p.pos.z);
	});
	await page.waitForTimeout(500);
	await page.screenshot({ path: `${OUT}/jump-1-ground.png` });

	// 起跳并推到接近顶点
	await page.evaluate(() => {
		const p = window.mist.player;
		p.jump();
		let frame = 0;
		// 【踩坑】jump() 只是投递请求，vy 要等下一帧才变成正数。
		// 初版在循环体里先 update 再判断 vy <= 0 —— 但那一帧 vy 才刚被设成
		// jumpImpulse 减去一个 dt 的重力（≈4.44），仍然远大于 0，
		// 判断条件写成 `if (p.vy <= 0) break` 本身没错，错的是我在
		// update 之前就多做了一次判断。改成：先无条件走一帧启动，
		// 然后一直走到 vy 由正转负 —— 那才是真正的顶点。
		p.update(1 / 60); // 消费跳跃请求，vy 变正
		while (p.airborne && frame < 200) {
			p.update(1 / 60);
			frame++;
			if (p.vy <= 0) break; // vy 由正转负 = 顶点
		}
		window.__apexFrame = frame;
		window.__apexVy = p.vy;
	});
	await page.waitForTimeout(250);
	await page.screenshot({ path: `${OUT}/jump-2-apex.png` });
	const apex = await page.evaluate(() => ({
		frame: window.__apexFrame,
		vy: window.__apexVy,
		airborne: window.mist.player.airborne,
	}));
	console.log(`  顶点在第 ${apex.frame} 帧，vy=${apex.vy.toFixed(3)}，airborne=${apex.airborne}`);
	check('截图时确实处在腾空的顶点', apex.airborne === true && Math.abs(apex.vy) < 0.25, `vy=${apex.vy.toFixed(3)}`);
	check('顶点在第 30 帧附近（理论 4.6/9.8 = 0.47 s ≈ 28 帧）', apex.frame >= 24 && apex.frame <= 34, `第 ${apex.frame} 帧`);

	// 落到一半
	await page.evaluate(() => {
		const p = window.mist.player;
		let frame = 0;
		while (p.airborne && frame < 200) {
			p.update(1 / 60);
			frame++;
			if (p.vy < -3.0) break;
		}
	});
	await page.waitForTimeout(250);
	await page.screenshot({ path: `${OUT}/jump-3-falling.png` });

	// 落到地面
	await page.evaluate(() => {
		const p = window.mist.player;
		let frame = 0;
		while (p.airborne && frame < 200) {
			p.update(1 / 60);
			frame++;
		}
		window.mist.forest.refresh(p.pos.x, p.pos.z, true);
		window.mist.undergrowth.refresh(p.pos.x, p.pos.z, true);
	});
	await page.waitForTimeout(250);
	await page.screenshot({ path: `${OUT}/jump-4-landed.png` });
	const landed = await page.evaluate(() => ({
		airborne: window.mist.player.airborne,
		y: window.mist.player.pos.y,
		camY: window.mist.engine.camera.position.y,
	}));
	check('截图结束时已落地', landed.airborne === false);
}

console.log('\n══════ 4. 帮助表已更新 ══════');
{
	const rows = await page.evaluate(() => {
		const t = document.querySelector('#help table');
		return Array.from(t.querySelectorAll('tr')).map((tr) =>
			Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()),
		);
	});
	console.log('  ' + rows.map((r) => r.join(' → ')).join('\n  '));
	const hasSpace = rows.some((r) => r[0] === 'Space' && /跳跃/.test(r[1]));
	check('操作表里有 Space 跳跃一行', hasSpace);
}

console.log('\n══════ 控制台 ══════');
if (errors.length === 0) console.log('  无错误');
else errors.slice(0, 10).forEach((e) => console.log('  ERROR: ' + e));

console.log(`\n══════ 结果：${pass} PASS / ${fail} FAIL ══════\n`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
