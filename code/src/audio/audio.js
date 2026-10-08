// 全程序化音频引擎。不加载任何音频文件。
//
// 一个数驱动整个声景：tension。
//   tension = max(恐惧值, 1 - 身影距离/80)
//
// 映射表见 materials/AUDIO-DESIGN.md。这里实现它与之一一对应。
//
// 四条铁律（违反会立刻毁掉氛围）：
//   ① 增益变化一律 setTargetAtTime。直接赋值 .value 会咔哒。
//   ② 环境声是"被闷住"，不是"被静音" —— 削减主要靠低通截止频率。
//   ③ 显形前 0.4 秒必须有声音预兆（由 Director 调 oneShot('crack')）。
//   ④ 【最关键】每个噪声源必须先做自身波段整形再进总线。
//      raw 白噪 = 电视雪花，2–6 kHz 又正好是人耳最敏感的区间。
//      第一版就是漏了这条，实测 peak -3 dBFS 的"沙沙声"，听感就是纯噪音。
//      改动信号链前后都要跑 tools/audio-probe.mjs（离线复算 + 频谱测量）。

const CURVE_N = 1024;

// 把若干高斯峰拟合的脉冲烘进 WaveShaper 的 curve。
// 用波形整形而不是定时器调度：没有累积漂移，而且改速率是连续的。
function shapedPulse(peaks, floor = 0.08) {
	const raw = (th) => {
		let s = 0;
		for (const [mu, amp, sig] of peaks) {
			const d = (th - mu) / sig;
			s += amp * Math.exp(-d * d);
		}
		return s;
	};
	const c = new Float32Array(CURVE_N);
	let max = 0;
	for (let i = 0; i < CURVE_N; i++) {
		const th = i / (CURVE_N - 1);
		const v = Math.max(0, raw(th) - floor);
		c[i] = v;
		if (v > max) max = v;
	}
	if (max > 0) {
		for (let i = 0; i < CURVE_N; i++) c[i] /= max;
	}
	return c;
}

const BREATH_CURVE = shapedPulse([
	[0.06, 1.0, 0.045], // 吸气：短促
	[0.34, 0.55, 0.15], // 呼气：长而缓
]);

const HEART_CURVE = shapedPulse([
	[0.05, 1.0, 0.045], // lub
	[0.31, 0.68, 0.055], // dub
]);

// 女鬼的呼吸。与玩家的 BREATH_CURVE 同构但处处反着：
// 吸气更满（0.10 vs 0.06 处才到峰），呼气拖得反常地长
//（0.46 处、σ 0.24 —— 玩家的呼气在 0.34 处、σ 0.15 就结束了）。
// "被拉住的呼气"是恐怖听觉里最经典的一种错位：吸得动，呼不完。
const GHOST_BREATH_CURVE = shapedPulse([
	[0.1, 1.0, 0.07], // 吸：慢而满
	[0.46, 0.72, 0.24], // 呼：拖得很长，像在水下
]);

export class AudioEngine {
	constructor(cfg) {
		this.cfg = cfg;
		this.ctx = null;
		this.ready = false;
		this.tension = 0;
		this.weather = 0;
		this._crackTimer = 20;
		// 动物环境声的骰子（见 update 里的设计立场注释）
		this._crowTimer = 12;
		this._insectTimer = 6;
		// 雨打树叶的滴答调度器（update 里按天气驱动）
		this._tickTimer = 1.5;
		// 女鬼呼吸的接近度缓存。setGhost 在 audio.init 之前也可能被调
		//（director 每帧都喂），先把值存下来，ready 之后增益自然跟上。
		this._ghostProx = 0;
		this._lastTension = 0;
		this._footAlt = false; // 左右脚交替的开关（见 footstep 的 ±6%）
	}

