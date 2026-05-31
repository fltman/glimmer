# ai-ps Innovation Roadmap

Synthesis of five research reports (Editors, AI Tools, Browser ML, Novel UX, Pro Workflow) into a single deduped,
prioritized roadmap for **ai-ps** — an AI-first web image editor.

**Stack we are building on (referenced throughout):**
- **Client ML**: ONNX Runtime Web + @huggingface/transformers (WebGPU/WASM). Proven with RMBG-1.4. Same runtime can host
  Depth Anything V2, SAM2/MobileSAM, BiRefNet/MODNet, Florence-2, face-parsing, image-embedding models.
- **WebGL2 compositor**: layers, masks, blend modes, adjustment layers, filters, brushes, liquify, paths, transform.
  Any depth/segmentation map becomes a reusable channel feeding GPU shader passes.
- **AI proxy (keys server-side)**: OpenRouter (Gemini "nano banana" image-gen + instruction-edit; any text LLM),
  fal.ai + Replicate adapters (arbitrary hosted models).
- **Backend**: Python Celery workers, async jobs, WS progress. Existing inpaint pipeline = ROI crop → Gemini edit →
  color-match → feather blend-back.
- **Already shipped (excluded except where a materially better variant exists)**: text2img, generative fill/inpaint,
  outpaint, cutout (RMBG), upscale, select-subject.

**Effort key**: S = days, M = 1-2 wks, L = multi-week. **Wow**: medium / high / very-high.

---

## Cross-cutting foundations (build once, reused everywhere)

Three shared assets recur across ~half the features. Build these first; they collapse the marginal cost of many later items.

- **Depth map (Depth Anything V2 small, ~50MB fp16, client WebGPU)** — feeds lens blur, atmospheric fog, depth grade,
  2.5D parallax, depth-aware relight preview. Compute once per image, cache as a channel.
- **Promptable segmentation (SAM2 / MobileSAM, client WebGPU)** — encode once, decode per click. Feeds click-to-select,
  semantic selection, sky/landscape masks, adaptive presets, trace-erase mask expansion, harmonize masks.
- **Op-graph / non-destructive recipe representation** — already implied by the compositor; formalizing the serializable
  op log unlocks Actions, version history/branching, multiplayer, and the plugin API from one model.
- **Reference/style library UX** — a panel where users pin reference layers (style, color, subject). Built once, reused by
  style-reference, color-match, and subject-consistency features.

---

## Theme 1 — Smarter selection & masking

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **Click-to-Select-Anything (SAM2 / MobileSAM)** | Click any object/region → pixel-accurate mask, refine with +/- clicks, live hover preview | Client ONNX-WebGPU: encode once in a worker, cache embedding, decode per click. Mask → ai-ps mask layer. transformers.js lacks SAM2 → use ORT-Web directly | M | very-high |
| **Semantic selection by language** | "select every car", "the person without a hat", "the brightest window" → instance masks | Literal: Grounded-SAM (Grounding-DINO→SAM) client or fal/Replicate. Reasoning queries: LISA/OpenWorldSAM or OpenRouter vision-LLM to localize, then SAM | M | very-high |
| **People-part component masking** | Face skin / body skin / hair / brows / iris / sclera / lips / teeth / clothes, per detected person | Client face-parsing ONNX (BiSeNet) + MediaPipe FaceMesh (478 landmarks). Each region → auto-mask on adjustment layer; landmarks drive existing liquify | M | high |
| **Landscape/Snow component masking** | Sky / vegetation / water / mountains / architecture / snow one-click masks | Client semantic segmenter (ADE20K/landscape ONNX, or Florence-2). Same pattern as people-part | M | medium |
| **Open-vocab auto-layering** | One command decomposes scene into named selectable masks (sky/person/car/building) | Florence-2-base client (per-module dtype) or fal/Replicate fallback; masks → mask/layer system | M | high |

---

## Theme 2 — Generative editing (reuse the inpaint Celery pipeline)

