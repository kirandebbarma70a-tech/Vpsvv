#!/usr/bin/env python3
"""
render-vps tunnel client (Python version)

Install:  pip install websocket-client
Run:      python client/tunnel.py "wss://ssh-vps.onrender.com/ws?token=XXXX" 2222
Then:     ssh -p 2222 root@127.0.0.1
"""

import socket
import sys
import threading

try:
    import websocket  # pip install websocket-client
except ImportError:
    print("websocket-client missing hai -> pip install websocket-client")
    sys.exit(1)


def usage():
    print(__doc__)


def handle(client: socket.socket, url: str, session_id: int):
    stop = threading.Event()

    try:
        ws = websocket.create_connection(url, timeout=15, enable_multithread=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[!] WebSocket connect fail: {exc}")
        client.close()
        return

    ws.settimeout(1.0)
    print(f"[+] session #{session_id} open")

    def client_to_ws():
        try:
            while not stop.is_set():
                data = client.recv(65536)
                if not data:
                    break
                ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
        except Exception:  # noqa: BLE001
            pass
        finally:
            stop.set()
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

    def ws_to_client():
        try:
            while not stop.is_set():
                try:
                    data = ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                except Exception:  # noqa: BLE001
                    break
                if not data:
                    break
                if isinstance(data, str):
                    data = data.encode()
                client.sendall(data)
        finally:
            stop.set()
            try:
                client.shutdown(socket.SHUT_RDWR)
            except Exception:  # noqa: BLE001
                pass
            client.close()

    t1 = threading.Thread(target=client_to_ws, daemon=True)
    t2 = threading.Thread(target=ws_to_client, daemon=True)
    t1.start()
    t2.start()
    t2.join()
    print(f"[-] session #{session_id} closed")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not args:
        usage()
        sys.exit(1)

    url = args[0]
    port = int(args[1]) if len(args) > 1 else 2222

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(16)

    print(
        f"""
  render-vps tunnel ready  (python)
  --------------------------------
  remote : {url.split('token=')[0]}...
  local  : 127.0.0.1:{port}

      ssh -p {port} root@127.0.0.1
"""
    )

    counter = 0
    try:
        while True:
            client, _ = server.accept()
            counter += 1
            threading.Thread(target=handle, args=(client, url, counter), daemon=True).start()
    except KeyboardInterrupt:
        print("\n[!] tunnel band")


if __name__ == "__main__":
    main()