	// 必须在用户手势之后调用（浏览器自动播放策略）。
	// testCtx：离线渲染用的 AudioContext 注入口（OfflineAudioContext）。
	// 探针用它对真实合成链做确定性频谱分析 —— 传了就不新建实时上下文。
	init(testCtx = null) {
		if (this.ctx) {
			if (this.ctx.state === 'suspended') this.ctx.resume();
			return;
		}
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return;
		const ctx = testCtx || new AC();
		this.ctx = ctx;
		const A = this.cfg.audio;

		// ── 总线 ────────────────────────────────────────────────
		this.master = ctx.createGain();
		this.master.gain.value = A.headroom;

		this.masterLF = ctx.createBiquadFilter();
		this.masterLF.type = 'lowpass';
		this.masterLF.frequency.value = A.masterLPF[0];
		this.masterLF.Q.value = 0.7;

		// 第二道固定低通。与 masterLF 串联成约 24 dB/oct 的"墙"。
		// 单道低通在截止频率两个八度外只衰减 24 dB，1–2 kHz 会漏出 15% 能量；
		// 串联后同样位置能压到 5% 以下，而 60 Hz 附近只多损失约 2 dB。
		this.masterWall = ctx.createBiquadFilter();
		this.masterWall.type = 'lowpass';
		this.masterWall.frequency.value = A.masterWall;
		this.masterWall.Q.value = 0.5;

		this.comp = ctx.createDynamicsCompressor();
		this.comp.threshold.value = -18;
		this.comp.knee.value = 22;
		this.comp.ratio.value = 6;
		this.comp.attack.value = 0.004;
		this.comp.release.value = 0.25;

		this.master.connect(this.masterLF);
		this.masterLF.connect(this.masterWall);
		this.masterWall.connect(this.comp);
		this.comp.connect(ctx.destination);

		// ── 一次性音效支路（fx）─────────────────────────────────
		// 绕过 masterLF/masterWall 直达压缩器。
		// 【为什么】那两道低通是为连续底噪设计的"墙"（文档原话：
		// "此时进来的信号已经很暗了，它只需兜底"）。一次性音效是亮瞬态，
		// 有自己的每声部低通护栏（_burst 里的 lp ≤ 4000），不需要墙，
		// 而且墙会把脚步碎裂/沙沙尾削掉约 12 dB —— 亮通道做了也白做。
		// 张力升高时世界变闷（masterLPF 下移）只该闷"环境"，
		// 你自己的脚步必须始终听得见 —— 这正是"环境声变小"设计的另一面。
		// 增益与 master 相同：表里的峰值增益规格保持成立。
		this.fx = ctx.createGain();
		this.fx.gain.value = A.headroom;
		this.fx.connect(this.comp);

		// ── 噪声源 ──────────────────────────────────────────────
		this.noiseBuffer = this._makeNoise(ctx, 4);

		// ── 环境底噪：白噪 → 固定着色低通 → 可移动低通 → 增益 ────
		// 三段串联低通而不是两段：12 dB/oct 的单道低通在截止频率以上两个八度
		// 只衰减 24 dB，而 1–2 kHz 恰好在人耳敏感区（等响曲线 3 kHz 见峰，1–2k 也不低）。
		// 实测两段串联时 1–2 kHz 仍占 17% 能量，听感就是"沙沙的底噪"。
		// 加到三段后同样位置降到 5% 以下。
		this.ambientGain = ctx.createGain();
		this.ambientGain.gain.value = A.ambientGain[0];
		this.ambientLPF = ctx.createBiquadFilter();
		this.ambientLPF.type = 'lowpass';
		this.ambientLPF.frequency.value = A.ambientLPF[0];
		this.ambientLPF.Q.value = 0.6;
		this.ambientLPF.connect(this.ambientGain);
		this.ambientGain.connect(this.master);
		const { src: ambSrc, out: ambOut } = this._noise();
		const ambBody = ctx.createBiquadFilter();
		ambBody.type = 'lowpass';
		ambBody.frequency.value = A.ambientColor;
		ambBody.Q.value = 0.5;
		// 第三段：再削一阶滚降，把可移动低通挡不住的残留压掉
		const ambFloor = ctx.createBiquadFilter();
		ambFloor.type = 'lowpass';
		ambFloor.frequency.value = A.ambientFloor;
		ambFloor.Q.value = 0.5;
		ambOut.connect(ambBody);
		ambBody.connect(ambFloor);
		ambFloor.connect(this.ambientLPF);
		ambSrc.start();
		// 【踩坑】这里曾经有两行 ambSrc.start() —— 是某次改音频时手滑复制的。
		// 第二次 start 会直接抛 InvalidStateError，把整个 requestAnimationFrame
		// 循环打断：画面冻结、玩家动不了。而音频探针没抓到它，因为
		// audio-probe 是"照着 audio.js 手抄了一遍接线"，不是 import 真文件 ——
		// 手抄的那份没有这个 bug，真文件有。教训：探针必须 import 源码。

		// ── 风：带通噪声 + 极慢 LFO ─────────────────────────────
		// 带通之后再串一道低通（windLowpass），削掉带通高频侧的裙摆。
		// Q=0.7 的带通在 340 Hz 中心时，2 kHz 以上只衰减约 20 dB，不够。
		this.windGain = ctx.createGain();
		this.windGain.gain.value = A.windGain[0];
		this.windGain.connect(this.master);
		const { src: windSrc, out: windOut } = this._noise();
		this.windBP = ctx.createBiquadFilter();
		this.windBP.type = 'bandpass';
		this.windBP.frequency.value = A.windCenter[0];
		this.windBP.Q.value = 0.7;
		const windLP = ctx.createBiquadFilter();
		windLP.type = 'lowpass';
		windLP.frequency.value = A.windLowpass;
		windLP.Q.value = 0.5;
		windOut.connect(this.windBP);
		this.windBP.connect(windLP);
		windLP.connect(this.windGain);
		windSrc.start();
		this.windLFO = ctx.createOscillator();
		this.windLFO.frequency.value = 0.07;
		this.windDepth = ctx.createGain();
		this.windDepth.gain.value = 150;
		this.windLFO.connect(this.windDepth);
		this.windDepth.connect(this.windBP.frequency);
		this.windLFO.start();

		// ── 雨：body（暗，走 master）+ detail（亮，走 fx）────────
		//
		// 【为什么雨要拆两路 —— 这条改动值得单独解释】
		//
		// 需求是"小雨淅淅沥沥"。淅淅沥沥在**频谱**上的意思是"细密偏高的
		// 沙沙"，不是"低沉的呼噜"。但连续层全部走 master，而 master 上挂着
		// masterLPF(2400→500) + masterWall(1400) 两道低通 —— 那道墙是
		// "环境声不刺耳"的根基，绝对不能为了雨去动它。
		//
		// 于是单路的雨只有两个选择，都不对：
		//   走 master → 上限被钉在 1400 Hz，永远是"闷沙"，做不出淅淅沥沥；
		//   走 fx     → 2–4 kHz 直接超标，就是上一版"全是噪音"的病根。
		//
		// 拆成两路各走各的规矩，是唯一同时满足两者的办法：
		//   body   → master：雨幕的低频体量。占能量大头，被墙闷着，安全。
		//   detail → fx    ：1.5–4.2 kHz 的"雨脚"。增益压得极低，
		//                    它给雨**定音色**，不给雨加音量。
		// body/detail 的比例是调出来的：audio-probe 的 2–4k 占比必须仍 < 5%。
		// 换句话说，detail 的增益上限不是听感定的，是那条验收线定的。
		this.rainGain = ctx.createGain();
		this.rainGain.gain.value = 0;
		this.rainGain.connect(this.master);
		const { src: rainSrc, out: rainOut } = this._noise();
		const rainHP = ctx.createBiquadFilter();
		rainHP.type = 'highpass';
		rainHP.frequency.value = A.rainBodyHP;
		const rainLP = ctx.createBiquadFilter();
		rainLP.type = 'lowpass';
		rainLP.frequency.value = A.rainBodyLP;
		rainLP.Q.value = 0.5;
		rainOut.connect(rainHP);
		rainHP.connect(rainLP);
		rainLP.connect(this.rainGain);
		rainSrc.start();

		// detail：唯一一条走亮原料的**连续层**。
		// 每加一点增益都要回来跑 audio-probe —— 这条通道离"刺耳"最近。
		this.rainDetailGain = ctx.createGain();
		this.rainDetailGain.gain.value = 0;
		this.rainDetailGain.connect(this.fx);
		const { src: rainDSrc, out: rainDOut } = this._noise(true);
		const rainDHP = ctx.createBiquadFilter();
		rainDHP.type = 'highpass';
		rainDHP.frequency.value = A.rainDetailHP;
		const rainDLP = ctx.createBiquadFilter();
		rainDLP.type = 'lowpass';
		rainDLP.frequency.value = A.rainDetailLP;
		rainDLP.Q.value = 0.5;
		rainDOut.connect(rainDHP);
		rainDHP.connect(rainDLP);
		rainDLP.connect(this.rainDetailGain);
		rainDSrc.start();

		// ── 女鬼呼吸：与玩家呼吸同构的第二条链，但处处反着 ────
		// 结构完全复用玩家呼吸的验证过的形状（暗噪声 → 带通 → 低通
		// → VCA ← 整形 LFO），换的只有参数与曲线：
		//   频段更低（350 vs 520 Hz）—— "冷"在声学上就是低；
		//   速率更慢且随接近度变慢（0.21→0.13，玩家是 0.22→1.05 越怕越快）；
		//   呼气拖得反常地长（GHOST_BREATH_CURVE）。
		// 增益由 setGhost(接近度 × 显形不透明度) 驱动，不进 setTension：
		// 它是"它"的声音，不是"你"的声音。看不见它的时候，也不该听见它。
		this.ghostBreathGain = ctx.createGain();
		this.ghostBreathGain.gain.value = 0;
		this.ghostBreathGain.connect(this.master);
		this.ghostBreathVCA = ctx.createGain();
		this.ghostBreathVCA.gain.value = 0;
		this.ghostBreathVCA.connect(this.ghostBreathGain);
		const { src: gbSrc, out: gbOut } = this._noise();
		const gbBP = ctx.createBiquadFilter();
		gbBP.type = 'bandpass';
		gbBP.frequency.value = A.ghostBreathCenter;
		gbBP.Q.value = A.ghostBreathQ;
		const gbLP = ctx.createBiquadFilter();
		gbLP.type = 'lowpass';
		gbLP.frequency.value = A.ghostBreathLowpass;
		gbLP.Q.value = 0.5;
		gbOut.connect(gbBP);
		gbBP.connect(gbLP);
		gbLP.connect(this.ghostBreathVCA);
		gbSrc.start();

		this.ghostBreathLFO = ctx.createOscillator();
		this.ghostBreathLFO.type = 'sawtooth';
		this.ghostBreathLFO.frequency.value = A.ghostBreathRate[0];
		this.ghostBreathShape = ctx.createWaveShaper();
		this.ghostBreathShape.curve = GHOST_BREATH_CURVE;
		this.ghostBreathDepth = ctx.createGain();
		this.ghostBreathDepth.gain.value = 1;
		this.ghostBreathLFO.connect(this.ghostBreathShape);
		this.ghostBreathShape.connect(this.ghostBreathDepth);
		this.ghostBreathDepth.connect(this.ghostBreathVCA.gain);
		this.ghostBreathLFO.start();

		// ── 呼吸：带通噪声，增益被整形 LFO 驱动 ─────────────────
		// 带通 + 低通。单靠 Q=1.1 的带通，520 Hz 中心的高频裙摆仍然明显。
		this.breathGain = ctx.createGain();
		this.breathGain.gain.value = 0;
		this.breathGain.connect(this.master);
		this.breathVCA = ctx.createGain();
		this.breathVCA.gain.value = 0;
		this.breathVCA.connect(this.breathGain);
		const { src: breathSrc, out: breathOut } = this._noise();
		const breathBP = ctx.createBiquadFilter();
		breathBP.type = 'bandpass';
		breathBP.frequency.value = 520;
		breathBP.Q.value = 1.1;
		const breathLP = ctx.createBiquadFilter();
		breathLP.type = 'lowpass';
		breathLP.frequency.value = A.breathLowpass;
		breathLP.Q.value = 0.5;
		breathOut.connect(breathBP);
		breathBP.connect(breathLP);
		breathLP.connect(this.breathVCA);
		breathSrc.start();

		this.breathLFO = ctx.createOscillator();
		this.breathLFO.type = 'sawtooth';
		this.breathLFO.frequency.value = A.breathRate[0];
		this.breathShape = ctx.createWaveShaper();
		this.breathShape.curve = BREATH_CURVE;
		this.breathDepth = ctx.createGain();
		this.breathDepth.gain.value = 1;
		this.breathLFO.connect(this.breathShape);
		this.breathShape.connect(this.breathDepth);
		this.breathDepth.connect(this.breathVCA.gain);
		this.breathLFO.start();

		// ── 心跳：52 Hz 正弦，增益被双峰整形 LFO 驱动 ───────────
		this.heartGain = ctx.createGain();
		this.heartGain.gain.value = 0;
		this.heartGain.connect(this.master);
		this.heartVCA = ctx.createGain();
		this.heartVCA.gain.value = 0;
		this.heartVCA.connect(this.heartGain);
		const heartOsc = ctx.createOscillator();
		heartOsc.type = 'sine';
		heartOsc.frequency.value = 52;
		const heartLP = ctx.createBiquadFilter();
		heartLP.type = 'lowpass';
		heartLP.frequency.value = A.heartLowpass;
		heartOsc.connect(heartLP);
		heartLP.connect(this.heartVCA);
		heartOsc.start();

		this.heartLFO = ctx.createOscillator();
		this.heartLFO.type = 'sawtooth';
		this.heartLFO.frequency.value = A.heartBPM[0] / 60;
		this.heartShape = ctx.createWaveShaper();
		this.heartShape.curve = HEART_CURVE;
		this.heartDepth = ctx.createGain();
		this.heartDepth.gain.value = 0.9;
		this.heartLFO.connect(this.heartShape);
		this.heartShape.connect(this.heartDepth);
		this.heartDepth.connect(this.heartVCA.gain);
		this.heartLFO.start();

		// ── 次声代理：双正弦拍频。小音箱听不到 41 Hz，所以叠一层八度 ──
		this.droneGain = ctx.createGain();
		this.droneGain.gain.value = A.droneGain[0];
		this.droneGain.connect(this.master);
		const droneLP = ctx.createBiquadFilter();
		droneLP.type = 'lowpass';
		droneLP.frequency.value = A.droneLowpass;
		droneLP.connect(this.droneGain);
		this.drones = [];
		for (const [f, g] of [
			[41.2, 0.5],
			[41.9, 0.5],
			[82.4, 0.22],
			[83.9, 0.22],
		]) {
			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.value = f;
			const gain = ctx.createGain();
			gain.gain.value = g;
			o.connect(gain);
			gain.connect(droneLP);
			o.start();
			this.drones.push(o);
		}

		// ── 耳语：高 Q 带通噪声 + 慢扫频 ────────────────────────
		// Q=6 的谐振峰本身就很"锐"，再串一道低通把 2 kHz 以上压掉。
		this.whisperGain = ctx.createGain();
		this.whisperGain.gain.value = 0;
		this.whisperGain.connect(this.master);
		const { src: wSrc, out: wOut } = this._noise();
		this.whisperBP = ctx.createBiquadFilter();
		this.whisperBP.type = 'bandpass';
		this.whisperBP.frequency.value = A.whisperCenter;
		this.whisperBP.Q.value = A.whisperQ;
		const whisperLP = ctx.createBiquadFilter();
		whisperLP.type = 'lowpass';
		whisperLP.frequency.value = A.whisperLowpass;
		whisperLP.Q.value = 0.5;
		wOut.connect(this.whisperBP);
		this.whisperBP.connect(whisperLP);
		whisperLP.connect(this.whisperGain);
		wSrc.start();
		this.whisperLFO = ctx.createOscillator();
		this.whisperLFO.frequency.value = 0.21;
		this.whisperDepth = ctx.createGain();
		this.whisperDepth.gain.value = 260; // 扫频幅度：中心 620 Hz 上下摆 ±260，不越界
		this.whisperLFO.connect(this.whisperDepth);
		this.whisperDepth.connect(this.whisperBP.frequency);
		this.whisperLFO.start();

		this.ready = true;
		this.setTension(0, 0);
	}

