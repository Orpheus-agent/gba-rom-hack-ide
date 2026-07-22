"""Phase 8A-3 - Model predownload stub.

Phase 8D-1 will fetch open-clip's ViT-B/32 weights into
`models/` here so the first runtime tool call doesn't pay a
580 MB wall-clock cost. For now this is a no-op.
"""

from __future__ import annotations

import sys


def main() -> int:
    print("predownload-models: nothing to do (Phase 8A-3 stub).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
