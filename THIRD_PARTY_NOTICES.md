# Third-party notices

## Piper TTS runtime

The optional local TTS feature installs `piper-tts` version 1.8.0 from PyPI at runtime and invokes it as a separate local process. Piper is maintained by the Open Home Foundation.

- Project: https://github.com/OHF-Voice/piper1-gpl
- License: GPL-3.0
- The Python package and its dependencies are installed into the current Windows user's application data directory; they are not bundled into this installer.

## en_US-libritts-high voice model

The optional local TTS feature downloads the unmodified `en_US-libritts-high` ONNX voice model and its configuration from the Piper voices repository at runtime.

- Voice: `en_US-libritts-high`, English (United States), high quality, 22,050 Hz, speaker ID 0
- Source: https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/en/en_US/libritts/high
- Model card: https://huggingface.co/rhasspy/piper-voices/blob/v1.0.0/en/en_US/libritts/high/MODEL_CARD
- Training dataset: LibriTTS, OpenSLR 60 (https://www.openslr.org/60/)
- Dataset license stated by the model card: Creative Commons Attribution 4.0 International (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/
- Attribution: LibriTTS, a corpus derived from LibriSpeech for text-to-speech, by Heiga Zen et al., Interspeech 2019. The model card states that this voice was trained from scratch on the LibriTTS `train-clean-360` subset.
- Changes: this application downloads the upstream model and configuration without modifying them.

**Checkpoint licensing clarification:** the Hugging Face repository currently displays repository-level MIT metadata, while this voice's model card lists CC BY 4.0 for the underlying LibriTTS dataset. Upstream issue [OHF-Voice/piper1-gpl#340](https://github.com/OHF-Voice/piper1-gpl/issues/340) asks which license applies to the exact `en_US-libritts-high.onnx` checkpoint; it remained open with no comments when this notice was prepared on 2026-10-30. This notice does not assert a definitive license for the ONNX weights. The application downloads the unchanged weights at runtime and does not include or redistribute them in the installer. It provides conservative dataset attribution; review upstream terms before redistributing the weights or deploying them commercially.

The voice model is downloaded only after the user enables local Piper TTS. It is not included in the installer.