	_makeNoise(ctx, seconds) {
		const len = Math.floor(ctx.sampleRate * seconds);
		const buf = ctx.createBuffer(1, len, ctx.sampleRate);
		const d = buf.getChannelData(0);
		// 【为什么每步都要换相位】
		// 每个 _noise() 调用都从 buffer 的 t=0 开始播（src.start(t0) 不带 offset），
		// 而 buffer 是**同一个**对象。于是两次脚步读到的是同一段噪声的同一段相位 ——
		// 步与步之间的差异只剩增益和中心频率的 ±15%，波形本身高度重合。
		// 探针实测路面两步相关 0.985（阈值 0.98），正是这个"伪随机"被抓出来了：
		// 随机只加在了参数上，没有加在**原料**上。
		// 每次生成时随机旋转起始相位（纯循环移位，不改变白噪的统计特性），
		// 后续的交叉淡化仍然成立，所以循环点依然无咔哒。
		for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
		const rot = Math.floor(Math.random() * len);
		if (rot > 0) {
			const tmp = d.slice(0, rot);
			d.copyWithin(0, rot);
			d.set(tmp, len - rot);
		}
		// 交叉淡化首尾，消除循环点上的咔哒
		const fade = Math.floor(ctx.sampleRate * 0.15);
		for (let i = 0; i < fade; i++) {
			const t = i / fade;
			d[i] = d[i] * t + d[len - fade + i] * (1 - t);
		}
		return buf;
	}

