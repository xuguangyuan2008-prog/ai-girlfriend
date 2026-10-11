"""由定妆照生成其余起步素材（在 AutoDL 实例上运行，由 npm run autodl -- make-assets 调用）。

首尾帧钉在 anchor.png 上，让她打个招呼；从视频里提取声音 → voice.wav，从定妆照上部裁正方形 → portrait.png。
（服务只部署了 Ref2VA，请求至少要带一个参考条件，所以定妆照要先有。）

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
if not os.path.exists(anchor):
    print(f"缺少定妆照 {anchor}")
    sys.exit(2)

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


print("首尾帧钉在定妆照上，生成一段她打招呼的视频")
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


# 胸口以上的近景，脸在画面上部：取宽度为边长的正方形，从顶部往下一点开始
ff("-i", anchor, "-vf", "crop=iw:iw:0:ih*0.08", os.path.join(assets, "portrait.png"))
ff("-i", clip, "-vn", "-ac", "1", "-ar", "24000", os.path.join(assets, "voice.wav"))
print("素材已生成")
