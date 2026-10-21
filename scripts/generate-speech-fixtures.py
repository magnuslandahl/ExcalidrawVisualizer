"""Generate test-only speech locally; none of these assets are packaged."""

import array
import ctypes
import json
from pathlib import Path
import sys
import wave


root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "release" / "speech-test-deps"))

import espeakng_loader


def main():
    output = root / "release" / "speech-fixtures"
    output.mkdir(parents=True, exist_ok=True)
    engine = espeakng_loader.load_library()
    engine.espeak_Initialize.argtypes = [
        ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int
    ]
    engine.espeak_Initialize.restype = ctypes.c_int
    data = str(Path(espeakng_loader.get_data_path()).parent).encode("utf-8")
    sample_rate = engine.espeak_Initialize(2, 0, data, 0)
    if sample_rate <= 0:
        raise RuntimeError("Could not initialize the synthetic speech engine")

    samples = array.array("h")
    callback_type = ctypes.CFUNCTYPE(
        ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p
    )

    @callback_type
    def capture(audio, count, _events):
        if audio and count > 0:
            samples.extend(audio[:count])
        return 0

    engine.espeak_SetSynthCallback.argtypes = [callback_type]
    engine.espeak_SetSynthCallback(capture)
    engine.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
    engine.espeak_Synth.argtypes = [
        ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
    ]
    fixtures = [
        {
            "language": "sv",
            "text": (
                "Jag vill flytta den bl\u00e5 rutan till v\u00e4nster och \u00e4ndra texten till svenska. "
                "Beh\u00e5ll pilen mellan rutorna och g\u00f6r rubriken st\u00f6rre."
            ),
        },
        {
            "language": "en",
            "text": (
                "Move the blue rectangle to the left and change the text to English. "
                "Keep the arrow between the boxes and make the heading larger."
            ),
        },
    ]
    try:
        for fixture in fixtures:
            samples = array.array("h")
            if engine.espeak_SetVoiceByName(fixture["language"].encode("ascii")):
                raise RuntimeError(f"Missing synthetic voice: {fixture['language']}")
            text = fixture["text"].encode("utf-8") + b"\0"
            if engine.espeak_Synth(text, len(text), 0, 1, 0, 1, None, None):
                raise RuntimeError("Synthetic speech generation failed")
            if engine.espeak_Synchronize() or not samples:
                raise RuntimeError("Synthetic speech generation produced no audio")
            pcm = array.array("h", [0] * 8000)
            for index in range(int(len(samples) * 16000 / sample_rate)):
                position = index * sample_rate / 16000
                left = int(position)
                right = min(left + 1, len(samples) - 1)
                pcm.append(round(
                    samples[left] + (samples[right] - samples[left]) * (position - left)
                ))
            pcm.extend([0] * 8000)
            if sys.byteorder != "little":
                pcm.byteswap()
            fixture["file"] = f"{fixture['language']}.wav"
            with wave.open(str(output / fixture["file"]), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(pcm.tobytes())
        with wave.open(str(output / "silence.wav"), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(bytes(16000 * 2 * 2))
        (output / "manifest.json").write_text(
            json.dumps(fixtures, ensure_ascii=True, indent=2) + "\n", encoding="utf-8"
        )
    finally:
        engine.espeak_Terminate()
    print(f"Generated synthetic Swedish/English speech in {output.name}")


if __name__ == "__main__":
    main()
