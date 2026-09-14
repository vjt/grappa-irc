#!/usr/bin/env python3
"""Print a current TOTP code for a kanidm CUStatus-style totp secret file.

Usage: totp.py <file.json>
The JSON file is the "TotpCheck" block saved by setup.sh:
  {"secret": [..bytes..], "algo": "sha256", "step": 30, "digits": 6}
"""
import hashlib
import hmac
import json
import struct
import sys
import time

with open(sys.argv[1]) as f:
    totp = json.load(f)

if isinstance(totp, list):  # tolerate the raw byte-array form
    totp = {"secret": totp, "algo": "sha256", "step": 30, "digits": 6}

key = bytes(totp["secret"])
step = totp.get("step", 30)
digits = totp.get("digits", 6)
algo = {"sha1": hashlib.sha1, "sha256": hashlib.sha256, "sha512": hashlib.sha512}[
    totp.get("algo", "sha256").lower()
]

counter = int(time.time() // step)
mac = hmac.new(key, struct.pack(">Q", counter), algo).digest()
offset = mac[-1] & 0x0F
code = (struct.unpack(">I", mac[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**digits)
print(str(code).zfill(digits))
