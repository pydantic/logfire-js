"""Local, deliberately slow OTLP collector for the quick-redirect example."""

import gzip
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

runs = {}
lock = threading.Lock()
releases = {}


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
        if self.path.startswith('/scenario/'):
            run, scenario = self.path.removeprefix('/scenario/').split('/')
            if scenario not in ('interrupted', 'lost-ack'):
                self.reply(400, {})
                return
            with lock:
                runs[run] = {'spans': [], 'uploads': [], 'scenario': scenario}
                releases[run] = threading.Event()
            self.reply(200, {})
            return
        if self.path.startswith('/release/'):
            with lock:
                event = releases.pop(self.path.removeprefix('/release/'), None)
            if event is not None:
                event.set()
            self.reply(200, {})
            return
        if not self.path.startswith('/collector/'):
            self.reply(404, {})
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 2_000_000:
            self.reply(413, {})
            return
        run = self.path.removeprefix('/collector/')
        upload = {'bytes': 0, 'size': length, 'complete': False, 'aborted': False, 'spanIds': []}
        with lock:
            if run not in runs and len(runs) >= 20:
                del runs[next(iter(runs))]
            receipts = runs.setdefault(run, {'spans': [], 'uploads': []})
            first_large = length > 64 * 1024 and not any(item['size'] > 64 * 1024 for item in receipts['uploads'])
            scenario = receipts.get('scenario') if first_large else None
            release = releases.get(run)
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
                if scenario == 'interrupted':
                    # Hold the failed connection until navigation, so transport retries cannot race it.
                    with lock:
                        upload['aborted'] = True
                    release.wait(timeout=30)
                    self.close_connection = True
                    return
                if scenario != 'lost-ack':
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
                upload['spanIds'] = [span['spanId'] for span in spans]
            if scenario == 'lost-ack':
                # Accept the payload, but withhold its acknowledgment until the old document is gone.
                release.wait(timeout=30)
                self.close_connection = True
                return
            self.reply(200, {})
        except (ConnectionError, OSError):
            with lock:
                upload['aborted'] = not upload['complete']
        except (ValueError, KeyError, TypeError):
            self.reply(400, {})


if __name__ == '__main__':
    Server(('127.0.0.1', 4195), Handler).serve_forever()
