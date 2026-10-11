"""用 H3 自己生成一套起步素材（在 AutoDL 实例上运行，由 npm run autodl -- make-assets 调用）。

- 没有 anchor.png：只用文字描述生成一段她打招呼的视频，第一帧当定妆照
- 已有 anchor.png（比如用文生图工具做的）：首尾帧钉在这张图上生成，只取声音和裁剪
然后从视频里提取声音 → voice.wav，从定妆照上部裁正方形 → portrait.png。

    python make_assets.py job.json
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

job = json.load(open(sys.argv[1], encoding="utf-8"))
base, assets = job["base"], job["dir"]
os.makedirs(assets, exist_ok=True)
anchor = os.path.join(assets, "anchor.png")
use_anchor = os.path.exists(anchor) and not job.get("regen")

conditions = []
if use_anchor:
    conditions = [
        {"type": "image", "uri": anchor, "role": "keyframe", "frame_index": 0},
        {"type": "image", "uri": anchor, "role": "keyframe", "frame_index": -1},
    ]
body = {
    "prompt": job["prompt"],
    "task": "ref2va",
    "conditions": conditions,
    "target": {"short_edge": job["short_edge"], "aspect_ratio": "9:16", "duration_seconds": job["seconds"]},
    "seed": job["seed"],
    "num_inference_steps": job["steps"],
}


def call(method, path, data=None):
    req = urllib.request.Request(
        base + path,
        data=None if data is None else json.dumps(data).encode(),
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


print("用定妆照做首尾帧生成" if use_anchor else "只用文字描述生成（定妆照也从视频里取）")
try:
    j = json.loads(call("POST", "/v1/videos", body))
except urllib.error.HTTPError as e:
    print(f"H3 拒绝了这个请求（{e.code}）：{e.read().decode(errors='replace')[:800]}")
    sys.exit(2)

t0 = time.time()
while j.get("status") != "completed":
    if j.get("status") == "failed":
        print(f"\n生成失败：{json.dumps(j, ensure_ascii=False)[:800]}")
        sys.exit(2)
    time.sleep(3)
    j = json.loads(call("GET", f"/v1/videos/{j['id']}"))
    print(f"\r  生成中… 已等待 {time.time() - t0:.0f} 秒（第一次包含编译，会慢很多）", end="", flush=True)
print(f"\n  生成完成，用时 {time.time() - t0:.0f} 秒")

clip = os.path.join(assets, "make_assets.mp4")
with open(clip, "wb") as f:
    f.write(call("GET", f"/v1/videos/{j['id']}/content"))


def ff(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


if not use_anchor:
    ff("-i", clip, "-frames:v", "1", anchor)
# 胸口以上的近景，脸在画面上部：取宽度为边长的正方形，从顶部往下一点开始
ff("-i", anchor, "-vf", "crop=iw:iw:0:ih*0.08", os.path.join(assets, "portrait.png"))
ff("-i", clip, "-vn", "-ac", "1", "-ar", "24000", os.path.join(assets, "voice.wav"))
print("素材已生成")
