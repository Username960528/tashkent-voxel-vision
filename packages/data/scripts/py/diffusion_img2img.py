import argparse
import json
import math
import os
import sys
import time

from PIL import Image


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def _pick_device(requested, torch):
    req = (requested or "").strip().lower()
    if req in ("auto", ""):
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    if req in ("cuda", "cpu", "mps"):
        return req
    raise ValueError(f"unsupported --device: {requested}")


def _pick_dtype(device, torch):
    # fp16 saves memory; for CPU keep fp32.
    #
    # NOTE: On Apple Silicon (MPS), SDXL fp16 can produce NaNs/black outputs with some torch/diffusers
    # versions. Default to fp32 for correctness. If we later add a CLI dtype override, mps+fp16 can be
    # re-enabled for experimentation.
    if device == "cuda":
        return torch.float16
    return torch.float32


def _to_multiple_of_8(img):
    w, h = img.size
    w2 = max(8, (w // 8) * 8)
    h2 = max(8, (h // 8) * 8)
    if (w2, h2) == (w, h):
        return img, (w, h), (w, h)
    resized = img.resize((w2, h2), resample=Image.Resampling.LANCZOS)
    return resized, (w, h), (w2, h2)


def main():
    ap = argparse.ArgumentParser(description="Diffusion img2img stylizer (no training).")
    ap.add_argument("--in_png", required=True, help="Input PNG path")
    ap.add_argument("--out_png", required=True, help="Output PNG path")
    ap.add_argument("--report_json", default="", help="Optional JSON report output path")

    ap.add_argument("--model", required=True, help="Diffusers model id or local path")
    ap.add_argument("--lora", default="", help="Optional LoRA weights (HF repo id or local path)")
    ap.add_argument("--lora_scale", type=float, default=0.8, help="LoRA scale (default: 0.8)")
    ap.add_argument(
        "--prompt",
        default="isometric pixel art city, crisp pixels, game art, clean outlines, detailed buildings, high quality",
        help="Positive prompt",
    )
    ap.add_argument(
        "--negative",
        default="blurry, low quality, artifacts, watermark, text, logo, deformed, noisy",
        help="Negative prompt",
    )
    ap.add_argument("--strength", type=float, default=0.35, help="Denoise strength 0..1 (default: 0.35)")
    ap.add_argument("--steps", type=int, default=28, help="Inference steps (default: 28)")
    ap.add_argument("--guidance", type=float, default=5.5, help="CFG guidance scale (default: 5.5)")
    ap.add_argument("--seed", type=int, default=0, help="Seed (default: 0). Use -1 for random.")
    ap.add_argument("--device", default="auto", help="auto|cuda|mps|cpu (default: auto)")
    args = ap.parse_args()

    # HuggingFace Hub uses HF_TOKEN; allow our `.env` to provide HUGGINGFACE_HUB_TOKEN.
    if os.environ.get("HUGGINGFACE_HUB_TOKEN") and not os.environ.get("HF_TOKEN"):
        os.environ["HF_TOKEN"] = os.environ["HUGGINGFACE_HUB_TOKEN"]
    # Speed up large model downloads when `hf_transfer` is available.
    try:
        import hf_transfer  # noqa: F401

        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    except Exception:
        pass

    if not os.path.exists(args.in_png):
        raise SystemExit(f"missing input: {args.in_png}")
    if not (math.isfinite(args.strength) and 0.0 < args.strength <= 1.0):
        raise SystemExit("--strength must be in (0, 1]")
    if args.steps <= 0:
        raise SystemExit("--steps must be > 0")
    if not (math.isfinite(args.guidance) and args.guidance >= 0.0):
        raise SystemExit("--guidance must be >= 0")
    if not (math.isfinite(args.lora_scale) and 0.0 <= args.lora_scale <= 2.0):
        raise SystemExit("--lora_scale must be in [0, 2]")

    # Heavy imports only when actually running this optional script.
    try:
        import torch  # noqa: F401
        from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline  # noqa: F401
    except Exception as e:
        msg = str(e)
        raise SystemExit(
            "Missing diffusion dependencies. Install the optional venv:\n"
            "  python3 -m venv packages/data/.venv-diffusion\n"
            "  packages/data/.venv-diffusion/bin/pip install -r packages/data/scripts/py/requirements-diffusion.txt\n"
            f"\nImport error: {msg}"
        )

    import torch
    from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline

    device = _pick_device(args.device, torch)
    dtype = _pick_dtype(device, torch)

    img = Image.open(args.in_png).convert("RGB")
    img8, orig_size, resized_size = _to_multiple_of_8(img)

    t0 = time.time()

    # Load fp16 weights when available to reduce download size and memory usage.
    # Some repos (like SDXL) provide `*.fp16.safetensors` variants.
    from_pretrained_kwargs = {"torch_dtype": dtype, "use_safetensors": True}
    if dtype == torch.float16:
        from_pretrained_kwargs["variant"] = "fp16"

    # Prefer explicit pipelines over AutoPipelineForImage2Image because AutoPipeline imports many optional
    # pipelines and can break when some downstream dependencies are missing or renamed.
    #
    # We try SDXL first (works for most "xl" models), then fall back to SD 1.x.
    pipe = None
    pipe_kind = None
    errors = []
    for kind, cls in (
        ("sdxl_img2img", StableDiffusionXLImg2ImgPipeline),
        ("sd_img2img", StableDiffusionImg2ImgPipeline),
    ):
        try:
            try:
                pipe = cls.from_pretrained(args.model, **from_pretrained_kwargs)
            except Exception as e:
                # If fp16 variant isn't present, retry without `variant`.
                if from_pretrained_kwargs.get("variant"):
                    kwargs2 = dict(from_pretrained_kwargs)
                    kwargs2.pop("variant", None)
                    pipe = cls.from_pretrained(args.model, **kwargs2)
                else:
                    raise e
            pipe_kind = kind
            break
        except Exception as e:
            errors.append(f"{kind}: {e}")
            pipe = None
            pipe_kind = None
    if pipe is None:
        joined = "\n".join(errors) if errors else "(no details)"
        raise SystemExit(f"Failed to load img2img pipeline for model '{args.model}':\n{joined}")
    # Make it easier to run on consumer hardware.
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass

    lora = (args.lora or "").strip()
    lora_scale = float(args.lora_scale)
    cross_attention_kwargs = None
    if lora:
        try:
            pipe.load_lora_weights(lora)
            cross_attention_kwargs = {"scale": lora_scale}
        except Exception as e:
            raise SystemExit(f"Failed to load LoRA weights '{lora}': {e}")

    pipe = pipe.to(device)

    generator = None
    seed = int(args.seed)
    if seed == -1:
        seed = int.from_bytes(os.urandom(2), "big")
    try:
        generator = torch.Generator(device=device).manual_seed(seed)
    except Exception:
        # Some backends don't accept a device-bound generator.
        generator = torch.manual_seed(seed)

    call_kwargs = dict(
        prompt=args.prompt,
        negative_prompt=args.negative,
        image=img8,
        strength=float(args.strength),
        num_inference_steps=int(args.steps),
        guidance_scale=float(args.guidance),
        generator=generator,
    )
    if cross_attention_kwargs is not None:
        call_kwargs["cross_attention_kwargs"] = cross_attention_kwargs

    try:
        out = pipe(**call_kwargs).images[0]
    except TypeError:
        # Some pipelines may not accept `cross_attention_kwargs`. Fall back to scale=1.0 behavior.
        call_kwargs.pop("cross_attention_kwargs", None)
        out = pipe(**call_kwargs).images[0]

    # Match the original size for downstream pixel post-processing.
    if out.size != orig_size:
        out = out.resize(orig_size, resample=Image.Resampling.LANCZOS)

    _ensure_dir(os.path.dirname(os.path.abspath(args.out_png)))
    out.save(args.out_png, "PNG")

    dt = time.time() - t0

    report = {
        "in_png": os.path.abspath(args.in_png),
        "out_png": os.path.abspath(args.out_png),
        "model": args.model,
        "pipeline": pipe_kind,
        "lora": lora if lora else None,
        "lora_scale": lora_scale if lora else None,
        "prompt": args.prompt,
        "negative": args.negative,
        "strength": float(args.strength),
        "steps": int(args.steps),
        "guidance": float(args.guidance),
        "seed": int(seed),
        "device": device,
        "dtype": "float16" if dtype == torch.float16 else "float32",
        "orig_size": {"w": int(orig_size[0]), "h": int(orig_size[1])},
        "resized_size": {"w": int(resized_size[0]), "h": int(resized_size[1])},
        "duration_s": float(dt),
    }

    if args.report_json:
        _ensure_dir(os.path.dirname(os.path.abspath(args.report_json)))
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(json.dumps(report, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