Highest wow-to-effort because the ROI-crop → Gemini edit → color-match → feather blend-back infra already exists.

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **Reference-Image Generative Fill** | Drop a reference photo of a real object → fill preserves its identity, matches scale/light/perspective | Extend inpaint pipeline to pass a 2nd reference image to OpenRouter/Gemini multi-image edit | S-M | very-high |
| **Harmonize / composite blend-in** | Auto-relight + color/tone match + cast shadows/reflections so a pasted cutout looks native | Background light-direction estimate + Gemini img2img on ROI ("match lighting/color/shadows") OR IC-Light background-conditioned pass (fal/Replicate); existing color-match + feather | M | very-high |
| **Trace Erase (object + shadow + reflection)** | Remove an object AND its shadow/reflection in one stroke | SAM mask + vision-LLM (OpenRouter) to localize attached shadow/reflection → union mask → existing inpaint | M | high |
| **Auto Distraction Finder** | Scan image, find removable distractions (people/wires/trash/signs), category chips, batch remove | Grounding-DINO+SAM (fal/Replicate) or OpenRouter vision-LLM → categorized candidate masks → batch inpaint. New toggle UI | M | high |
| **Reflection Removal (shoot-through-glass)** | Separate transmission vs reflection layer, suppression slider | fal/Replicate hosted SIRR model, async Celery + WS. Pure backend | S-M | high |
| **Reimagine / Variations** | "Give me 4 more like this" — keep vibe, reinvent details | Thin layer over img2img/Gemini: image-embedding conditioning at high creativity, emit 4-up grid | S | medium |
| **Generative Expand w/ prompt** | Smart outpaint: prompt-steered extension + aspect presets + horizon/perspective awareness | Enhance existing outpaint Celery job with prompt + presets + perspective hint | S | medium |
| **Magic Grab** | Tap subject → lifted into its own editable layer while AI heals the hole behind it | Client RMBG/cutout + existing inpaint to heal background + promote to compositor layer. Mostly glue | S-M | high |
| **Canvas Markup-to-Edit** | Circle/scribble/arrow on the image as the instruction | Reuse brush/paths as annotation capture → send marked image to OpenRouter/Gemini edit. Scribble→mask, arrow→placement hint | M | high |
| **Drag-to-edit (point-based)** | Drag a handle to reshape (smile, rotate a car) and the model re-renders around it | WebGL2 transform handles capture src/target points; ROI sent to DragDiffusion/DirectDrag on fal/Replicate. Latency-sensitive → ROI only | L | high |
| **3D object rotation / turn-to-3D** | Spin a 2D layer in apparent 3D; model regenerates hidden sides + harmonizes | Novel-view-synthesis (Zero123/Stable-Zero123-style) on Replicate → composite → Harmonize | L | very-high |
| **Accurate text-in-image / editable text** | Glyph-accurate text generation + "fix the text on this sign" via masked fill | Route text-heavy gens/edits to Ideogram V3 / Recraft V4 (fal/Replicate) instead of Gemini; reuse inpaint ROI for sign fixes | S-M | high |
| **Prompt-to-layer compositional gen** | Generate as separate editable RGBA layers (fg/mid/bg), or a native transparent PNG asset | LayerDiffusion/LayerDiffuse / Qwen-Image-Layered via fal/Replicate; alpha decode server-side → drops straight into layer-native compositor | M | very-high |
| **Generative seamless texture / tiling material** | Tileable texture/pattern from prompt or swatch, optional PBR maps | Existing text2img + outpaint plumbing with a seamless-tiling flag on hosted model; tile preview is a trivial shader | S | medium |

---

## Theme 3 — Relighting (the convergent "very-high wow" cluster)