	// 所有噪声源的唯一出口。这里做"预着色"——
	// 用一道高通 + 一道低通把白噪削成"雾声原料"（约 90–800 Hz），
	// 各层再在这个原料上做自己的整形。
	//
	// 【为什么必须有这一步】
	//   Web Audio 的 BiquadFilter 滚降是 12 dB/oct。想靠低通把 1–2 kHz 压到听不出，
	//   截止频率得拉到 400 Hz —— 那时 60–200 Hz 的"空气感"也一起没了。
	//   带通两端一起切，只保留需要的窄带，代价小得多。
	//   实测：裸白噪 1–2 kHz 占 22%，预着色后降到 3% 以下。
	//
	// 返回 { src, out }：src 是 BufferSource（调用方要 start/stop 它），
	// out 是预着色后的输出端（调用方从这里 connect 到自己的滤镜）。
	// 【不要】把它简化成"只返回 out" —— 那样就没人能 stop 掉 BufferSource，
	// 每个一次性音效都会泄漏一个永久播放的噪声源。
	_noise(bright = false) {
		const ctx = this.ctx;
		const A = this.cfg.audio;
		const src = ctx.createBufferSource();
		src.buffer = this.noiseBuffer;
		src.loop = true;
		// 记账：可循环源在 stop() 前一直占着节点，是"节点数堆积"的主要来源。
		src.onended = () => {
			this._live = Math.max(0, (this._live || 0) - 1);
		};
		this._live = (this._live || 0) + 1;
		const hp = ctx.createBiquadFilter();
		hp.type = 'highpass';
		hp.frequency.value = A.noiseHP;
		hp.Q.value = 0.5;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		// 双通道预着色：连续层走暗通道（noiseLP，防刺耳的根基），
		// 高频瞬态走亮通道（noiseLPBright，脚步碎裂/折断的频段在 1.5 kHz 以上，
		// 暗原料在 780 Hz 就没了 —— 不分通道它们全是闷响）。见 config.js 的注释。
		lp.frequency.value = bright ? A.noiseLPBright : A.noiseLP;
		lp.Q.value = 0.5;
		src.connect(hp);
		hp.connect(lp);
		return { src, out: lp };
	}

	// 张力 → 全部参数。这是整个音频层的唯一入口。
	setTension(t, exertion = 0) {
		if (!this.ready) return;
		this.tension = t;
		const A = this.cfg.audio;
		const ctx = this.ctx;
		const now = ctx.currentTime;
		const tau = A.smooth;
		const lerp = (a, b, k) => a + (b - a) * k;
		// 频率用指数插值：听感上才是"线性"的
		const elerp = (a, b, k) => a * Math.pow(b / a, k);

		this.ambientGain.gain.setTargetAtTime(lerp(A.ambientGain[0], A.ambientGain[1], t), now, tau);
		this.ambientLPF.frequency.setTargetAtTime(elerp(A.ambientLPF[0], A.ambientLPF[1], t), now, tau);
		this.masterLF.frequency.setTargetAtTime(elerp(A.masterLPF[0], A.masterLPF[1], t), now, tau);
		this.windGain.gain.setTargetAtTime(lerp(A.windGain[0], A.windGain[1], t), now, tau);
		// 风中心频率随张力下移：远处风声"沉"下去，像被什么压住了
		this.windBP.frequency.setTargetAtTime(lerp(A.windCenter[0], A.windCenter[1], t), now, tau);
		this.droneGain.gain.setTargetAtTime(lerp(A.droneGain[0], A.droneGain[1], t), now, tau);

		// 呼吸：张力 + 用力程度取较大者（逃跑让你更响）
		const bt = Math.max(t, exertion * 0.85);
		const breathAmt = Math.max(0, (bt - A.breathStart) / (1 - A.breathStart));
		this.breathGain.gain.setTargetAtTime(
			lerp(A.breathGain[0], A.breathGain[1], Math.min(1, breathAmt)),
			now,
			tau,
		);
		this.breathLFO.frequency.setTargetAtTime(
			lerp(A.breathRate[0], A.breathRate[1], Math.min(1, bt + exertion * 0.3)) + exertion * 0.12,
			now,
			0.5,
		);

		const ht = Math.max(0, (t - A.heartStart) / (1 - A.heartStart));
		this.heartGain.gain.setTargetAtTime(lerp(A.heartGain[0], A.heartGain[1], Math.min(1, ht)), now, tau);
		const bpm = lerp(A.heartBPM[0], A.heartBPM[1], t) + exertion * 16;
		this.heartLFO.frequency.setTargetAtTime(bpm / 60, now, 0.6);

		const wt = Math.max(0, (t - A.whisperStart) / (1 - A.whisperStart));
		this.whisperGain.gain.setTargetAtTime(lerp(A.whisperGain[0], A.whisperGain[1], Math.min(1, wt)), now, 0.8);

		this._lastTension = t;

		// 雨随张力退场。放在这里而不是 setWeather 里，是因为
		// **张力每帧都在变、天气不是** —— 而这两路雨都必须跟得上张力，
		// 否则"环境声变小"这件事在雨声上会慢半拍。
		this._applyRain(now, tau);
	}

	// 雨的两路增益。唯一的入口，setTension / setWeather / init 都走它。
	// 【为什么收成一个方法】雨现在有 body + detail 两条独立的线，
	// 各自有独立的衰减系数。任何一处漏算一条，症状都是"雨声偶尔变薄"
	// 这种极难复现的东西。一个入口就没有漏算的可能。
	_applyRain(now, tau = 1.2) {
		if (!this.rainGain || !this.ready) return;
		const A = this.cfg.audio;
		const t = this.tension;
		const w = Math.pow(Math.max(0, this.weather), A.rainCurve);
		const body = A.rainGain * w * (1 - A.rainTensionK * t);
		const detail = A.rainDetailGain * w * (1 - A.rainDetailTensionK * t);
		this.rainGain.gain.setTargetAtTime(body, now, tau);
		this.rainDetailGain.gain.setTargetAtTime(detail, now, tau);
	}

	setWeather(w) {
		this.weather = w;
		if (!this.ready) return;
		this._applyRain(this.ctx.currentTime, 1.2);
	}

	// ── 女鬼呼吸的接近度（本次新增）────────────────────────
	// prox：0 = 远/不可见，1 = 贴脸。由 director 每帧喂
	//（距离接近度 × 显形不透明度 —— 乘 opacity 是关键：它溶解的
	// 时候"它"就不在了，只有距离的话 DORMANT 期会挂一层无主的呼吸）。
	//
	// 【为什么增益用 prox² 而不是 prox】线性时 10 米外就有可感的呼吸，
	// "它在附近"的信息太早暴露。平方让呼吸在 7 米内才浮出来，
	// 然后迅速逼近满格 —— 出现得晚，才有"它已经贴上来了"的骤然感。
	setGhost(prox) {
		this._ghostProx = Math.min(1, Math.max(0, prox || 0));
		if (!this.ready) return;
		const A = this.cfg.audio;
		const now = this.ctx.currentTime;
		// 速率随接近度**变慢**（与玩家呼吸相反，理由见 config 注释）。
		// 时间常数 0.8：速率的变化要像"喘息放缓"，不能像参数插值一样滑。
		this.ghostBreathLFO.frequency.setTargetAtTime(
			A.ghostBreathRate[0] + (A.ghostBreathRate[1] - A.ghostBreathRate[0]) * this._ghostProx,
			now,
			0.8,
		);
		this.ghostBreathGain.gain.setTargetAtTime(
			A.ghostBreathGain * this._ghostProx * this._ghostProx,
			now,
			0.35,
		);
	}

