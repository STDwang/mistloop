// 手电：唯一的光源。
//
// 设计意图：光不是场景的装饰，是玩家的工具。所以它必须
//   ① 收得很窄（未知区域最大化）② 会闪（灯具感、不可靠感）
//   ③ 有一根能看见的锥（雾里的光柱，是本作最重要的"氛围"元素之一）
//
// 光柱不用真体积光：用一个加性材质的锥体做出 70% 的效果，成本只有 1%。

import * as THREE from 'three';

const CONE_HEIGHT = 34;
const CONE_RADIUS = 8.4;

export class Flashlight {
	constructor(cfg, camera) {
		this.cfg = cfg;
		this.camera = camera;
		this.on = true;
		this._t = 0;
		this._flicker = 0;
		this._baseIntensity = 46;

		// ── 装具（rig）：光 + 目标 + 补光 + 锥 全部挂在这一个组上 ──
		// 为什么要有 rig：第一人称时它挂在相机上（光从"你的手"出发），
		// 第三人称时要换挂到化身的头上（光从"他的手"出发）。
		// 把四个对象收进一个组，换挂点就是一行 parent.add(rig)，
		// three 会自动从旧父节点上摘下来 —— 不需要手动 remove。
		this.rig = new THREE.Group();

		this.light = new THREE.SpotLight(cfg.palette.torch, 42, 50, 0.454, 0.6, 1.2);
		this.light.position.set(0.16, -0.12, 0);
		this.light.castShadow = true;
		this.light.shadow.mapSize.set(1024, 1024);
		this.light.shadow.camera.near = 0.4;
		this.light.shadow.camera.far = 52;
		this.light.shadow.bias = -0.0012;
		this.light.shadow.normalBias = 0.022;
		this.light.shadow.focus = 1.0;

		// 目标必须也是场景图的一部分，SpotLight 才会朝它照
		this.target = new THREE.Object3D();
		this.target.position.set(0, 0, -1);

		this.fill = new THREE.PointLight(cfg.palette.torch, 1.4, 5.5, 2.0);
		this.fill.position.set(0.1, -0.25, -0.2);

		this.cone = this._makeCone();

		this.rig.add(this.light, this.target, this.fill, this.cone);
		this.light.target = this.target;
		camera.add(this.rig);
	}

	// 把整套装具换一个父节点。第三人称切换时调用：
	// mountTo(avatar.head) —— 光锥的 -Z 前向约定与化身一致，
	// 化身转身时光锥跟着转，不需要任何额外数学。
	mountTo(parent) {
		parent.add(this.rig);
	}

	_makeCone() {
		const geo = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 30, 1, true);
		// 把锥顶摆到相机原点，锥体沿 -Z 张开
		geo.rotateX(Math.PI / 2);
		geo.translate(0, 0, -CONE_HEIGHT / 2);

		this.coneUniforms = {
			uColor: { value: new THREE.Color(this.cfg.palette.torch) },
			uIntensity: { value: 0.16 },
			uHeight: { value: CONE_HEIGHT },
			uRadius: { value: CONE_RADIUS },
		};

		const mat = new THREE.ShaderMaterial({
			uniforms: this.coneUniforms,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			side: THREE.BackSide,
			vertexShader: /* glsl */ `
				varying vec3 vLocal;
				void main() {
					vLocal = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				uniform vec3 uColor;
				uniform float uIntensity;
				uniform float uHeight;
				uniform float uRadius;
				varying vec3 vLocal;
				void main() {
					float t = clamp(-vLocal.z / uHeight, 0.0, 1.0);
					float r = length(vLocal.xy) / (uRadius * t + 0.0001);
					float edge = 1.0 - smoothstep(0.30, 1.0, r);
					float fall = exp(-t * 2.1) * (1.0 - smoothstep(0.72, 1.0, t));
					float a = edge * fall * uIntensity;
					gl_FragColor = vec4(uColor * a, a);
				}
			`,
		});

		const m = new THREE.Mesh(geo, mat);
		m.position.set(0.16, -0.12, 0);
		m.frustumCulled = false;
		m.renderOrder = 950;
		return m;
	}

	toggle() {
		this.on = !this.on;
		this.light.visible = this.on;
		this.fill.visible = this.on;
		this.cone.visible = this.on;
		return this.on;
	}

	// 当前光束的世界起点与朝向，写进一个**纯数字**对象。
	//
	// 【为什么不能拿相机凑合】"照到没照到"必须用**真实的挂点**来判定。
	// 第一人称时 rig 挂在相机上，两者一致；第三人称时 rig 挂在化身的头上，
	// 而相机在人物身后 3.4 m —— 用相机方向去判定会整体偏一个身位。
	// 这个偏差在近处（鬼影逼近时，也正是最需要判定准的时候）足以
	// 让"我看得见它"和"判定说没照到"同时成立。
	//
	// rig 自身的局部朝向就是 -Z（锥体、SpotLight.target、化身的朝前约定
	// 三者都是 -Z），所以把 (0,0,-1) 变换到世界系即可。
	//
	// 【为什么返回纯数字而不是 Vector3】判定的消费者是 Director，
	// 而 Director 刻意不 import three —— 它是"大脑"，不该知道渲染的事。
	// 传一个 {ox,oy,oz,dx,dy,dz} 让那条边界保持干净。
	aim(out = {}) {
		this.rig.updateWorldMatrix(true, false);
		const m = this.rig.matrixWorld.elements;
		// 平移在第 4 列（12,13,14）；-Z 轴 = 第三列取负（8,9,10）
		out.ox = m[12];
		out.oy = m[13];
		out.oz = m[14];
		out.dx = -m[8];
		out.dy = -m[9];
		out.dz = -m[10];
		return out;
	}

	// 张力越高，灯越不稳 —— 恐惧会影响设备，这是恐怖片的通行做法
	update(dt, tension) {
		this._t += dt;
		if (!this.on) return;

		let f = 1;
		// 慢速呼吸式波动
		f *= 0.965 + Math.sin(this._t * 2.1) * 0.02 + Math.sin(this._t * 5.7) * 0.012;
		// 张力高时加入随机掉电
		if (tension > 0.25) {
			this._flicker -= dt;
			if (this._flicker < 0) {
				this._flicker = 0.08 + Math.random() * (1.4 - tension) * 0.9;
				f *= 1 - Math.random() * (0.2 + tension * 0.55);
			}
		}
		this.light.intensity = 42 * f;
		this.fill.intensity = 1.2 * f;
		this.coneUniforms.uIntensity.value = 0.105 * f * (1 + tension * 0.35);
	}

	reduceQuality() {
		this.light.castShadow = false;
		this.light.shadow.mapSize.set(512, 512);
		this.cone.visible = false;
	}
}