All four reports independently flag relighting; **IC-Light / IC-Light V2** is the concrete open model.

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **AI Relight (drag-the-light)** | Reposition/add light sources, set color/intensity, fix uneven lighting, change time-of-day | Two-tier: (1) client preview — Depth Anything → normals → Lambertian+specular relight shader; (2) final — IC-Light/V2 on fal/Replicate. Adapter pattern already exists | M-L | very-high |
| **Depth-guided generative relight/harmonize** | "Add a window light from the left"; auto-match composite to scene light | Client depth + matting mask → instant preview shader; OpenRouter Gemini edit + Celery ROI pipeline for photoreal pass | M | very-high |
| **AI Product Staging & background gen** | Drop product onto AI-generated lifestyle scene with matched contact shadows/reflections | Chain: RMBG cutout → background gen (Gemini/Flux) → IC-Light relight+shadow → feather blend. Templated scene presets | M-L | high |
| **Sky Replacement w/ harmonization** | Auto-detect sky, swap for generated/library sky, re-grade foreground to match | Client SAM sky mask + library/Gemini sky + same color-match/harmonize step | M | medium |

---

## Theme 4 — Enhance / restore / depth effects

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **Creative Upscale w/ creativity slider** | 2-16x with Creativity / Resemblance / HDR sliders that invent plausible detail | Tiled diffusion upscale: clarity-upscaler / SUPIR on fal/Replicate per-tile, color-match + feather. Sliders = denoise / tile-conditioning / local contrast | M | very-high |
| **AI Lens Blur (depth bokeh)** | Synthetic DoF, adjustable focus plane, bokeh shape, paintable depth edges | Client Depth Anything V2 → variable-kernel gather/scatter bokeh shader (bright-pixel highlights). Depth = editable channel. No server | M | high |
| **Atmospheric depth (fog/haze/distance grade)** | Volumetric fog + distance-based color grade | Pure WebGL2 shader over the cached depth texture. Near-zero marginal cost | S | medium |
| **2.5D parallax "live photo"** | Single still → looping 3D parallax clip, export MP4/GIF | Client depth + WebGL2 displacement render for preview; disocclusion fill via existing Celery inpaint; frame capture → server ffmpeg | M-L | very-high |
| **High-res hair-level matting** | Soft alpha matting keeping hair/fur/glass at 2K — materially better cutout | Client BiRefNet_lite / MODNet ONNX-WebGPU as "fine/hair" tier next to RMBG "fast"; heaviest cases → fal/Replicate | S | high |
| **Transformer super-res / restoration** | Perceptual SR + JPEG-artifact/de-block + face recovery | Client Swin2SR/Real-ESRGAN ONNX with tiling for small; x4/large → fal/Replicate. Face recovery: GFPGAN/CodeFormer hosted | M | medium-high |
| **AI Denoise / Deblur / Face Recovery** | Texture-preserving denoise, motion/lens deblur, rebuild tiny faces, dust&scratch | CodeFormer/GFPGAN + restoration nets on Replicate/fal; small ONNX face-restore could be client. Non-destructive "Restore" adjustment, face region from select-subject | M | high |
| **Vectorize raster → editable SVG** | Logo/illustration → clean Bezier SVG, pairs with Paths tool | fal/Replicate adapter (Recraft / Vectorizer.AI) → import SVG into existing Paths layer | S-M | medium |
| **Live OCR + smart text layers** | Extract text offline with boxes → copy / translate-in-place / editable text layers | Client TrOCR/Donut ONNX-WebGPU → strings to text layers at box coords; translate via OpenRouter + inpaint original region | M | medium |

---

