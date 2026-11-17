"""Local, deliberately slow OTLP collector for the quick-redirect example."""

import gzip
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

runs = {}
lock = threading.Lock()


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # Set the advertised TCP receive window before accepting connections.
        # A delayed application read alone still permits large localhost buffers.
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Access-Control-Allow-Origin', 'http://127.0.0.1:4194')
        self.send_header('Access-Control-Allow-Headers', 'content-type, content-encoding')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self):
        self.reply(200, {})

    def do_GET(self):
        run = self.path.removeprefix('/receipts/')
        with lock:
            self.reply(200, runs.get(run, {'spans': [], 'uploads': []}))

    def do_POST(self):
        if not self.path.startswith('/collector/'):
            self.reply(404, {})
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 2_000_000:
            self.reply(413, {})
            return
        run = self.path.removeprefix('/collector/')
        upload = {'bytes': 0, 'complete': False, 'aborted': False}
        with lock:
            if run not in runs and len(runs) >= 20:
                del runs[next(iter(runs))]
            receipts = runs.setdefault(run, {'spans': [], 'uploads': []})
            receipts['uploads'].append(upload)
        body = bytearray()
        try:
            time.sleep(0.3)
            while len(body) < length:
                chunk = self.rfile.read(min(4096, length - len(body)))
                if not chunk:
                    with lock:
                        upload['aborted'] = True
                    return
                body.extend(chunk)
                with lock:
                    upload['bytes'] = len(body)
                time.sleep(0.04)
            payload = json.loads(gzip.decompress(body) if self.headers.get('Content-Encoding') == 'gzip' else body)
            spans = [
                {'spanId': span['spanId'], 'name': span['name']}
                for resource in payload['resourceSpans']
                for scope in resource['scopeSpans']
                for span in scope['spans']
            ]
            with lock:
                receipts['spans'].extend(spans)
                upload['complete'] = True
            self.reply(200, {})
        except (ConnectionError, OSError):
            with lock:
                upload['aborted'] = not upload['complete']
        except (ValueError, KeyError, TypeError):
            self.reply(400, {})


if __name__ == '__main__':
    Server(('127.0.0.1', 4195), Handler).serve_forever()
