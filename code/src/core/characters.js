// 角色模型加载：把 Blender 导出的 .glb 变成"可直接挂进骨架"的部件。
//
// ─────────────────────────────────────────────────────────────
// 【为什么要烘焙节点变换】
// glTF 里每个部件（P_Torso / G_Dress…）都带着自己的平移/旋转。
// 而 avatar.js / stalker.js 的动画代码要的是"几何顶点直接落在
// 角色空间"（脚底 y=0、髋在 y≈0.90），然后把网格塞进关节枢轴组，
// 让 pivot.rotation.x 原地摆动 —— 枢轴组不认 glTF 的节点树。
// 所以加载后立刻把 matrixWorld 烘进几何体、清掉节点变换，
// 之后 mesh.position = −pivotPos 就是"挂回原位"的全部秘密。
//
// 【为什么缓存 Promise】
// 第三人称切换、探针、截图工具可能先后都要同一份模型。
// 缓存解析后的部件数组，重复调用零开销；失败时把缓存扔掉，
// 下次调用还能重试（比如 dev server 刚起、模型还没就位）。
//
// 【加载失败 = 保留基元 fallback】
// avatar/stalker 先用基元网格把世界撑起来，GLB 到货后原地换装。
// 模型 404 不应该让游戏黑屏 —— 雾里的人形剪影照样能玩。
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const cache = new Map();

/**
 * 加载角色 GLB，返回 Promise<Part[]>。
 * Part = { name, geometry, material }，geometry 已烘焙到角色空间。
 */
export function loadCharacter(url) {
	if (!cache.has(url)) {
		const p = new Promise((resolve, reject) => {
			new GLTFLoader().load(
				url,
				(gltf) => {
					const root = gltf.scene;
					root.updateMatrixWorld(true);
					const parts = [];
					root.traverse((n) => {
						if (!n.isMesh) return;
						// 世界变换烘进几何体；材质原样带走（名字 = M_Coat 等）
						const geo = n.geometry.clone().applyMatrix4(n.matrixWorld);
						parts.push({ name: n.name, geometry: geo, material: n.material });
					});
					if (!parts.length) {
						reject(new Error(`模型里没有网格：${url}`));
						return;
					}
					resolve(parts);
				},
				undefined,
				(err) => reject(err),
			);
		});
		p.catch(() => cache.delete(url)); // 失败不缓存，允许重试
		cache.set(url, p);
	}
	return cache.get(url);
}

/**
 * 给角色材质贴一张 ImageGen 自产贴图（颜色贴图，无平铺、无法线）。
 * 贴图缺失时保持纯色 —— 和 textures.js 的容错哲学一致。
 */
const charTex = new Map();
export function applyCharacterTexture(mat, name) {
	if (!mat || charTex.has(name)) {
		if (mat && charTex.has(name)) {
			mat.map = charTex.get(name);
			mat.color.set(0xffffff); // 有贴图后颜色乘白，避免双重压暗
			mat.needsUpdate = true;
		}
		return;
	}
	new THREE.TextureLoader().load(
		`textures/${name}.jpg`,
		(tex) => {
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.anisotropy = 4;
			charTex.set(name, tex);
			mat.map = tex;
			mat.color.set(0xffffff);
			mat.needsUpdate = true;
		},
		undefined,
		() => console.warn(`[资产] 角色贴图加载失败：${name}（保持纯色）`),
	);
}
