"""
Server simplu pentru VetStuff website.
Rulează: python3 serve.py
Deschide: http://localhost:3000
"""
import http.server
import socketserver
import os

PORT = 3000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        print(f"  {self.address_string()} → {format % args}")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"\n🐾 VetStuff server pornit!")
    print(f"   Deschide: http://localhost:{PORT}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n   Server oprit.")
