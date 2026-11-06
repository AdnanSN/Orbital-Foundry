# The GPU lane: setting up AI video clips (Stage 18)

The studio asks for a few seconds of AI video where a script's shot list says `ai-video` (hooks and
key moments). Approved scripts queue those clips; the station makes them overnight (23:00 to
07:00) or while the GPU is idle, and a clip that isn't ready by its deadline (12 hours) is replaced
by footage or a still with a camera move. Nothing here is required: without a generator, videos
are made exactly as before.

Check the machine first:

```bash
npm run gpu -- status
```

## 1. The local worker: ComfyUI on the RTX 3050

**This needs your OK first: the downloads below are about 18 GB, and the disk has about 55 GB
free.** Keep ComfyUI and its models outside the repo, on another drive if you have one.

1. Download ComfyUI's Windows portable build for NVIDIA from
   https://github.com/comfyanonymous/ComfyUI/releases and unpack it, for example to
   `C:\ComfyUI`.
2. Put Wan 2.2 TI2V-5B (Apache-2.0) in its `models` folder, from
   https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged (check each file's size on the
   page before downloading):
   - `split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors` → `models/diffusion_models/`
   - `split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` → `models/text_encoders/`
   - `split_files/vae/wan2.2_vae.safetensors` → `models/vae/`
3. Start it with `run_nvidia_gpu.bat`. With 6 GB of VRAM, ComfyUI moves parts of the model to
   system memory as it needs to; that is slower, and the benchmark shows how much.
4. Check the workflow: open ComfyUI at http://127.0.0.1:8188, load Wan 2.2's 5B text-to-video
   template, and make one clip by hand. If our file `config/gpu/wan22-ti2v-5b.api.json` doesn't
   match your ComfyUI version, export the template with **Export (API)** and put
   `{{prompt}}`, `{{negative}}`, `{{width}}`, `{{height}}`, `{{frames}}`, `{{fps}}` and `{{seed}}`
   where those values go (`{{job}}` in the file name prefix keeps clips apart).
5. Benchmark it:

   ```bash
   npm run gpu -- bench
   ```

   It makes one 5-second 480p clip per workflow in `config/gpu/`, with the time and peak VRAM, and
   names the fastest. Results go to `data/artifacts/gpu/bench/`.

**If it's too slow or doesn't fit:** a GGUF version of the 5B model (with the ComfyUI-GGUF custom
node) needs less memory and disk. The roadmap also names Wan2GP (a low-VRAM app with LTX-2 and
Wan profiles) and Wan 2.1's 1.3B model. Wan2GP has no stable API, so time a clip in its own window
and compare it with the benchmark. If it wins clearly, it needs an adapter of its own.

**Licences:** Wan 2.2 is Apache-2.0. LTX-2 is free for commercial use under $10M a year in
revenue. Hunyuan-based models stay out of the live lane (their licence excludes the EU, the UK and
South Korea), and config validation refuses one there.

## 2. The burst lane: Modal (optional)

Modal's free plan includes $30 of compute a month. The station caps its own spend at $25
(`config/gpu.yaml`) and only sends a clip there when the laptop can't make it in time.

1. Make an account at https://modal.com and install the client: `pip install modal`, then
   `modal setup` (it signs you in through the browser).
2. Deploy our app (Wan 2.2 TI2V-5B on an L40S): `modal deploy infra/modal/video.py`. It prints the
   endpoint URL.
3. In Modal's dashboard, create a proxy auth token (Settings → Proxy Auth Tokens).
4. Add to `.env`, then restart the station:

   ```
   MODAL_VIDEO_URL=https://<your-workspace>--orbital-video-wan-generate.modal.run
   MODAL_KEY=wk-...
   MODAL_SECRET=ws-...
   ```

The first call downloads the weights into a Modal Volume, so it takes several minutes; later cold
starts are faster.

## 3. Paid providers (off)

`fal-video` in `config/media.yaml` reaches Kling, Seedance, Veo and others through fal's queue
API. It stays off until you set `enabled: true` there, a `FAL_KEY`, and a monthly cap above 0 in
`config/gpu.yaml`, and a terms check moves it to the live lane (D-060). Muapi, kie.ai and the
Higgsfield API would each need an adapter and their own terms check.
