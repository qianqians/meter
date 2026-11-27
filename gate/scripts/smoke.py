#!/usr/bin/env python3
"""gate 双端口的端到端冒烟脚本（零依赖，只用标准库）。

做的事：
  1. 以**逻辑节点**身份连 TCP（对内端口），发 `logic.hello`，声明 node_id
  2. 以**客户端**身份连 WebSocket（对外端口），发一条 REQUEST（body = CallEntity）
  3. 断言 gate 把它包成 `ClientRequestHub{conn_id, entity_id, content}` 转给了逻辑节点
  4. 逻辑节点回一条 `GateForwardHubCallClient`，断言客户端收到 `CallEntity`

用法（端口来自配置文件；脚本自己从 NotifyConnID 里取 conn_id，可以重复跑）：
    cd gate && go run ./cmd/gate -config /tmp/smoke.json &   # {"listen":{"logic_port":19002,"client_port":19001}}
    python3 scripts/smoke.py 127.0.0.1 19001 19002
"""
import base64
import os
import socket
import struct
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
WS_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 19001
TCP_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 19002
WS_PATH = "/ws"


# ---------------- protobuf 最小编码（只为造/解我们自己的消息） ----------------
def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def tag(field, wire):
    return varint((field << 3) | wire)


def pb_str(field, s):
    if isinstance(s, str):
        s = s.encode()
    return tag(field, 2) + varint(len(s)) + s


def pb_u32(field, v):
    return tag(field, 0) + varint(v)


def pb_msg(field, payload):
    return tag(field, 2) + varint(len(payload)) + payload


def read_varint(buf, i):
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7


def pb_fields(buf):
    """解成 {field_no: [value...]}，只处理 varint 与 length-delimited。"""
    out = {}
    i = 0
    while i < len(buf):
        key, i = read_varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            v, i = read_varint(buf, i)
        elif wire == 2:
            n, i = read_varint(buf, i)
            v = buf[i:i + n]
            i += n
        else:
            raise ValueError(f"unsupported wire type {wire}")
        out.setdefault(field, []).append(v)
    return out


# ---------------- 帧头（8 字节，与 Go/TS 完全一致） ----------------
def encode_frame(payload, ts=1):
    assert len(payload) < (1 << 24)
    return b"\x00" + struct.pack("<I", len(payload))[:3] + struct.pack("<I", ts) + payload


def decode_frame(buf):
    """返回 (payload, 剩余字节)；不足一帧时 payload 为 None。"""
    if len(buf) < 8:
        return None, buf
    flags = buf[0]
    n = buf[1] | (buf[2] << 8) | (buf[3] << 16)
    if len(buf) < 8 + n:
        return None, buf
    return buf[8:8 + n], buf[8 + n:]


def uplink_call(entity_id, content=b""):
    """ClientUplink{ oneof body { CallEntity call = 6; } }"""
    return pb_msg(6, pb_str(1, entity_id) + pb_msg(2, content))


def envelope(msg_type, method, callback_id=0, body=b""):
    e = pb_u32(1, msg_type) if msg_type else b""
    e += pb_str(2, method) if method else b""
    e += pb_u32(3, callback_id) if callback_id else b""
    e += pb_msg(4, body) if body else b""
    return e


# ---------------- 逻辑节点（裸 TCP） ----------------
class LogicLink:
    def __init__(self, node_id):
        self.sock = socket.create_connection((HOST, TCP_PORT), timeout=5)
        self.sock.sendall(encode_frame(envelope(3, "logic.hello", 0, node_id.encode())))
        self.buf = b""

    def send(self, env):
        self.sock.sendall(encode_frame(env))

    def recv(self, timeout=3.0):
        self.sock.settimeout(timeout)
        deadline = time.time() + timeout
        while time.time() < deadline:
            payload, rest = decode_frame(self.buf)
            if payload is not None:
                self.buf = rest
                return payload
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            self.buf += chunk
        return None


# ---------------- WebSocket 客户端（手写握手 + 掩码帧） ----------------
class WSClient:
    def __init__(self):
        self.sock = socket.create_connection((HOST, WS_PORT), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {WS_PATH} HTTP/1.1\r\nHost: {HOST}:{WS_PORT}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WS 握手失败：连接被关闭")
            resp += chunk
        if b"101" not in resp.split(b"\r\n")[0]:
            raise RuntimeError(f"WS 握手失败: {resp[:120]!r}")
        self.buf = resp.split(b"\r\n\r\n", 1)[1]

    def send(self, payload):
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x82])  # FIN + binary
        if n < 126:
            header += bytes([0x80 | n])
        elif n < (1 << 16):
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def recv(self, timeout=3.0):
        self.sock.settimeout(timeout)
        while True:
            payload, rest = self._parse()
            if payload is not None:
                self.buf = rest
                return payload
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                return None
            if not chunk:
                return None
            self.buf += chunk

    def _parse(self):
        b = self.buf
        if len(b) < 2:
            return None, b
        opcode = b[0] & 0x0F
        masked = b[1] & 0x80
        n = b[1] & 0x7F
        i = 2
        if n == 126:
            if len(b) < i + 2:
                return None, b
            n = struct.unpack(">H", b[i:i + 2])[0]
            i += 2
        elif n == 127:
            if len(b) < i + 8:
                return None, b
            n = struct.unpack(">Q", b[i:i + 8])[0]
            i += 8
        if masked:
            i += 4
        if len(b) < i + n:
            return None, b
        payload = b[i:i + n]
        rest = b[i + n:]
        if opcode == 0x8:  # close
            raise RuntimeError("对端关闭连接")
        return payload, rest


