"""一次生成几个只差一个变量的版本，用来排查画质问题（在 AutoDL 实例上运行，由 npm run autodl -- try 调用）。

每个版本保存为 <输出目录>/<名字>.mp4，最后横向拼成 compare.mp4（从左到右按顺序）方便对比。

    python try_h3.py job.json
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

job = json.load(open(sys.argv[1], encoding="utf-8"))
base, out = job["base"], job["out"]
os.makedirs(out, exist_ok=True)


def call(method, path, data=None):
    req = urllib.request.Request(
        base + path,
        data=None if data is None else json.dumps(data).encode(),
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


files = []
for v in job["variants"]:
    body = {
        "prompt": job["prompt"],
        "task": "ref2va",
        "conditions": v["conditions"],
        "target": {"short_edge": job["short_edge"], "aspect_ratio": "9:16", "duration_seconds": job["seconds"]},
        "seed": job["seed"],
        "num_inference_steps": v["steps"],
        "flow_shift": v["flow_shift"],
        "audio_flow_shift": v["audio_flow_shift"],
    }
    print(f"== {v['name']}：{v['desc']}")
    try:
        j = json.loads(call("POST", "/v1/videos", body))
    except urllib.error.HTTPError as e:
        print(f"   H3 拒绝（{e.code}）：{e.read().decode(errors='replace')[:400]}")
        continue
    t0 = time.time()
    while j.get("status") != "completed":
        if j.get("status") == "failed":
            print(f"\n   生成失败：{json.dumps(j, ensure_ascii=False)[:400]}")
            break
        time.sleep(3)
        j = json.loads(call("GET", f"/v1/videos/{j['id']}"))
        print(f"\r   生成中… {time.time() - t0:.0f} 秒", end="", flush=True)
    if j.get("status") != "completed":
        continue
    path = os.path.join(out, f"{v['name']}.mp4")
    with open(path, "wb") as f:
        f.write(call("GET", f"/v1/videos/{j['id']}/content"))
    files.append(path)
    print(f"\r   完成，用时 {time.time() - t0:.0f} 秒 → {path}")

if len(files) > 1:
    # 缩小后横向拼接，画面按上面的顺序从左到右；声音用第一个版本的
    inputs = sum((["-i", f] for f in files), [])
    scaled = "".join(f"[{i}:v]scale=-2:640[v{i}];" for i in range(len(files)))
    stack = "".join(f"[v{i}]" for i in range(len(files))) + f"hstack=inputs={len(files)}[v]"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", scaled + stack,
         "-map", "[v]", "-map", "0:a?", "-shortest", os.path.join(out, "compare.mp4")],
        check=False,
    )
print("全部完成")
