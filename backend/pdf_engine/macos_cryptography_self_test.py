from __future__ import annotations

import json
import sys


if sys.argv[1:] == ["--self-test"]:
    try:
        import cryptography
        from cryptography.hazmat.primitives import hashes

        digest = hashes.Hash(hashes.SHA256())
        digest.update(b"Folio macOS PDF engine")
        digest.finalize()
    except Exception as error:
        print(json.dumps({
            "type": "cryptography_native_self_test",
            "status": "error",
            "message": str(error)[:1000],
        }, ensure_ascii=False), flush=True)
        raise
    print(json.dumps({
        "type": "cryptography_native_self_test",
        "status": "ok",
        "version": cryptography.__version__,
    }), flush=True)