	// 诊断接口（供 main.js 的顿挫日志使用）。
	//
	// strain：当前"有多少声音在响"的粗估。它的存在理由不是为了调音，
	// 而是为了**在卡顿日志里分清两件事**：
	//   · 顿挫发生时 strain 很高 → 嫌疑是音频（一次爆发的音效太多）
	//   · 顿挫发生时 strain 正常 → 音频不是元凶，去看几何/LOD/GC
	// 这两个症状听起来可以一模一样（都是一下刺耳的响声），修法却完全相反。
	strain() {
		if (!this.ready) return -1;
		// 呼吸 / 心跳 / 风 / 雨 / 环境 这几路的增益之和。
		const g = (n) => (n && n.gain ? n.gain.value : 0);
		const s =
			g(this.ambientGain) + g(this.breathGain) + g(this.heartGain) +
			g(this.windGain) + g(this.droneGain) + g(this.whisperGain) + g(this.rainGain) +
			g(this.ghostBreathGain);
		return Math.round(s * 100) / 100;
	}

	// 当前尚未回收的一次性音效源节点数。
	// 【为什么要数它】Web Audio 的源节点 stop() 之后不会立刻从图里摘掉，
	// 要等 onended 才回收。sting 一次会铺开十几个节点。
	// 如果浏览器在某帧集中回收它们，就正好表现为"走着走着忽然卡一下"。
	nodeCount() {
		return this._live || 0;
	}

	aliveSources() {
		this._live = 0;
	}

	// 远处树枝断裂之类的随机事件：间隔随张力缩短
	update(dt) {
		if (!this.ready) return;
		const A = this.cfg.audio;
		const interval = A.crackInterval[0] + (A.crackInterval[1] - A.crackInterval[0]) * this.tension;
		this._crackTimer -= dt;
		if (this._crackTimer <= 0) {
			this._crackTimer = interval * (0.6 + Math.random() * 0.8);
			this.oneShot('crack');
		}

		// ── 动物环境声：乌鸦与昆虫 ─────────────────────────────
		// 【设计立场：它们是"张力计"，不是"背景铺料"】
		//
		// 恐怖游戏的动物声只有一种正确用法：用它**标记安全**，
		// 然后在它停下的瞬间让玩家意识到 —— 安全结束了。
		// 真实森林就是这样：鸟叫虫鸣的突然消失比任何配乐都准确地
		// 告诉你"有东西在靠近"。
		//
		// 所以两个骰子的间隔都随 tension **拉长**，而不是像 crack 那样缩短：
		//   tension 0    → 乌鸦 25–60 s 一次，虫鸣 14–30 s 一次
		//   tension 1    → 乌鸦几乎不再出现（>2 min），虫鸣也近乎停歇
		// "静默是武器"在这里落地：世界越危险，森林越安静。
		// 玩家可能说不清为什么害怕，但他**听得见**鸟不叫了。
		//
		// 虫鸣的下限频率比乌鸦高，是因为它同时也是"环境还活着"的底层证据：
		// 完全无声的森林听起来像静音键坏了，不是像恐怖。
		this._crowTimer -= dt;
		if (this._crowTimer <= 0) {
			const crowGap = A.crowInterval[0] + (A.crowInterval[1] - A.crowInterval[0]) * this.tension;
			this._crowTimer = crowGap * (0.7 + Math.random() * 0.6);
			// 功率随张力衰减：即使响了，也更远、更弱
			this.oneShot('crow', 1 - this.tension * 0.6);
		}
		this._insectTimer -= dt;
		if (this._insectTimer <= 0) {
			const bugGap = A.insectInterval[0] + (A.insectInterval[1] - A.insectInterval[0]) * this.tension;
			this._insectTimer = bugGap * (0.7 + Math.random() * 0.6);
			this.oneShot('insect', 1 - this.tension * 0.5);
		}

		// ── 雨打树叶：离散滴答（本次新增）────────────────────
		// 频率由天气驱动（雨越大越密，走 rainCurve 让小雨不至于吵），
		// 并随张力退场 —— 系数与 detail 一致（rainTickTensionK）：
		// 低频雨幕退了、高频滴答还留着的话，剩下的就是"细碎的电流声"。
		//
		// 【为什么走 _burst 而不是新开连续层】每一响是一次独立的水滴
		// 撞击，不是一片均匀的沙。_burst 自带亮原料路由（2.3–5.2 kHz
		// 在暗原料上根本拿不到能量）和 4 kHz 低通护栏，>4 kHz 的占比
		// 不会因为这一层抬头。占空比极低（每声 18–48 ms），2–4 kHz 的
		// 时间平均能量贡献约等于把 detail 翻倍 —— 这是"淅淅沥沥"的
		// 字面成本，付得起；再高就要回来跑 audio-probe 了。
		const w = Math.max(0, this.weather);
		if (w > 0.02) {
			this._tickTimer -= dt;
			if (this._tickTimer <= 0) {
				const rate =
					A.rainTickRate[0] +
					(A.rainTickRate[1] - A.rainTickRate[0]) * Math.pow(w, A.rainCurve);
				// 间隔抖动 ±45%：固定间隔的滴答是节拍器，是机器
				this._tickTimer = (1 / rate) * (0.55 + Math.random() * 0.9);
				const damp = 1 - A.rainTickTensionK * this.tension;
				if (damp > 0.05) {
					this._burst(
						this.ctx.currentTime,
						2300 + Math.random() * 2900, // 水滴砸针叶的频段
						6 + Math.random() * 5, // 窄带：每一滴有自己的"音点"
						0.018 + Math.random() * 0.03, // 18–48 ms 的撞击
						A.rainTickLevel * (0.6 + Math.random() * 0.8) * damp,
						true,
					);
				}
			}
		} else {
			// 雨停了就把计时器压小，免得雨势回来时先攒一串积压的滴答
			this._tickTimer = Math.min(this._tickTimer, 0.5);
		}
	}

	// ── 一次性音效 ──────────────────────────────────────────────

