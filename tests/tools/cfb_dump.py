"""Independent CFB check using olefile: prints {"Storage/Stream": sha256} as JSON.

    python3 -I tests/tools/cfb_dump.py file.cfb
"""
import hashlib, json, sys
import olefile

def main(path):
    ole = olefile.OleFileIO(path)
    out = {}
    for entry in ole.listdir(streams=True, storages=False):
        data = ole.openstream(entry).read()
        out["/".join(entry)] = hashlib.sha256(data).hexdigest()
    print(json.dumps(out, sort_keys=True))

if __name__ == "__main__":
    main(sys.argv[1])
