"""Qwen2.5-VL 로딩 — zero-shot 과 파인튜닝이 같은 경로를 쓴다.

**Qwen2.5-VL 7B (Apache-2.0) 가 주력이다.** VARCO-VISION 1.7B 는 CC-BY-NC-4.0,
Qwen2.5-VL 3B 는 Qwen Research License 라 **비상업**이고, 실험 2(규모별 비교)의
비교군으로만 쓴다 (`README.md` 7절).

12GB 에 들어가려면 4bit 가 필요하다 — bf16 은 약 16GB 다.
가중치는 `HF_HOME=D:/hf` 에 있다 (C 드라이브 여유가 적다).
"""

from __future__ import annotations

DEFAULT_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct"

# 비상업 라이선스. 실험 2 비교군 전용이고 배포에 쓰지 말 것.
NONCOMMERCIAL = {
    "Qwen/Qwen2.5-VL-3B-Instruct": "Qwen Research License",
    "NCSOFT/VARCO-VISION-2.0-1.7B": "CC-BY-NC-4.0",
}


def load(name: str = DEFAULT_MODEL, four_bit: bool = True, max_pixels: int | None = None):
    """(processor, model) 을 낸다. `max_pixels` 로 토큰 수를 제어한다."""
    import torch
    from transformers import (AutoProcessor, BitsAndBytesConfig,
                              Qwen2_5_VLForConditionalGeneration)

    kw = {"max_pixels": max_pixels} if max_pixels else {}
    proc = AutoProcessor.from_pretrained(name, **kw)
    quant = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16) if four_bit else None
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        name, dtype=torch.bfloat16, device_map="cuda:0", quantization_config=quant)
    model.eval()
    return proc, model


def ask(proc, model, image, prompt: str, max_new_tokens: int = 48) -> str:
    """이미지 한 장에 대해 결정적으로(do_sample=False) 답을 받는다."""
    import torch

    msg = [{"role": "user", "content": [{"type": "image", "image": image},
                                        {"type": "text", "text": prompt}]}]
    text = proc.apply_chat_template(msg, tokenize=False, add_generation_prompt=True)
    inp = proc(text=[text], images=[image], return_tensors="pt").to(model.device)
    with torch.inference_mode():
        out = model.generate(**inp, max_new_tokens=max_new_tokens, do_sample=False)
    return proc.batch_decode(out[:, inp.input_ids.shape[1]:],
                             skip_special_tokens=True)[0]
