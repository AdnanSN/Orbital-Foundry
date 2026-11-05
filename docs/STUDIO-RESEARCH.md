# Faceless channel studio: research

> Checked 2026-11-05 for the switch to a faceless video studio (DECISIONS D-049). Free allowances,
> licences and platform rules change often: re-check anything older than a few months. Rows marked
> "third-party" come from summaries, not the provider's own pages; confirm them at the source when a
> stage relies on them.

## 1. The short version

- **It can all start free.** Every step has a free first choice that we may use for published
  content, and at least one free fallback (§3). The only paid piece is your ElevenLabs Creator plan,
  which you already have.
- **The real gates are the platforms, not the tools.** YouTube's upload API is open: 100 uploads a
  day per project, and the private-only lock on unverified projects was lifted in October 2026.
  Instagram's API can post Reels to your own professional account. TikTok's API posts publicly only
  after an audit; until then it can put drafts in your TikTok inbox, and you tap Post.
- **Quality beats volume.** YouTube's inauthentic-content policy (July 2025, with channel-level
  enforcement since January 2026) is the biggest risk for an AI channel. The pipeline is built around
  originality and retention, with caps (§2.4).
- **The "free Higgsfield" repos are free interfaces to paid APIs.** Open-Higgsfield-AI and
  Open-Generative-AI ask for a Muapi key, and Muapi charges per generation. The free equivalents are
  open video models on our own GPU, Modal's free monthly credits, and camera moves on stills (§5).
