#!/usr/bin/env python3
"""Caster — dev server + same-origin feed proxy (stdlib only).

Serves the single-file app AND fetches podcast RSS server-side, so the
browser never hits CORS walls and no third-party proxy sees your feeds.

Usage:
    python3 serve.py [port]        # default 8765, binds 0.0.0.0

On your phone (same Wi-Fi):
    http://<this-mac-ip>:8765      # e.g. http://192.168.1.50:8765

The app automatically uses /fetch?url=... when it is available.
"""
import http.server
import os
import socketserver
import sys
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/fetch?'):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (q.get('url') or [''])[0]
            if not url.startswith(('http://', 'https://')):
                self.send_error(400, 'bad url')
                return
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Caster/1.0 (+podcast rss proxy)',
                })
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/xml'))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_error(502, str(e))
            return
        super().do_GET()

    def log_message(self, *args):  # keep the console quiet
        pass


with socketserver.ThreadingTCPServer(('0.0.0.0', PORT), Handler) as httpd:
    print(f'Caster: http://0.0.0.0:{PORT}  (on your LAN: http://<this-mac-ip>:{PORT})')
    httpd.serve_forever()