## Theme 5 — AI-native UX (the strategic differentiators)

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **Conversational on-canvas editing chat** | Multi-turn NL edits ("make it golden hour", "actually warmer", "undo the last sky"), non-destructive each turn | OpenRouter intent LLM routes each turn → Gemini instruction-edit OR a built-in compositor op; conversation state = image version stack + history | M | very-high |
| **Agentic auto-editor** | State a goal ("prep for Instagram: clean bg, brighten, square, teal grade, 3 variants") → agent plans + executes, editable steps | Register each ai-ps op as a typed tool behind OpenRouter function-calling; agent emits plan, runs via Celery, streams step progress over WS; visible step list for override | M-L | very-high |
| **Reference-guided subject consistency** | Pin a person/product/mascot from refs → place "that exact thing" in new scenes/poses, no LoRA | OpenRouter Gemini nano-banana multi-image conditioning (up to ~14 refs). New work = reference-pinning "subject library" UX | S-M | high |
| **Style Reference / Generative Match** | Upload a look → restyle gen/layer to match colors/texture/brushstrokes, strength slider | Style image into OpenRouter/Gemini call, OR IP-Adapter on hosted SDXL via fal/Replicate. Strength = conditioning weight | S-M | high |
| **On-device artistic style transfer** | Apply any reference image's style to a layer in real time, offline | Client ONNX-WebGPU arbitrary style transfer (Magenta-style); writes back through compositor as a filter. Premium tier → Gemini edit | S-M | medium |
| **Real-time generative canvas** | Sub-second re-render as you paint + prompt; strength = sketch-faithful → reimagined | (a) hosted Turbo/LCM via fal/Replicate streaming frames over WS, or (b) distilled few-step model client ONNX-WebGPU. Latency/streaming is the hard part | L | very-high |
| **Animate-image / generative video** | Still or layer → short clip (animate sky/water/hair), motion-brush region, export MP4/GIF | Pure adapter over fal/Replicate (Kling 3.0 / Runway Gen-4.5 / Veo 3.1 / Luma Ray3); async + WS fits perfectly. Motion-brush reuses masks | M | high |

---

## Theme 6 — Pro / color / workflow (serious-editor credibility)

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **AI "apply this edit to all"** | Edit/describe once → propagate per-image-adaptively across a batch | Celery fan-out; OpenRouter NL→params and/or Gemini per-image edit; WS progress. Builds on inpaint/edit pipeline | M | very-high |
| **Personal AI editing-style profile** | Learns your past edits → auto-edits new imports in your signature look | Client ONNX image embedding; backend stores before/after recipe deltas, fits small k-NN/regression → predict recipe per import. Sticky | L | very-high |
| **RAW import & non-destructive Develop module** | Open CR3/NEF/ARW/DNG, Lightroom-style develop panel, stored as recipe | LibRaw-WASM decode → linear float buffer → WebGL2 "develop" shader pass feeding compositor bottom layer. Recipe JSON. No backend | L | very-high |
| **32-bit float / HDR document mode** | True high-bit editing, HDR bracket merge, exposure without banding, tone-map on export | Switch compositor textures to RGBA16F (EXT_color_buffer_float); ACES/exposure display transform. Real gap vs Photopea | M-L | high |
| **Real color management (P3 / ICC / soft-proof)** | Honor embedded ICC, wide-gamut composite, embed on export, CMYK soft-proof | P3 WebGL2 context + color-transform shader passes + ICC parse/embed in file IO. Pure front-end | M | high |
| **Pro color grading suite** | Color wheels (lift/gamma/gain), parametric+point curves, free-range HSL editor | New adjustment-layer shaders (per-channel math, 1D LUTs, soft hue/sat masks) + wheel/curve UI | M | high |
| **Reference color-match / LUT transfer** | Transfer a reference photo's grade/mood, export reusable .cube LUT | Mostly client WebGL2: Reinhard/histogram color transfer = one shader pass (instant); content-aware via semantic masks; optional neural-match backend | S | medium-high |
| **AI smart presets (content-aware)** | "Portrait" softens only skin + brightens eyes; "Landscape" only enhances sky/foliage | Reuse client segmentation + masks + adjustment layers; preset stores adjustment + target-class pairs | S-M | high |
| **Actions / macros + batch + droplets** | Record an op sequence, replay over a folder unattended, drag-drop droplet | Serialize op-stream to JSON action; replay over op-graph; batch client (small) or Celery (scale) with WS | M | high |
| **Version history + named snapshots + branching** | Non-destructive timeline, named snapshots, visual diff/restore, branch-and-compare | Persist op-log/recipe versions per doc (DB); history panel + branch tree + thumbnail render | M | high |
| **AI auto-cull / batch triage** | Rank/group: flag blurry/closed-eyes/dupes, pick sharpest, aesthetic score | Client ONNX (sharpness, eye-open, perceptual-hash dedupe, aesthetic score) + Celery for large batches | M | high |
| **Tethered / camera capture** | Shoot tethered or pull from phone/webcam into a live session, auto-apply preset | WebUSB/PTP or getUserMedia ingest + session structure; reuses develop recipes + Actions. Camera-protocol coverage is the long tail | M-L | medium |