- **Claude Motion (Claude Design's video feature) has no API.** It builds animations as code and
  exports MP4, by hand in claude.ai. HyperFrames (HeyGen, Apache-2.0) renders the same kind of
  code-built animation automatically, and it can start from a Claude Design design. So Claude Design
  is where the channel's look gets designed, and HyperFrames is where the station renders every
  episode (§5).
- **Pexels has paused new API keys.** Pixabay, public-domain archives (NASA, Wikimedia, the Internet
  Archive) and our own clip library take its place.
- **This laptop can do it, slowly.** Its RTX 3050 (6 GB) can run LTX-2 through Wan2GP (a community
  report: 10 seconds at 720p in 9 to 10 minutes on a 6 GB RTX 3060), so AI clips are an overnight job
  for hooks and key moments. Disk is tighter: 59 GB free.

## 2. What the platforms allow

### 2.1 YouTube

| Topic | Finding |
|---|---|
| Upload API | Data API v3 `videos.insert`, with resumable upload. Free. |
| Unverified projects | Google staff on the issue tracker (2026-10-13): the forced-private restriction on uploads from unverified API projects "was recently lifted". `privacyStatus` can be public or unlisted, and scheduled `publishAt` releases are honoured. Some docs still say otherwise, so the first upload goes out unlisted as a check. |
| Quota | September 2026 calculator (third-party, Outstand): 100 `videos.insert` calls a day per project, 100 `search.list` calls a day, and 10,000 units a day for the rest (`videos.list` 1, `videos.update` 50, `thumbnails.set` 50, `captions.insert` 400). |
| OAuth | Uploading needs a sensitive scope (`youtube.upload`). An unverified app shows a warning screen and is capped at 100 users, which is fine for your own channel. Google gives 7-day refresh tokens to apps left in "Testing", so the consent screen goes to "In production". |
| AI disclosure | Required for realistic altered or synthetic content. The API field is `status.containsSyntheticMedia`, the creator's self-declaration (Google staff, issue tracker, 2026-09-21). |
| Shorts | Vertical or square videos up to 3 minutes. |
| Monetization | Partner Program: 1,000 subscribers plus 4,000 public watch hours in 12 months, or 10 million Shorts views in 90 days (long-standing thresholds; re-check before relying on them). |

### 2.2 TikTok

| Topic | Finding |
|---|---|
| API | Content Posting API, in two modes: Direct Post, or Upload (a draft in the creator's inbox). |
| Before the audit | "All content posted by unaudited clients will be restricted to private viewing mode" (TikTok's docs). Unaudited clients post `SELF_ONLY` only, for at most 5 creators in 24 hours. Upload-to-inbox needs no audit: the creator finishes and posts in the app (third-party, Outstand). |
| The audit | A review of the posting experience from a screen recording: creator info fetched from TikTok and shown before posting, the disclosure toggles, a preview and consent, links to TikTok's policies, live legal pages. |
| AI label | `is_aigc` on Direct Post ("Creator labeled as AI-generated"; third-party, upload-post). |
| Monetization | Creator Rewards pays only for videos over 1 minute (thresholds around 10,000 followers and 100,000 views in 30 days; re-check). |

### 2.3 Instagram

| Topic | Finding |
|---|---|
| API | Instagram API with Instagram Login; a professional (Business or Creator) account; a container flow (create, wait until processed, publish). |
| Reels | Up to 15 minutes through the API, with a resumable upload of the local file to `rupload.facebook.com`, so no public video URL is needed (third-party, Postproxy). Containers expire after 24 hours. |
| Limits | 100 API-published posts per account in a moving 24 hours (Meta's docs). Read `content_publishing_limit` instead of hardcoding it. |
| App review | Not needed to post to accounts that have a role in your own app (development mode). |
| AI label | Meta shows "AI info" from C2PA and IPTC signals and from self-disclosure. Which API field sets it gets checked when Stage 17 is built. |

### 2.4 Policy: what gets AI channels demonetized

- **Inauthentic content.** YouTube renamed "repetitious content" to "inauthentic content" on
  2025-07-15. In January 2026 one coordinated wave removed channels with about 35 million
  subscribers from the Partner Program (third-party timeline, air.io). On Creator Insider
  (2026-07-16), YouTube's VP of Trust & Safety split the policy into generic or repetitive content,
  unsatisfying or off-putting content, and AI personas on sensitive topics.
- **What that means for the design.** Each video needs original research and a point of view.
  Formats, structure and visuals vary. Volume is capped, and raised only while retention holds. The
  narrator is never presented as a real person, and sensitive topics (health, finance, news,
  elections) stay out. No reused content: no other people's clips, no Reddit posts read aloud, no
  film or TV recaps.
- **Copyright.** Every asset keeps its licence, and credits go in the description where a licence
  asks for them. Music causes most Content ID claims, so it comes from licensed libraries or our own
  generations.

## 3. The stack, step by step

"Live" means we may use it for content we publish (the live lane, D-001). Every row has a free first
choice and a free fallback; the last column becomes a config change once there is revenue.

| Step | First choice (free, live) | Free fallbacks | Sandbox only | Paid later |
|---|---|---|---|---|
| Ideas and trends | YouTube Data API: most-popular charts and competitors' uploads (1 unit a read), search (100 a day) | Google Trends' "trending now" RSS feed, Wikipedia's page-views API, your own ideas | — | Google Trends API (alpha, by application), keyword tools |
| Research | Allowlisted web research (Wikipedia, NASA and others per channel) | — | — | Search APIs |
| Scripts, titles, copy | Groq `gpt-oss-120b` and `gpt-oss-20b` (per model: 1,000 requests and 200K tokens a day) | Cloudflare Llama 3.3 70B, Mistral Small 3.1 | NVIDIA trial, FreeLLMAPI pool | Claude or GPT APIs |
| Voice-over | ElevenLabs Creator: 121,000 credits a month, commercial licence | Kokoro-82M (Apache-2.0) on this laptop, unlimited; Cloudflare's speech models (MeloTTS, Deepgram Aura; to confirm in the census) | Edge TTS (an unofficial client of Microsoft's service) | ElevenLabs Pro: 600,000 credits for $99 |
| Word timings, captions | ElevenLabs' alignment, returned with the speech | whisper.cpp (MIT) on this laptop; Cloudflare Whisper | — | — |
| Motion graphics, render | HyperFrames (Apache-2.0): HTML, CSS and seekable animation to MP4 through headless Chrome and FFmpeg | Remotion (free for individuals and companies of up to 3); plain FFmpeg assembly | — | HyperFrames on AWS Lambda |
| Stock footage | Our own clip library first, then the Pixabay API (free key; 100 requests a minute; cache 24 hours; download, don't hotlink) | NASA Image and Video Library (public domain, no endorsement implied), Wikimedia Commons, Openverse, Internet Archive (licence per item) | — | Storyblocks, Artgrid |
| AI stills | Cloudflare FLUX.1-schnell (Apache-2.0; about 36 images a day in practice, shared with thumbnails) | Local FLUX.1-schnell or SDXL-class models on the RTX 3050, overnight | NVIDIA FLUX (trial) | Nano Banana, Imagen, Ideogram |
| Camera moves on stills | Depth Anything V2 Small (Apache-2.0) and a parallax shader: push-in, dolly, orbit, crane | Ken Burns pan and zoom | — | Higgsfield's camera presets |
| AI video clips | LTX-2 (free for commercial use under $10M revenue) or Wan 2.2 (Apache-2.0) on this laptop through Wan2GP | Modal: $30 of compute a month; Kaggle: about 30 GPU hours a week | Hunyuan-based models such as FramePack (licence excludes the EU, the UK and South Korea); shared Hugging Face Spaces | Kling, Seedance, Veo through Muapi, fal, kie.ai or the Higgsfield API |
| Music | Our own library: YouTube Audio Library tracks (you download them), CC0 | ACE-Step 1.5 (MIT, under 4 GB of VRAM) beds made locally; ccMixter with the commercial-use filter (credits) | — | ElevenLabs Music |
| Sound effects | A Freesound CC0 library | ElevenLabs sound effects (credits) | — | — |
| Thumbnails | Thumbnail Studio (Stage 8): scene, cut-out, hook, phone-size QA | Frames from the video; code-drawn scenes | — | — |
| Vision QA | Cloudflare Mistral Small 3.1 | Deterministic checks: FFmpeg's black, freeze and silence detection, loudness, contrast | NVIDIA's vision models | — |
| Publishing | YouTube Data API; Instagram API; TikTok upload to inbox | An upload kit for posting by hand | — | TikTok Direct Post after the audit; posting services |
| Analytics | YouTube Analytics API, Instagram Insights, TikTok's video stats | Entered by hand | — | — |

**Voice.** ElevenLabs charges about 1 credit per character on Multilingual v2 and v3 and half that
on Flash, so 121,000 credits are about 121 minutes, or about 240 on Flash (third-party plan
summaries, October 2026). The Creator plan bills usage past its quota (about $0.18 a minute), so the
station keeps its own hard cap. The speech-with-timestamps endpoint returns the alignment needed for
captions that land on each word, as claude-faceless-shorts-creator does. Kokoro-82M runs on a CPU in
Node through `kokoro-js` (as in short-video-maker). Chatterbox (MIT) is an optional expressive local
voice for later.

**Render.** Claude Motion builds an animation "as code that animates the text, charts, shapes, and
images in it" and "doesn't use a video generation model" (Claude Help Center). HyperFrames is the
open equivalent we can automate: plain HTML that agents write well, frame-accurate seekable
animation, a catalog of captions, charts, maps, transitions and overlays, and it needs only Node 22
and FFmpeg. Remotion is the mature alternative, but it is React-based and its licence is
source-available.

**Stock.** Pixabay's API terms: 100 requests per 60 seconds by default, results cached for 24 hours,
"do not send lots of automated queries", and images downloaded rather than hotlinked. So the station
searches sparingly and keeps what it downloads in its own library, tagged for reuse. Pexels' API page
says "New API key issuance is currently paused" (checked 2026-11-05).

**AI video on this GPU.** A community report has LTX-2 through Wan2GP making 10 seconds at 720p in 9
to 10 minutes on a 6 GB RTX 3060 laptop GPU. The RTX 3050 has fewer cores, so expect it to be slower;
Stage 18 benchmarks it. Hildegard (AGPL-3.0), a local "Higgsfield and ElevenLabs alternative" built
on ComfyUI, picks no video model for GPUs under 12 GB yet. Modal's Starter plan gives $30 of compute a
month with per-second GPU billing; Kaggle gives about 30 GPU hours a week in notebooks. Colab's free
tier is meant for interactive use, so it isn't in the plan.

**Music.** ACE-Step 1.5 (MIT) runs in under 4 GB of VRAM with offloading. YouTube's Audio Library is
the safest source for YouTube, but it has no API, so you download tracks into the library folder.
Tracks from other libraries can still draw Content ID claims, which is why every track keeps its
licence record.

## 4. Repositories reviewed

| Repo | Licence | What it is | What we take |
|---|---|---|---|
| [harry0703/MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | MIT | Python: topic → script → Pexels or Pixabay footage → many voices (Edge, ElevenLabs, Kokoro, Chatterbox, Gemini and more) → subtitles → music; web UI and API | The overall flow and its provider list; could run as a Docker sidecar fallback |
| [gyoridavid/short-video-maker](https://github.com/gyoridavid/short-video-maker) | MIT (Remotion's licence applies) | TypeScript: Remotion, Kokoro.js, whisper.cpp and Pexels behind a REST API and an MCP server | Proof that Kokoro, whisper.cpp and a headless renderer work in Node; it needs a Pexels key |
| [hassancs91/claude-faceless-shorts-creator](https://github.com/hassancs91/claude-faceless-shorts-creator) | MIT | Claude Code skills with Remotion and ElevenLabs word timings: hook grammar, seamless loops, frame QA at phone size, an SFX library | Craft rules for our playbooks; captions from ElevenLabs' alignment |
| [jnMetaCode/openshorts](https://github.com/jnMetaCode/openshorts) | MIT | A local-first shorts pipeline (Ollama, Remotion) | A reference for the $0 path |
| [AbdullahNaveed/ai-shorts-generator](https://github.com/AbdullahNaveed/ai-shorts-generator) | not checked | A reuse-first clip library, FLUX stills animated by Wan, faster-whisper captions, FFmpeg | The library-first idea |
| [Chamanrajragu/purffle-shorts](https://github.com/Chamanrajragu/purffle-shorts) | not checked | A Python shorts maker with upload and scheduling, and Reddit-story videos | Reference only: Reddit stories are reused content |
| [Autom8AI/Open-Higgsfield-AI](https://github.com/Autom8AI/Open-Higgsfield-AI), [Anil-matcha/Open-Generative-AI](https://github.com/anil-matcha/open-generative-ai) | MIT | Studio interfaces over Muapi's paid API (hundreds of image and video models) | The paid lane, later |
| [baney75/hildegard](https://github.com/baney75/hildegard) | AGPL-3.0 | A local studio on ComfyUI: video (Wan 2.2 5B needs 12 GB or more, LTX-2.5 24 GB), voices, an MCP server | Later, with a bigger GPU |
| deepbeepmeep/Wan2GP | not checked | A low-VRAM runner for Wan, LTX and other video models | Our local GPU worker candidate (Stage 18) |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | Apache-2.0 | HTML to MP4 for agents: a catalog of blocks, Claude Code skills, a guide for starting from Claude Design | Our renderer |
| remotion-dev/remotion | source-available | React to MP4 | The fallback renderer |
| [ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5) | MIT | Open music generation | Music beds |
| hexgrad Kokoro-82M (`kokoro-js`) | Apache-2.0 | A small, natural-sounding TTS model | The local voice |
| ggml-org/whisper.cpp | MIT | Speech to text with word timings | Caption timing |
| TechBeme/open-higgsfield, somnei-studio, gencraft, nosub-studios, reflow-studio-oss | — | Studios over Freepik, Vertex AI, kie.ai or fal | Paid lanes only |
| Browser-bot uploaders (for example MoneyPrinterV2's Selenium upload) | — | Posting through the websites | Not used: against the platforms' terms |

## 5. The two things you asked about

### A repo that gives Higgsfield's features for free

- Open-Higgsfield-AI (Autom8AI, from Anil-matcha) is MIT and self-hostable, but its setup says
  "You'll be prompted to enter your Muapi API key on first use", and Muapi is pay-as-you-go (a few
  cents to about $0.30 a generation, per a third-party summary). The software is free; the
  generations are not.
- What *is* free: open video models on our GPU (LTX-2, Wan 2.2) and on Modal's free credits;
  Higgsfield's signature camera moves, done on stills with a depth map; and, once there is revenue,
  the same model families (Kling, Seedance, Veo, Higgsfield's own API) as paid providers in
  `config/media.yaml`.

### Claude Design can create videos

- That is Claude Motion: an artifact made from the Motion template, built by Claude as code, that
  plays like a short video and exports as MP4. It needs a Pro, Max or Ultra plan (on by default for
  Team, off by default for Enterprise). It makes no realistic footage or people, and it has no API,
  so the station can't call it.
- How it fits: the channel's motion identity (intro, lower thirds, chart and list styles, end
  screens) is designed in Claude Design or Claude Motion, by you or with a Claude session.
  HyperFrames has a guide for starting from a Claude Design design ("keep the look, rebuild only what
  has to move"), so those designs become HyperFrames templates that the station fills for every
  episode. One-off pieces can also be exported to MP4 and dropped into the library.

## 6. This laptop

| Part | Value | What it means |
|---|---|---|
| GPU | RTX 3050 Laptop, 6 GB (driver 595.97) | Voice, captions, depth maps, NVENC encoding and ACE-Step are fine. AI video runs in overnight batches. |
| RAM | 16 GB | One GPU job at a time; renders and model jobs take turns. |
| Disk | 59 GB free of 930 GB (94% used) | The tightest resource. Models need about 15 to 25 GB, and a long-form with its working files 2 to 5 GB. Working files are cleaned up after publishing, the library has a size cap, and archives can go to an external drive (`ORBITAL_BACKUP_DIR`). |
| FFmpeg | not installed | Stage 13 installs it, with your OK. |
| Python 3.12, uv, Docker | installed | For the GPU worker and optional sidecars. |

## 7. Budget math

A month at the starting cadence: 4 long-form videos and 30 shorts. A 10-minute script is about 1,400
words, or 8,500 characters; a 45-second short is about 110 words, or 650 characters.

| Resource | Free allowance | Per long-form | Per short | A month |
|---|---|---|---|---|
| ElevenLabs credits | 121,000 a month | about 8,500 (v3) | about 650 (v3), 330 (Flash) | about 54,000 on v3, leaving room for retakes and sound effects |
| Cloudflare images | about 36 a day in practice | about 12 stills and 3 thumbnails | about 3 | fits, when stock and motion graphics come first |
| Groq tokens | 200K a day per model | about 50K | about 10K | fits easily |
| YouTube uploads | 100 a day | 1 | 1 | trivial |
| Local GPU | overnight | about 6 AI clips (hooks, key moments) | about 1 | roughly 25 to 30 clips a night (estimate, Stage 18 measures it) |
| Modal | $30 a month | bursts only | — | hard-capped below $30 |

## 8. Open questions for the stages

- Do YouTube's docs and the lifted lock agree? The first upload goes out unlisted as a check
  (Stage 17).
- Which Instagram API field sets the AI label (Stage 17)?
- How long do TikTok's app review and audit take for a one-creator app (Stage 12 onward)?
- The real speed of LTX-2 and Wan 2.2 on the RTX 3050 (Stage 18).
- Whether Cloudflare's speech models pass the census for the live lane (Stage 13).

## 9. Sources (checked 2026-11-05)

**Platforms:**

- YouTube's upload lock lifted (Google issue tracker): https://issuetracker.google.com/issues/572863050
- YouTube quota and OAuth (third-party, Outstand): https://www.outstand.so/blog/youtube-api-pricing-quota
- `videos.insert` reference: https://developers.google.com/youtube/v3/docs/videos/insert
- `containsSyntheticMedia` is the creator's self-declaration (Google issue tracker):
  https://issuetracker.google.com/issues/564522519
- YouTube's AI disclosure rules: https://support.google.com/youtube/answer/14328491
- YouTube monetization timeline 2025–2026 (third-party, air.io):
  https://air.io/en/monetization/youtube-monetization-policy-changes-2026-a-complete-dated-timeline
- Creator Insider on inauthentic content (2026-07-16): https://www.youtube.com/watch?v=14Vm0CiyUVE
- TikTok Direct Post reference: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- TikTok's audit and posting modes (third-party, Outstand): https://www.outstand.so/blog/tiktok-content-posting-api
- AI-label fields across platforms (third-party, upload-post): https://docs.upload-post.com/guides/ai-content-labeling/
- Instagram content publishing (Meta): https://developers.facebook.com/documentation/instagram-platform/content-publishing
- Instagram Reels resumable upload (third-party, Postproxy): https://postproxy.dev/blog/post-to-instagram-via-api/

**Tools and models:**

- ElevenLabs pricing: https://elevenlabs.io/pricing; plan details (third-party):
  https://www.cartesia.ai/learn/elevenlabs-pricing and https://www.cekura.ai/blogs/elevenlabs-pricing
- Claude Motion: https://support.claude.com/en/articles/17454997-get-started-with-claude-motion
- HyperFrames: https://github.com/heygen-com/hyperframes; starting from a design:
  https://hyperframes.heygen.com/guides/design-tools
- Pexels API (new keys paused): https://www.pexels.com/api/; limits: https://www.pexels.com/api/documentation/
- Pixabay API: https://pixabay.com/api/docs/
- LTX licence: https://ltx.io/model/license
- LTX-2 on Wan2GP with 6 GB of VRAM (community):
  https://www.reddit.com/r/StableDiffusion/comments/1qaqmoo/ltx2_on_wan2gp_with_the_new_update_rtx_3060_6gb/
- ACE-Step 1.5: https://arxiv.org/html/2602.00744v1; licence:
  https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE
- Modal pricing: https://modal.com/pricing; free GPU tiers compared:
  https://modal.com/resources/best-free-cloud-gpu-tiers
- Muapi pricing: https://muapi.ai/docs/pricing
- Google Trends API (alpha): https://developers.google.com/search/blog/2025/07/trends-api

**Repository lists:**

- https://github.com/topics/faceless-video
- https://github.com/topics/higgsfield-alternative