def main():
    ok = True
    conn_id = "c-1"   # 下面从 NotifyConnID 里覆盖成真实值
    logic = LogicLink("n-smoke")
    ws = WSClient()
    print("① 两个端口都连上了（TCP 逻辑链路 + WebSocket 客户端）")

    # --- 连上第一条必须是 NotifyConnID（ClientDownlink.conn_id = 1） ---
    got = ws.recv(2)
    if got is None:
        print("①b 没收到 NotifyConnID —— 失败")
        ok = False
    else:
        f = pb_fields(decode_frame(got)[0])
        hello = pb_fields(pb_fields(f[4][0])[1][0])
        conn_id = hello[1][0].decode()
        print("①b 收到 NotifyConnID:", {"conn_id": conn_id,
                                       "proto_ver": hello.get(3, [0])[0],
                                       "heartbeat_ms": hello.get(5, [0])[0]})
        if not conn_id:
            print("   conn_id 为空 —— 失败")
            ok = False

    # --- 未登录连接的上行应被丢弃（会话由逻辑层的 HubCreatePlayerEntity 建立） ---
    ws.send(encode_frame(envelope(1, "entity.attack", 7, uplink_call("e-nobody", b""))))
    if logic.recv(1.2) is None:
        print("② 未登录上行被丢弃（符合设计）")
    else:
        print("② 未登录上行竟然被转发了 —— 失败")
        ok = False

    # --- 逻辑层建会话：gate 建立 conn ⇄ entity，并给客户端推 ClientDownlink.create_player ---
    logic.send(envelope(3, "hub.createPlayerEntity", 0,
                        pb_str(1, conn_id) + pb_str(2, "u-smoke") + pb_str(3, "e-smoke") + pb_str(4, "player")))
    got = ws.recv(2)
    if got is None:
        print("③ 客户端没收到建实体推送 —— 失败")
        ok = False
    else:
        f = pb_fields(decode_frame(got)[0])
        create = pb_fields(pb_fields(f[4][0])[5][0])   # ClientDownlink.create_player = 5
        print("③ 客户端收到 ClientDownlink.create_player:", {"entity": create[1][0].decode()})

    # --- 建会话后的上行：gate 应包成 ClientRequestHub{..., method} 转给逻辑层 ---
    ws.send(encode_frame(envelope(1, "entity.attack", 7, uplink_call("e-smoke", b""))))
    fwd = logic.recv()
    if fwd is None:
        print("④ 建会话后仍未转发 —— 失败")
        ok = False
    else:
        f = pb_fields(fwd)
        up = pb_fields(f[4][0])
        print("④ gate 转发 ClientRequestHub:",
              {"route": f[2][0].decode(), "conn": up[1][0].decode(), "entity": up[2][0].decode(),
               "method": up[4][0].decode(), "content": up[3][0].hex(), "callback": f[3][0]})

    # --- 逻辑层调客户端：gate 译成 ClientDownlink.call，method 用业务方法名 ---
    logic.send(envelope(1, "gate.forwardHubCallClient", 11,
                        pb_str(1, conn_id) + pb_str(2, "e-smoke") + pb_msg(3, b"		") + pb_str(4, "entity.attack")))
    got = ws.recv(2)
    if got is None:
        print("⑤ 客户端没收到 CallEntity —— 失败")
        ok = False
    else:
        f = pb_fields(decode_frame(got)[0])
        ce = pb_fields(pb_fields(f[4][0])[12][0])        # ClientDownlink.call = 12
        print("⑤ 客户端收到 ClientDownlink.call:", {"msg_type": f.get(1, [0])[0], "method": f[2][0].decode(),
                                                   "entity": ce[1][0].decode(), "content": ce[2][0].hex(),
                                                   "callback": f.get(3, [0])[0]})

    # --- 踢人：HubKickOffClient → ClientDownlink.kick_off ---
    logic.send(envelope(3, "hub.kickOffClient", 0,
                        pb_str(1, conn_id) + pb_msg(2, pb_u32(1, 4)) + pb_str(3, "冒烟踢人")))
    got = ws.recv(2)
    kicked = False
    if got is not None:
        down = pb_fields(pb_fields(decode_frame(got)[0])[4][0])
        kicked = 9 in down                                # ClientDownlink.kick_off = 9
    print("⑥ 踢人:", "收到 ClientDownlink.kick_off" if kicked else "未收到（可能已断开）")
    if not kicked:
        ok = False

    print()
    print("冒烟" + ("通过 ✅" if ok else "失败 ❌"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