---

## Theme 7 — Collaboration / platform (the moat)

All three ride the same op-graph/doc-tree representation.

| Feature | What | Build on our stack | Effort | Wow |
|---|---|---|---|---|
| **Real-time multiplayer co-editing** | Figma-style presence cursors + live layer/mask/adjustment sync | Server-authoritative, property-level last-writer-wins over WS (Figma's model — not OT/CRDT); fractional indexing for layer order. **Pixel-buffer (brush/liquify) sync via tiled diffs is the genuinely hard sub-problem** | L | very-high |
| **Sandboxed plugin / extension API + marketplace** | 3rd-party panels/filters/tools/export via documented JS API in a sandbox | Plugin API over op-graph + iframe/worker sandbox + capability-gated message bridge; backend marketplace hosting/signing | L | high |
| **Asset libraries (brushes/LUTs/presets/swatches, linked)** | Cloud-synced reusable assets; linked assets update everywhere | Backend asset store + sharing; client library panel + drag-to-canvas + link resolution in op-graph; LUT auto-extract reuses develop pipeline | M | medium |

---

## TOP 10 — build next (ranked by impact × feasibility)

| # | Feature | Theme | Effort | Wow | Differentiation | Why |
|---|---|---|---|---|---|---|
| 1 | **Click-to-Select-Anything (SAM2)** | Selection | M | very-high | **HIGH** | Exact RMBG pattern (ONNX-WebGPU); foundational — its masks feed nearly every other feature. Beats select-subject decisively |
| 2 | **Reference-Image Generative Fill** | Gen edit | S-M | very-high | **HIGH** | Smallest add to the existing inpaint pipeline (2nd image to Gemini); huge for product compositing; few tools do identity-preserving fill |
| 3 | **Conversational on-canvas editing chat** | AI-native UX | M | very-high | **HIGH** | Turns ai-ps from tool-palette into "edit by chatting"; lowest-risk very-high-wow because Gemini edit pipeline already exists |
| 4 | **Harmonize / composite blend-in** | Gen edit / Relight | M | very-high | **HIGH** | Reuses inpaint infra almost free; makes cutout-and-paste actually look real — the perennial pain point |
| 5 | **AI Lens Blur (depth bokeh)** | Enhance / depth | M | high | medium (table-stakes) | First payoff of the shared depth map; pure client, feels instant; expected of a modern editor |
| 6 | **Creative Upscale w/ creativity slider** | Enhance | M | very-high | medium-HIGH | The Magnific differentiator vs plain upscale; tiled diffusion fits the ROI/blend infra; clear premium feature |
| 7 | **Prompt-to-layer compositional generation** | Gen edit | M | very-high | **HIGH** | Uniquely valuable *because* ai-ps is layer-native; competitors return flat bitmaps, we return real RGBA layers |
| 8 | **AI Relight (IC-Light)** | Relight | M-L | very-high | **HIGH** | Flagged by all 5 reports; concrete open model (IC-Light); adapter pattern exists; very few web tools do it well |
| 9 | **AI smart presets (content-aware) + Reference color-match** | Pro/color | S-M | high | medium | Cheap (reuses segmentation + a shader LUT pass); high perceived polish; bundle two low-effort wins |
| 10 | **Agentic auto-editor** | AI-native UX | M-L | very-high | **HIGH** | The strategic standout (matches Adobe Firefly AI Assistant); ai-ps already exposes discrete ops + async jobs, so tool-wrapping is the main work; pairs with #3 |

**HIGH-DIFFERENTIATION (things mainstream tools don't yet do well):** #1 in-browser/private SAM2, #2 identity-preserving
reference fill, #3 conversational editing, #4 true harmonization, #7 prompt-to-real-RGBA-layers, #8 web-native relight,
#10 agentic editor. **Table-stakes (parity, but expected):** #5 lens blur, #6 upscale quality, #9 presets/color-match.

**Sequencing note:** build the **depth map** (unlocks #5 + fog/parallax/relight-preview) and **SAM2** (#1, feeds masks
everywhere) as the first two shared foundations, then the inpaint-pipeline extensions (#2, #4, #6, #7), then the LLM
intent/tool layer shared by #3 and #10.

---

## Not feasible (or not fully) in-browser / with our providers

- **Fully client-side real-time generative canvas** — true zero-latency in-browser diffusion (#Real-time canvas) is not
  reliably feasible yet; distilled few-step models are heavy and quality suffers. Realistic path = hosted Turbo/LCM via
  fal/Replicate streaming over WS. The *latency/streaming UX*, not the model, is the blocker.
- **SAM2/SAM ViT-H encoder fully client-side at full quality** — the encoder can exceed ~200MB. Mitigate with
  tiny/small or MobileSAM encoders, encode-once-in-a-worker + cache; heaviest cases fall back to fal/Replicate.
- **Full BiRefNet HR matting, x4 super-res, photoreal relight on every device** — large client models exhaust WebGPU VRAM.
  Offer a client "fast/fine" tier and gracefully fall back to fal/Replicate + Celery for heavy jobs.
- **WebGPU not universally available** — ~70% global coverage (Chrome/Edge 113+, Android Chrome 121, Firefox Win 141 /
  Jul 2025). Keep the WASM fallback (already done for RMBG) and feature-detect; client-ML features degrade to slower WASM
  or server adapters, not failure.
- **Pixel-buffer (brush/liquify) real-time multiplayer sync** — the genuinely hard sub-problem; property-level sync is
  solved (Figma model) but live tiled pixel diffs across clients are research-grade. Ship property/layer sync first, defer
  collaborative painting.
- **Tethered camera capture coverage** — WebUSB/PTP works but per-camera-vendor support is a long tail; treat broad camera
  compatibility as best-effort, with getUserMedia (phone/webcam) as the reliable baseline.
- **Image-to-video model choice** — Sora is discontinued (Apr 2026). Use Kling 3.0 / Runway Gen-4.5 / Veo 3.1 / Luma Ray3
  via fal/Replicate. (Feasible, just a model-selection constraint.)
- **Client-side RAW + 32-bit float** — feasible (LibRaw-WASM + RGBA16F textures) but the precision/perf tuning across all
  existing shaders is real L-effort work, not a quick win; not a "can't" but a "costs".

---

## De-duplication notes (where the five reports overlapped)

- **Relighting** appeared in 4 of 5 reports (Editors "AI Relight", AI Tools "AI Relight", Browser ML "depth-guided
  relight", Novel UX "AI relighting"). Merged into **Theme 3**; IC-Light/V2 is the shared concrete model.
- **Depth-based effects** (lens blur, fog, parallax, depth grade) appeared across AI Tools, Browser ML, Novel UX, Pro
  Workflow. Merged under one **shared depth map** foundation feeding multiple shader features.
- **Harmonize / composite blend-in** appeared in Editors, AI Tools, Browser ML, plus Product Staging (AI Tools) and Sky
  Replacement — all reuse cutout mask + a relight/color-match step. Consolidated.
- **SAM click-to-select / semantic selection** appeared in AI Tools, Browser ML, Novel UX. Merged in **Theme 1**.
- **Style reference / generative match** appeared in Editors, AI Tools, Novel UX; **reference color-match** in AI Tools
  and Novel UX. Folded into a shared **reference/style library** UX.
- **Conversational + Agentic editing** appeared in Editors, Novel UX (and the Pro batch report). They share one LLM
  intent/tool layer; kept as two entries (chat vs goal-driven) but flagged as the same backend.
- **Creative/perceptual upscale** appeared in AI Tools and Browser ML (Swin2SR/Real-ESRGAN). Merged into one Enhance entry
  with client + hosted tiers. **Surface-swap / material-replace** sneaks were folded into reference/harmonize.