	// kind：音效名。power：强度系数。
	// surface：'road' | 'floor'，只对 footstep 生效（默认林地）。
	// pan：声像 −1…1（左…右）。目前只有 thunder 用（雷空间化）——
	// 其余音效都是玩家身边或"无法定位的超自然来源"，不定位反而对。
	oneShot(kind, power = 1, surface = 'floor', pan = 0) {
		if (!this.ready) return;
		const ctx = this.ctx;
		const t0 = ctx.currentTime;
		switch (kind) {
			case 'crack':
				this._burst(t0, 300, 4, 1.5, 0.16 * power);
				break;
			case 'snap':
				this._burst(t0, 1800, 2, 0.12, 0.13 * power);
				break;
			case 'rustle':
				this._burst(t0, 2600, 1.2, 0.35, 0.09 * power);
				break;
			case 'crow': {
				// ── 远处乌鸦：2–3 声降调嘶哑鸣叫 ──────────────────
				// 【为什么不是一长声】真实乌鸦是"啊—啊—啊"的短促连叫，
				// 每声内部还有一次快速的音高下坠（嘶哑感的来源）。
				// 一声长的正弦扫频听起来是"飞碟"，不是鸟。
				//
				// 【为什么带宽通而不是振荡器】乌鸦叫声的本质是**含噪声的** ——
				// 喉部摩擦让它永远带毛边。纯振荡器太干净，一听就是合成的。
				// 用亮噪声原料过窄带通（Q≈9），中心频率做两段折线：
				// 起音冲到 1.2–1.4 kHz，随即滑落到 700–900 Hz。
				const calls = 2 + Math.floor(Math.random() * 2);
				for (let i = 0; i < calls; i++) {
					const ct = t0 + i * (0.28 + Math.random() * 0.12);
					const f0 = 1150 + Math.random() * 260;
					const f1 = 680 + Math.random() * 240;
					const { src, out } = this._noise(true);
					const bp = ctx.createBiquadFilter();
					bp.type = 'bandpass';
					bp.Q.value = 8 + Math.random() * 4;
					bp.frequency.setValueAtTime(f0, ct);
					bp.frequency.exponentialRampToValueAtTime(f1, ct + 0.16);
					const g = ctx.createGain();
					g.gain.setValueAtTime(0.0001, ct);
					g.gain.exponentialRampToValueAtTime(0.05 * power, ct + 0.025);
					g.gain.exponentialRampToValueAtTime(0.0001, ct + 0.2);
					out.connect(bp);
					bp.connect(g);
					g.connect(this.fx);
					src.start(ct);
					src.stop(ct + 0.25);
				}
				break;
			}
			case 'insect': {
				// ── 虫鸣：4–6 kHz 的周期颤音 ─────────────────────
				// 【为什么音量必须这么小】虫鸣是人耳最敏感的频段
				// （等响曲线在 3–4 kHz 最凹），同样的声压级它听起来响得多。
				// 环境声刺耳的旧病就是在这个频段不加限制地铺东西 ——
				// 所以虫鸣的峰值增益被压到 0.02 以下，比脚步低一个数量级。
				//
				// 【结构】不是连续的"嘶"，是一串 22–30 Hz 调制的短脉冲
				// （蟋蟀的翅摩）。用亮噪声 → 窄带通 → 方波 LFO 调幅。
				//
				// 【为什么包络和 LFO 必须分在两个增益节点上】
				// v1 把起音包络写在 LFO 连接的同一个 AudioParam 上 ——
				// 连接的信号是**叠加**在参数值上的，于是 t0 时刻参数
				// 直接从 0 跳到 ±0.016（LFO 的方波满幅），包络那点
				// 0.0002 的缓起根本盖不住它。结果就是每段虫鸣开头
				// 都有一记 -36 dBFS 的咔哒 —— 单独听像虫子，
				// 连续听是"有人每两秒按一下打火机"。
				// 串联 vca(LFO) → env(包络) 让包络整形的是**包含 LFO 的
				// 整个信号**，起音才是真的起音。
				const dur = 0.6 + Math.random() * 0.9;
				const { src, out } = this._noise(true);
				const bp = ctx.createBiquadFilter();
				bp.type = 'bandpass';
				bp.frequency.value = 4200 + Math.random() * 1600;
				bp.Q.value = 14;
				// 方波 LFO 当"振翅"节拍器。freq 抖动一点，
				// 两只虫子不会同步 —— 同步的虫鸣是电子表，是假的。
				const vca = ctx.createGain();
				vca.gain.value = 0;
				const lfo = ctx.createOscillator();
				lfo.type = 'square';
				lfo.frequency.value = 22 + Math.random() * 8;
				const depth = ctx.createGain();
				depth.gain.value = 0.016 * power;
				lfo.connect(depth);
				depth.connect(vca.gain);
				// 慢包络：整段颤音有 0.1 s 的起音和收尾（这是真正的防咔哒层）
				const env = ctx.createGain();
				env.gain.setValueAtTime(0.0001, t0);
				env.gain.exponentialRampToValueAtTime(1, t0 + 0.08);
				env.gain.setValueAtTime(1, t0 + dur - 0.1);
				env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
				out.connect(bp);
				bp.connect(vca);
				vca.connect(env);
				env.connect(this.fx);
				src.start(t0);
				src.stop(t0 + dur + 0.1);
				lfo.start(t0);
				lfo.stop(t0 + dur + 0.1);
				break;
			}
			case 'footstep': {
				// ─────────────────────────────────────────────────
				// 【为什么以前的脚步是"登登登"】
				// 旧实现 = 一记固定 1100 Hz 带通爆 + 固定 74→48 Hz 躯干。
				// 频谱固定 + 音高固定 + 电平固定 → 大脑半秒后就把它归类成
				// "机器在循环"，这是听感上最致命的一种暴露。
				// 而且那记 1100 Hz 的爆当时还架在 780 Hz 的暗原料上，
				// 实际发出的只是低频裙摆 —— 连"拍"都没有，只剩"登"。
				//
				// 新设计三层随机 + 两套地表：
				//   ① 电平 ±15%      —— 每步轻重不同
				//   ② 躯干音高 ±8%   —— 地面软硬不同
				//   ③ 左右脚 ±6%     —— 人不是对称的
				//   地表由 main.js 按 pathInfluence 决定：
				//   路面（压实土）= 躯干实 + 一记干净的中频"拍"；
				//   林地（枯叶） = 躯干软 + 3–5 个错开的脆响 + 沙沙尾。
				// ─────────────────────────────────────────────────
				const v = 0.85 + Math.random() * 0.3;
				const p = power * v;
				const alt = this._footAlt ? 1.06 : 0.94;
				this._footAlt = !this._footAlt;
				const thudJ = 0.92 + Math.random() * 0.16;
				if (surface === 'road') {
					this._thud(t0, 74 * thudJ, 0.16 * p * alt, 0.13);
					// 那记"拍"的中心频率也随机（低压实的土 620–1240 Hz）。
					// 固定频段的爆音重复几十次之后，耳朵会把它认成一个**音高** ——
					// 这就是"机器在循环"的具体成因。Q 也轻微浮动，让带宽不固定。
					this._burst(
						t0 + Math.random() * 0.012,
						620 + Math.random() * 620,
						1.2 + Math.random() * 0.7,
						0.11 + Math.random() * 0.05,
						0.15 * p * alt,
					);
				} else {
					this._thud(t0, 62 * thudJ, 0.11 * p * alt, 0.12);
					const n = 3 + Math.floor(Math.random() * 3);
					for (let i = 0; i < n; i++) {
						this._burst(
							t0 + Math.random() * 0.085,
							1700 + Math.random() * 1500,
							2.2,
							0.04 + Math.random() * 0.05,
							(0.045 + Math.random() * 0.05) * p * alt,
							true,
						);
					}
					// 沙沙尾：碎裂停了之后枯叶还在"塌"一下
					this._burst(t0 + 0.02, 2600, 1.2, 0.3, 0.05 * p, true);
				}
				break;
			}
			case 'bell':
				this._bell(t0, power);
				break;
			case 'sting':
				this._sting(t0, power, 'hard');
				break;
			case 'stingSoft':
				this._sting(t0, power, 'soft');
				break;
			// 手电刚刚照住它。这不是"命中音效"——它不该有任何奖励感。
			// 见 _hold 的注释：它是"灯丝被拖住"的物理声，不是 UI 反馈。
			case 'hold':
				this._hold(t0, power);
				break;
		// 雷。power 这一位在这里被复用为 nearness（0 = 6 km 外，1 = 贴脸）。
		// 复用是有意的：雷是"一次性的天际事件"，和 sting/crack 同类，
		// 没有理由为它单开一个入口。pan 是它的方位（main.js 算好）。
		case 'thunder':
			this._thunder(t0, power, pan);
			break;
			case 'climax':
				this._climax(t0);
				break;
			default:
				break;
		}
	}

