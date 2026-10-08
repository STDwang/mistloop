// 音频探针（快速版）：读 src/config.js，解析估算信号链的 RMS 与频谱分布。
//
// 用途：改完 config.audio 后立刻自查，几毫秒出结果，不需要浏览器。
// 局限：是解析估算，不是真渲染。它算不准"多层滤波器串联的真实响应"。
//       所以改完滤波器一定要再用 audio-render 真渲染跑一次。
//
// 用法：
//   node tools/audio-probe.mjs            # 默认测 tension 0 / 0.25 / 0.5 / 0.75 / 1
//   node tools/audio-probe.mjs 0          # 只测最安静的状态
//
// 验收标准（这两个数就是"刺耳"的量化定义）：
//   2–4 kHz 能量占比 < 5%
//   >4 kHz 能量占比 < 0.5%
//   同时 RMS 落在 -34 ~ -19 dBFS

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(HERE, '..', 'src', 'config.js');

const src = readFileSync(CFG_PATH, 'utf8');
const m = src.match(/export const CFG = (\{[\s\S]*?\n\});/);
if (!m) {
	console.error('无法从 src/config.js 里解析出 CFG');
	process.exit(1);
}
// eslint-disable-next-line no-new-func
const CFG = new Function(`return (${m[1]})`)();
const A = CFG.audio;

const TARGET = { rmsDbMin: -34, rmsDbMax: -19, mid2kMax: 0.05, airMax: 0.005 };
const BW = 20000; // 带宽上限（Hz）

const lerp = (a, b, k) => a + (b - a) * k;
const elerp = (a, b, k) => a * Math.pow(b / a, k);

// 估算一层噪声经过"预着色 + 自身整形"后的等效带宽与增益。
// 白噪 RMS = 1/sqrt(3)；经过一段带宽为 W 的带通后，RMS ≈ sqrt(W/BW)/sqrt(3)。
function layerBand(lowCut, highCut) {
	const w = Math.max(0, highCut - lowCut);
	return Math.sqrt(Math.min(1, w / BW) / 3);
}

