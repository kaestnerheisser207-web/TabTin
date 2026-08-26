"""BytePlus Global Seed Speech ASR Provider。"""

from .standard import BytePlusStandardASR
from .streaming import BytePlusStreamingASR

__all__ = ["BytePlusStandardASR", "BytePlusStreamingASR"]
