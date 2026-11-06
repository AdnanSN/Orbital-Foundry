"""Orbital Foundry's burst lane for AI video clips (ROADMAP Stage 18, D-060).

Wan 2.2 TI2V-5B (Apache-2.0) on one L40S. Deploy it with `modal deploy infra/modal/video.py`,
then put the endpoint URL and a proxy auth token in .env (MODAL_VIDEO_URL, MODAL_KEY,
MODAL_SECRET). The station caps the spend at $25 a month (config/gpu.yaml), under the $30 of free
credit, and only sends a clip here when the laptop's GPU can't make it by its deadline.

The weights download once into a Modal Volume (on Modal's disk, not yours).
"""

import modal

MODEL = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch>=2.5",
        "diffusers>=0.35",
        "transformers>=4.55",
        "accelerate>=1.10",
        "ftfy",
        "imageio[ffmpeg]",
        "sentencepiece",
        "fastapi[standard]",
    )
)
models = modal.Volume.from_name("orbital-video-models", create_if_missing=True)
app = modal.App("orbital-video", image=image)


@app.cls(gpu="L40S", volumes={"/models": models}, timeout=20 * 60, scaledown_window=120)
class Wan:
    @modal.enter()
    def load(self) -> None:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline

        vae = AutoencoderKLWan.from_pretrained(
            MODEL, subfolder="vae", torch_dtype=torch.float32, cache_dir="/models"
        )
        self.pipe = WanPipeline.from_pretrained(
            MODEL, vae=vae, torch_dtype=torch.bfloat16, cache_dir="/models"
        ).to("cuda")
        models.commit()

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def generate(self, body: dict):
        import tempfile

        import torch
        from diffusers.utils import export_to_video
        from fastapi.responses import Response

        # Wan 2.2's sizes are multiples of 32 and its frame counts 4n+1 (the station sends both).
        frames = self.pipe(
            prompt=str(body["prompt"])[:600],
            negative_prompt=str(body.get("negative", ""))[:600],
            width=int(body.get("width", 480)),
            height=int(body.get("height", 832)),
            num_frames=int(body.get("frames", 121)),
            guidance_scale=5.0,
            num_inference_steps=int(body.get("steps", 30)),
            generator=torch.Generator("cuda").manual_seed(int(body.get("seed", 0))),
        ).frames[0]
        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            export_to_video(frames, f.name, fps=int(body.get("fps", 24)))
            with open(f.name, "rb") as video:
                data = video.read()
        return Response(content=data, media_type="video/mp4")