function analyze(t) {
	// 预着色：noiseHP ~ noiseLP
	const preLow = A.noiseHP;
	const preHigh = A.noiseLP;

	// 天气与张力按游戏进程耦合：phase 越深恐惧越高、天气越糟。
	// weatherBase + weatherPhase×(4 个阶段) + 半个 wave 的起伏 ≈ 全程上限。
	// 【为什么不再开一个 weather 维度】探针是护栏不是仿真器，
	// 一维扫描能覆盖"最常听到的状态 + 最坏状态"就够了。
	const weather = Math.min(
		1,
		CFG.atmosphere.weatherBase + CFG.atmosphere.weatherPhase * 4 * t + CFG.atmosphere.weatherWave * 0.5,
	);
	const rainW = Math.pow(weather, A.rainCurve);

	const layers = [];

	// 环境：预着色 ∩ ambientColor ∩ ambientFloor ∩ ambientLPF
	layers.push({
		name: 'ambient',
		gain: lerp(A.ambientGain[0], A.ambientGain[1], t),
		low: preLow,
		high: Math.min(preHigh, A.ambientColor, A.ambientFloor, elerp(A.ambientLPF[0], A.ambientLPF[1], t)),
	});

	// 风：预着色 ∩ 带通中心 ±(1/Q 带宽) ∩ windLowpass
	const wc = lerp(A.windCenter[0], A.windCenter[1], t);
	layers.push({
		name: 'wind',
		gain: lerp(A.windGain[0], A.windGain[1], t),
		low: Math.max(preLow, wc * 0.35),
		high: Math.min(preHigh, wc * 2.2, A.windLowpass),
	});

	// 呼吸
	const breathGain = t < A.breathStart ? 0 : lerp(A.breathGain[0], A.breathGain[1], (t - A.breathStart) / (1 - A.breathStart));
	if (breathGain > 0) {
		layers.push({ name: 'breath', gain: breathGain * 0.55, low: Math.max(preLow, 520 * 0.55), high: Math.min(preHigh, 520 * 1.9) });
	}

	// 女鬼呼吸（本次新增）：按 prox=1 的最坏情况计入（贴脸时的满增益）。
	// 频段同玩家呼吸的估法，但中心更低（350）、再被自己的低通收到 640。
	layers.push({
		name: 'ghost-breath',
		gain: A.ghostBreathGain,
		low: Math.max(preLow, A.ghostBreathCenter * 0.55),
		high: Math.min(preHigh, A.ghostBreathCenter * 1.9, A.ghostBreathLowpass),
	});

	// 耳语：带通中心 ±(1/Q) 的近似带宽
	const whGain = t < A.whisperStart ? 0 : lerp(A.whisperGain[0], A.whisperGain[1], (t - A.whisperStart) / (1 - A.whisperStart));
	if (whGain > 0) {
		const wbw = A.whisperCenter / A.whisperQ; // -3dB 带宽约 中心/Q
		layers.push({
			name: 'whisper',
			gain: whGain,
			low: Math.max(0, A.whisperCenter - wbw),
			high: Math.min(A.whisperCenter + wbw, A.whisperLowpass),
		});
	}

	// 雨 body（走 master，会被总低通闷 —— seg 里正常夹 masterHigh）
	layers.push({
		name: 'rain-body',
		gain: A.rainGain * rainW * (1 - A.rainTensionK * t),
		low: A.rainBodyHP,
		high: A.rainBodyLP,
	});

	// 雨 detail（走 fx，绕过两道低通墙）—— bypass: seg 不夹 masterHigh
	layers.push({
		name: 'rain-detail',
		gain: A.rainDetailGain * rainW * (1 - A.rainDetailTensionK * t),
		low: A.rainDetailHP,
		high: A.rainDetailLP,
		bypass: true,
	});

	// 雨打树叶（本次新增）：离散滴答的时间平均。
	// 占空比 duty = 滴答率 × 平均时长(≈0.033 s)；流 RMS = 峰值 × sqrt(duty)。
	// 低通护栏把频段截在 4 kHz（_burst 里的 min(4000, ...)），同样走 fx。
	const tickRate = A.rainTickRate[0] + (A.rainTickRate[1] - A.rainTickRate[0]) * rainW;
	const tickDuty = Math.min(1, tickRate * 0.033);
	layers.push({
		name: 'rain-tick',
		gain: A.rainTickLevel * Math.sqrt(tickDuty) * (1 - A.rainTickTensionK * t),
		low: 2300,
		high: 4000,
		bypass: true,
	});

	// 总输出低通：masterLPF 与 masterWall 串联
	const masterHigh = Math.min(elerp(A.masterLPF[0], A.masterLPF[1], t), A.masterWall);

	// 累加功率
	let power = 0;
	const detail = [];
	for (const L of layers) {
		const bandRms = layerBand(L.low, L.high);
		// 再过 master 低通：等效带宽取 min（bypass 层绕过这道墙）
		const effHigh = L.bypass ? L.high : Math.min(L.high, masterHigh);
		const effRms = L.gain * layerBand(L.low, effHigh) * A.headroom;
		power += effRms * effRms;
		detail.push({
			name: L.name + (L.bypass ? '(fx)' : ''),
			gain: +L.gain.toFixed(4),
			band: `${Math.round(L.low)}-${Math.round(L.high)}`,
			rmsDb: effRms > 0 ? +(20 * Math.log10(effRms)).toFixed(1) : -Infinity,
		});
	}

	// drone：正弦，频谱几乎全在 41/82 Hz
	const dGain = lerp(A.droneGain[0], A.droneGain[1], t);
	const droneAmp = dGain * 1.44 * A.headroom; // 4 条正弦，主两条 0.5+0.5，另两条 0.22+0.22
	const droneRms = (droneAmp / Math.SQRT2) * 0.62;
	power += droneRms * droneRms;
	detail.push({ name: 'drone', gain: +dGain.toFixed(4), band: '41/82', rmsDb: +(20 * Math.log10(droneRms)).toFixed(1) });

	const rms = Math.sqrt(power);
	const rmsDb = 20 * Math.log10(rms);

	// 频谱占比估算：
	// 所有噪声层的有效上限都被 masterHigh 压制，所以 >masterHigh 的部分接近 0
	// 分段：<250 / 250-1000 / 1k-2k / 2k-4k / >4k
	// bypass 层（fx 支路）不受总低通约束 —— seg 里也要跳过 masterHigh，
	// 否则雨 detail / 滴答的高频贡献会被系统性抹成 0（第一版就犯了）。
	const seg = (lo, hi) => {
		let p = 0;
		for (const L of layers) {
			const a = Math.max(lo, L.low);
			const b = Math.min(hi, L.high, L.bypass ? hi : masterHigh);
			if (b > a) {
				const r = L.gain * layerBand(a, b) * A.headroom;
				p += r * r;
			}
		}
		return p;
	};
	const noiseLow = seg(0, 250);
	const noiseMid = seg(250, 1000);
	const noise1k2k = seg(1000, 2000);
	const noise2k4k = seg(2000, 4000);
	const noiseAbove4k = seg(4000, 20000);
	const totalNoise = noiseLow + noiseMid + noise1k2k + noise2k4k + noiseAbove4k || 1;

	// 2-4k 与 >4k 的占比：把 drone 也算进总能量（它在低频，会稀释高频占比）
	const totalAll = (rms * rms) || 1;

	return {
		tension: t,
		weather: +weather.toFixed(2),
		rmsDb: +rmsDb.toFixed(2),
		mid2k: +(noise2k4k / totalAll).toFixed(4),
		air4k: +(noiseAbove4k / totalAll).toFixed(4),
		dark: +((noiseLow + droneRms * droneRms) / totalAll).toFixed(3),
		masterHigh: Math.round(masterHigh),
		detail,
	};
}

const args = process.argv.slice(2);
const tensions = args.length ? args.map(Number) : [0, 0.25, 0.5, 0.75, 1];

console.log('验收目标：');
console.log(`  RMS 在 ${TARGET.rmsDbMin} ~ ${TARGET.rmsDbMax} dBFS`);
console.log(`  2-4 kHz 占比 <= ${TARGET.mid2kMax}   <- "刺耳"指标`);
console.log(`  >4 kHz  占比 <= ${TARGET.airMax}   <- "嘶嘶声"指标`);
console.log('');

let allPass = true;
for (const t of tensions) {
	const r = analyze(t);
	const pass = r.rmsDb >= TARGET.rmsDbMin && r.rmsDb <= TARGET.rmsDbMax && r.mid2k <= TARGET.mid2kMax && r.air4k <= TARGET.airMax;
	if (!pass) allPass = false;
	console.log(`── tension ${t}  天气 ${r.weather} ${pass ? 'PASS' : 'FAIL'}`);
	console.log(`   RMS ${r.rmsDb} dBFS | 2-4k ${r.mid2k} | >4k ${r.air4k} | 暗度 ${r.dark} | 总低通 ${r.masterHigh} Hz`);
	console.log(`   分层: ${r.detail.map((d) => `${d.name}=${d.band}Hz@${d.rmsDb}dB`).join('  ')}`);
	console.log('');
}

console.log(allPass ? '估算通过。请再用 audio-render 真渲染复核。' : '有未达标项 —— 优先调滤波器而不是只降增益。');
process.exit(allPass ? 0 : 1);
