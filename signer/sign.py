import sys
import json
from SignerPy import sign

def main():
    try:
        data = json.loads(sys.argv[1])
        params = data.get('params', {})
        payload = data.get('payload', None)
        version = data.get('version', 8404)
        signature = sign(params=params, payload=payload, version=version)
        print(json.dumps(signature))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
