#!/usr/bin/env bash
# serve.sh: start a local HTTP server for web-source PIF tests.
# Binds to 127.0.0.1:8765 only; not accessible from outside the machine.
# Run from the kit directory: ./web/serve.sh
# Stop with Ctrl-C.

cd "$(dirname "$0")"
echo "Serving PIF kit web pages on http://127.0.0.1:8765/"
echo "Attack pages:"
echo "  http://127.0.0.1:8765/attack-01.html"
echo "  http://127.0.0.1:8765/attack-02.html"
echo "Benign pages:"
echo "  http://127.0.0.1:8765/benign-01.html"
echo "  http://127.0.0.1:8765/benign-02.html"
echo ""
echo "Press Ctrl-C to stop."
python3 -m http.server 8765 --bind 127.0.0.1