	// 一次性噪声爆。注意 Q 低（1.2–4）时带通的裙摆很宽，
	// 所以后面必须跟一道低通，否则爆音里会窜出 4 kHz 以上的"嘶"。
	// bright：强制用亮原料。不带它时按频率自动路由 —— 900 Hz 以上的
	// 瞬态在暗原料上拿不到能量（见 _noise 注释），自动升级为亮。
	// 出口接 fx 支路（绕过总线低通墙）—— 见 init() 里的注释。
	_burst(t0, freq, q, dur, level, bright = false) {
		const ctx = this.ctx;
		const useBright = bright || freq > 900;
		const { src, out } = this._noise(useBright);
		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = freq;
		bp.Q.value = q;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = Math.min(4000, Math.max(1000, freq * 2.2));
		lp.Q.value = 0.5;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t0 + 0.006);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		out.connect(bp);
		bp.connect(lp);
		lp.connect(g);
		g.connect(this.fx);
		src.start(t0);
		src.stop(t0 + dur + 0.05);
	}

	// 躯干音：正弦下扫，"身体砸在地上"的那一下。
	// 从 footstep 里抽出来，因为路面/林地两种脚步都要用它。
	_thud(t0, freq, level, dur) {
		const ctx = this.ctx;
		const o = ctx.createOscillator();
		o.type = 'sine';
		o.frequency.setValueAtTime(freq, t0);
		o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.62), t0 + dur * 0.7);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t0 + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		o.connect(g);
		g.connect(this.fx);
		o.start(t0);
		o.stop(t0 + dur + 0.05);
	}

	_bell(t0, power) {
		const ctx = this.ctx;
		for (const [f, g0, dur] of [
			[440, 0.07, 2.2],
			[660, 0.045, 1.7],
		]) {
			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.setValueAtTime(f, t0);
			o.frequency.exponentialRampToValueAtTime(f * 0.985, t0 + dur);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t0);
			g.gain.exponentialRampToValueAtTime(g0 * power, t0 + 0.01);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
			o.connect(g);
			g.connect(this.fx);
			o.start(t0);
			o.stop(t0 + dur + 0.1);
		}
	}

	// sting：三个失谐锯齿从 220 Hz 下扫，过共振低通，叠一层噪声爆
	_sting(t0, power, kind) {
		const ctx = this.ctx;
		const out = ctx.createGain();
		out.gain.setValueAtTime(0.0001, t0);
		out.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.5 * power), t0 + 0.012);
		out.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === 'hard' ? 0.95 : 0.65));
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.Q.value = 12;
		lp.frequency.setValueAtTime(kind === 'hard' ? 2600 : 1500, t0);
		lp.frequency.exponentialRampToValueAtTime(160, t0 + 0.85);
		lp.connect(out);
		out.connect(this.fx);

		for (let i = 0; i < 3; i++) {
			const o = ctx.createOscillator();
			o.type = 'sawtooth';
			o.detune.value = (i - 1) * 22;
			o.frequency.setValueAtTime(220, t0);
			o.frequency.exponentialRampToValueAtTime(kind === 'hard' ? 40 : 84, t0 + 0.8);
			const g = ctx.createGain();
			g.gain.value = 0.33;
			o.connect(g);
			g.connect(lp);
			o.start(t0);
			o.stop(t0 + 1.05);
		}
		if (kind === 'hard') {
			const { src, out: nOut } = this._noise();
			const bp = ctx.createBiquadFilter();
			bp.type = 'bandpass';
			bp.frequency.value = 1200;
			bp.Q.value = 0.8;
			const lp = ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = 3000;
			lp.Q.value = 0.5;
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.3, t0);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
			nOut.connect(bp);
			bp.connect(lp);
			lp.connect(g);
			g.connect(out);
			src.start(t0);
			src.stop(t0 + 0.5);
		}
	}

	// ── 雷 ───────────────────────────────────────────────────────
	//
	// 【雷声的全部魅力在延迟上，不在音色上】
	// 由 Lightning 负责"看见"与"听见"之间的那段时间差（距离 / 343）。
	// 这个函数只负责"听见时是什么样"。
	//
	// nearness：0 = 五六公里外，1 = 贴脸。同一种声音的两个极端。
	//
	//   远雷：几乎没有起音（声音从地平线滚过来）、极低频（70 Hz 低通）、
	//         5–7 秒长、**多层滚动** —— 地面和云层把一次放电反射成好几波。
	//         那个"滚"就是远雷的定义。
	//   近雷：一记脆裂（宽带、锋利起音）+ 一记低频冲击（胸口那一下）、
	//         2 秒左右就结束。
	//
	// pan：−1…1 的声像。由 main.js 按 sin(az − yaw) 算好传进来
	//（闪电的方位角减玩家朝向）。三层（滚动/脆裂/冲击）必须过**同一个**
	// 声像器 —— 分头直连 fx 的话，三部分会从三个位置来，雷就被撕碎了。
	//
	// 【为什么滚动包络用 setValueCurveAtTime 而不是 LFO】
	// 试过用几个低频振荡器接到同一个 gain 上做滚动 —— 那是错的：
	// **已连接的 AudioParam 是叠加而不是调制**（这个坑在虫鸣上已经踩过一次，
	// 见 insect 的注释）。接上去之后参数会在 t0 从 0 跳到 ±深度，产生咔哒。
	// setValueCurveAtTime 是直接**写**这条曲线，不叠加任何东西，没有这个风险。
	// 而且它天然是"可以随便画形状"的 —— 滚动的随机性本来就该是画出来的。
	_thunder(t0, near, pan = 0) {
		const A = this.cfg.audio;
		const ctx = this.ctx;
		const n = Math.min(1, Math.max(0, near));
		const lerp = (a, b, k) => a + (b - a) * k;

		// ── 声像器：这一记雷从哪边来 ──────────────────────────
		// 【远雷的声像收窄】方向感主要来自高频的耳间声级差，而高频
		// 在大气里衰减得最快 —— 远雷只剩无方向性的低频，硬 Pan 会
		// 让它听起来像"右声道音箱"而不是"那个方向的雷"。
		// thunderPanFar(0.55)→1 随 nearness 插值。
		// isFinite 防线：storm-probe 以默认参数重放这条链，NaN 不能进 AudioParam。
		const panner = ctx.createStereoPanner();
		const pv = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
		panner.pan.value = pv * lerp(A.thunderPanFar, 1, n);
		panner.connect(this.fx);

		const dur = lerp(A.thunderDur[0], A.thunderDur[1], n);
		const peak = lerp(A.thunderPeak[0], A.thunderPeak[1], n);
		const rolls = Math.round(lerp(A.thunderRolls[0], A.thunderRolls[1], n));
		const lp = lerp(A.thunderRollLP[0], A.thunderRollLP[1], n);

		// ── 轰鸣主体 ────────────────────────────────────────────
		const { src, out } = this._noise();
		const f = ctx.createBiquadFilter();
		f.type = 'lowpass';
		f.frequency.value = lp;
		f.Q.value = 0.9;
		const env = ctx.createGain();
		env.gain.value = 0;

		// 画滚动包络。N 取 128：再密只是浪费，再疏会听出折线。
		const N = 128;
		const curve = new Float32Array(N);
		const swells = [];
		for (let r = 0; r < rolls; r++) {
			swells.push({
				c: (r + 0.35 + Math.random() * 0.55) / (rolls + 0.35),
				w: 0.075 + Math.random() * 0.12,
				a: 0.4 + Math.random() * 0.6,
			});
		}
		for (let i = 0; i < N; i++) {
			const x = i / (N - 1);
			// 起音：近雷几乎瞬时（x*45），远雷是缓慢涌上来的（x*3.5）
			const atk = 1 - Math.exp(-x * lerp(3.5, 45, n));
			// 尾巴：远雷衰减更慢，所以"拖得久"和"响得轻"是同一件事
			const tail = Math.pow(1 - x, lerp(1.05, 2.1, n));
			let s = 0;
			for (const w of swells) {
				const d = (x - w.c) / w.w;
				s += w.a * Math.exp(-d * d);
			}
			// 近雷至少要有一个实心躯体，不能被滚动的波谷吃掉
			const body = Math.max(s, n * 0.92);
			curve[i] = Math.max(0.00008, atk * tail * body * peak);
		}
		// 末值必须归零：setValueCurveAtTime 结束后参数会**保持最后一个值**，
		// 留一个非零值在 gain 上就是一个直流偏移（松手时会"啪"一声）。
		curve[N - 1] = 0.00008;
		env.gain.setValueCurveAtTime(curve, t0, dur);
		out.connect(f);
		f.connect(env);
		env.connect(panner); // 滚动层过声像器（不再直连 fx）
		src.start(t0);
		src.stop(t0 + dur + 0.08);

		// ── 脆裂（只在近雷）────────────────────────────────────
		// 这是"距离"最强的线索：高频在大气里衰减得最快，
		// 所以雷声里最先消失的就是这一层。远雷完全没有它。
		if (n > 0.22) {
			const c = this._noise(true);
			const hp = ctx.createBiquadFilter();
			hp.type = 'highpass';
			hp.frequency.value = A.thunderCrackHP;
			const clp = ctx.createBiquadFilter();
			clp.type = 'lowpass';
			clp.Q.value = 0.6;
			// 下扫：放电的频谱随时间往低走，这是"撕裂感"的来源。
			// 固定截止会变成一个白噪爆（就是"刺耳"的旧病）。
			clp.frequency.setValueAtTime(A.thunderCrackLP, t0);
			clp.frequency.exponentialRampToValueAtTime(760, t0 + 0.42);
			const g = ctx.createGain();
			const crackDur = lerp(0.62, 0.3, n);
			const crackLvl = peak * lerp(0.35, 1.15, n);
			g.gain.setValueAtTime(0.0001, t0);
			g.gain.exponentialRampToValueAtTime(Math.max(0.0002, crackLvl), t0 + 0.005);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + crackDur);
			c.out.connect(hp);
			hp.connect(clp);
			clp.connect(g);
			g.connect(panner); // 脆裂层过同一个声像器 —— 三层必须同源，否则雷被撕碎
			c.src.start(t0);
			c.src.stop(t0 + crackDur + 0.06);
		}

		// ── 低频冲击（只在近距离）──────────────────────────────
		// 那一下"砸在胸口"的感觉。噪声层做不出来 —— 噪声没有
		// 一个明确的音高，而冲击感恰恰来自"一个干净的极低频正弦突然出现"。
		if (n > 0.45) {
			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.setValueAtTime(58, t0);
			o.frequency.exponentialRampToValueAtTime(34, t0 + 0.5);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t0);
			g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.7), t0 + 0.012);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
			o.connect(g);
			g.connect(panner); // 低频冲击也过同一个声像器
			o.start(t0);
			o.stop(t0 + 0.95);
		}
	}

	// ── 手电照住鬼影 ─────────────────────────────────────────────
	//
	// 【为什么不能做成"命中音"】
	// 所有带奖励感的音效（清脆的"叮"、上行的音高）都会把这个动作
	// 变成"打中了"。而鬼影是杀不死的 —— 这里没有"打中"。
	// 发生的事是：你的光**被一个东西拖住了**。
	//
	// 所以合成出来的是一段被压住的气息：一个很低的、微微不稳的音，
	// 加上一小层噪声摩擦 —— 像手电的线圈突然被吸住。
	// 没有起音尖峰，没有音高上扬，只有"沉下去"。
	_hold(t0, power = 1) {
		const ctx = this.ctx;
		const dur = 0.85;
		// 低频嗡：两个极近的频率打拍，产生"不稳"的感觉
		for (const [f, g0] of [
			[96, 0.055],
			[97.7, 0.045],
		]) {
			const o = ctx.createOscillator();
			o.type = 'triangle';
			o.frequency.setValueAtTime(f, t0);
			// 微微下沉：被拖住了，所以它在往下拽
			o.frequency.exponentialRampToValueAtTime(f * 0.94, t0 + dur);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t0);
			// 起音慢（0.09 s）—— 这就是"没有奖励感"的技术实现
			g.gain.exponentialRampToValueAtTime(Math.max(0.0002, g0 * power), t0 + 0.09);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
			o.connect(g);
			g.connect(this.fx);
			o.start(t0);
			o.stop(t0 + dur + 0.05);
		}
		// 一层窄带摩擦噪声：1.1 kHz，Q 高，很短
		const { src, out } = this._noise(true);
		const bp = ctx.createBiquadFilter();
		bp.type = 'bandpass';
		bp.frequency.value = 1100 + Math.random() * 260;
		bp.Q.value = 5.5;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.028 * power), t0 + 0.07);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
		out.connect(bp);
		bp.connect(g);
		g.connect(this.fx);
		src.start(t0);
		src.stop(t0 + 0.5);
	}

	_climax(t0) {
		const ctx = this.ctx;
		this._sting(t0, 1.0, 'hard');
		// 全频噪声墙：0.5 秒上升，再塌下去
		// 原本频率一直扫到 9 kHz —— 那一下是真的"撕耳"。
		// 上限收到 4 kHz（预着色后原料本身只到 800 Hz，这里是留点余量做"张开"感）。
		const { src, out: nOut } = this._noise();
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(0.24, t0 + 0.5);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.3);
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime(400, t0);
		lp.frequency.exponentialRampToValueAtTime(4000, t0 + 0.5);
		lp.frequency.exponentialRampToValueAtTime(280, t0 + 2.2);
		nOut.connect(lp);
		lp.connect(g);
		g.connect(this.fx);
		src.start(t0);
		src.stop(t0 + 2.5);
	}
}
