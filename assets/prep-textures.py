# 把 ImageGen 出的原始贴图处理成能进引擎的资产。
#
# 三件事，每一件都对应一个"不处理就一定会翻车"的理由：
#
# 1. 裁边 6%
#    ImageGen 会在右下角盖"AI生成 WORKBUDDY"水印。这张图会被 RepeatWrapping
#    平铺一百多次，水印会变成一行整整齐齐的小字格子 —— 必须裁掉。
#    顺带把四边最容易出现的"边框感"也裁掉。
#
# 2. 可平铺化（roll + cross-fade）
#    ImageGen 说"seamless"但它根本没对齐左右边。地面贴图 repeat ≈ 115 次，
#    一条接缝就是 115 条竖线，直接报废。
#    做法：把图整体 roll 半个周期，接缝就被推到画面正中央成一个十字；
#    再在十字附近用原图的中心（那里没有接缝）去混。
#    远离十字的地方用 rolled 版本 —— 它在外边缘恰好是无缝的。
#    两张图内容几乎一样（就是平移了半格），所以过渡带里只有轻微的重影，
#    对有机材质（苔藓/落叶/树皮）完全看不出来。
#
# 3. 转 JPEG q88
#    PNG 一张 1.7–2.2 MB，三张 6 MB，超过"画质优先"档定的 3–6 MB 总预算。
#    JPEG q88 一张 150–300 KB，肉眼在游戏里分不出来。

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(r"E:\AiStudy\silentHill\assets\textures-src")
OUT = Path(r"E:\AiStudy\silentHill\code\public\textures")

# 个别贴图的亮度增益：ImageGen 出图偏暗、而引擎里还要乘灯光时，
# 在资产侧提亮一次比在材质上糊 emissive 诚实。
# char-coat 实测 mean 0.250（sRGB），×1.4 → ~0.35：夜里读得出外套轮廓。
GAINS = {"char-coat": 1.4}


def smoothstep(e0, e1, x):
	t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
	return t * t * (3.0 - 2.0 * t)


def make_tileable(a: np.ndarray) -> np.ndarray:
	h, w, _ = a.shape
	b = np.roll(a, (h // 2, w // 2), axis=(0, 1))

	# 权重：在画面中心十字附近 → 用原图（它的中心无接缝）；
	# 远离十字（即四边）→ 用 rolled（它的外边无接缝）。
	u = np.arange(w) / w
	v = np.arange(h) / h
	# bump 中心在 0.5，宽度约 0.28；smoothstep 让过渡带不产生硬边
	wx = 1.0 - smoothstep(0.10, 0.38, np.abs(u - 0.5))
	wy = 1.0 - smoothstep(0.10, 0.38, np.abs(v - 0.5))
	mask2d = np.maximum(wx[None, :], wy[:, None])[:, :, None]

	return (b * (1.0 - mask2d) + a * mask2d).astype(np.uint8)


def process(name: str) -> None:
	src = SRC / f"{name}.png"
	img = Image.open(src).convert("RGB")
	w, h = img.size

	# ── 1. 裁边：水印在右下，四边一起裁，保持正方形 ──
	crop = int(min(w, h) * 0.06)
	img = img.crop((crop, crop, w - crop, h - crop))
	img = img.resize((1024, 1024), Image.LANCZOS)

	a = np.asarray(img).astype(np.float32)

	# ── 2. 可平铺化 ──
	a = make_tileable(a)

	# ── 2.5 亮度增益（有的话）──
	gain = GAINS.get(name)
	if gain:
		a = np.clip(a * gain, 0, 255).astype(np.uint8)

	# ── 3. JPEG ──
	OUT.mkdir(parents=True, exist_ok=True)
	dst = OUT / f"{name}.jpg"
	Image.fromarray(a).save(dst, "JPEG", quality=88, optimize=True)

	png_kb = src.stat().st_size / 1024
	jpg_kb = dst.stat().st_size / 1024
	print(f"  {name:8s} {png_kb:7.0f} KB → {jpg_kb:6.0f} KB  ({w}×{h} → 1024×1024)")


if __name__ == "__main__":
	names = sys.argv[1:] or ["bark", "ground", "rock"]
	print("处理贴图：")
	total = 0
	for n in names:
		process(n)
	for n in names:
		total += (OUT / f"{n}.jpg").stat().st_size
	print(f"合计：{total / 1024:.0f} KB")
