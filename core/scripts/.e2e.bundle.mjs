// scripts/e2e.ts
import net2 from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { create as create5, fromBinary as fromBinary4, toBinary as toBinary5 } from "@bufbuild/protobuf";

// src/gen/envelope_pb.ts
import { enumDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
var file_envelope = /* @__PURE__ */ fileDesc("Cg5lbnZlbG9wZS5wcm90bxICZncicgoIRW52ZWxvcGUSHQoIbXNnX3R5cGUYASABKA4yCy5mdy5Nc2dUeXBlEg4KBm1ldGhvZBgCIAEoCRITCgtjYWxsYmFja19pZBgDIAEoDRIOCgZzdGF0dXMYBSABKA0SDAoEYm9keRgEIAEoDEoECAYQECpKCgdNc2dUeXBlEgwKCE1TR19OT05FEAASDwoLTVNHX1JFUVVFU1QQARIQCgxNU0dfUkVTUE9OU0UQAhIOCgpNU0dfTk9USUZZEANCFFoSbWV0ZXIvc2NoZW1hL3BiO3BiYgZwcm90bzM");
var EnvelopeSchema = /* @__PURE__ */ messageDesc(file_envelope, 0);

// src/gen/gate_pb.ts
import { fileDesc as fileDesc3, messageDesc as messageDesc3 } from "@bufbuild/protobuf/codegenv2";

// src/gen/common_pb.ts
import { fileDesc as fileDesc2, messageDesc as messageDesc2 } from "@bufbuild/protobuf/codegenv2";
var file_common = /* @__PURE__ */ fileDesc2("Cgxjb21tb24ucHJvdG8SAmZ3IhoKCVNlc3Npb25JZBINCgV2YWx1ZRgBIAEoBCIXCgZOb2RlSWQSDQoFdmFsdWUYASABKAkiFwoJRW50aXR5UmVmEgoKAmlkGAEgASgJIgcKBUVtcHR5IhYKBUJ5dGVzEg0KBXZhbHVlGAEgASgMIjgKCUVycm9yQ29kZRIMCgRjb2RlGAEgASgFEg4KBmRldGFpbBgCIAEoCRINCgVleHRyYRgDIAEoDCIwCgpDYWxsRW50aXR5EhEKCWVudGl0eV9pZBgBIAEoCRIPCgdjb250ZW50GAIgASgMQhRaEm1ldGVyL3NjaGVtYS9wYjtwYmIGcHJvdG8z");
var ErrorCodeSchema = /* @__PURE__ */ messageDesc2(file_common, 5);
var CallEntitySchema = /* @__PURE__ */ messageDesc2(file_common, 6);

// src/gen/gate_pb.ts
var file_gate = /* @__PURE__ */ fileDesc3("CgpnYXRlLnByb3RvEgJmdyJPCgVMb2dpbhINCgV0b2tlbhgBIAEoCRIRCglzZXJ2ZXJfaWQYAiABKAkSEgoKY2xpZW50X3ZlchgDIAEoCRIQCghwbGF0Zm9ybRgEIAEoCSJJCglSZWNvbm5lY3QSDwoHY29ubl9pZBgBIAEoCRIUCgxyZXN1bWVfdG9rZW4YAiABKAwSFQoNbGFzdF9yZWN2X3NlcRgDIAEoBCIYCgZMb2dvdXQSDgoGcmVhc29uGAEgASgJIiMKCUhlYXJ0QmVhdBIWCg5jbGllbnRfdGltZV9tcxgBIAEoBCItCgtBY2tSZWxpYWJsZRIRCgllbnRpdHlfaWQYASABKAkSCwoDc2VxGAIgASgEItgBCgxDbGllbnRVcGxpbmsSGgoFbG9naW4YASABKAsyCS5mdy5Mb2dpbkgAEiIKCXJlY29ubmVjdBgCIAEoCzINLmZ3LlJlY29ubmVjdEgAEhwKBmxvZ291dBgDIAEoCzIKLmZ3LkxvZ291dEgAEiIKCWhlYXJ0YmVhdBgEIAEoCzINLmZ3LkhlYXJ0QmVhdEgAEh4KA2FjaxgFIAEoCzIPLmZ3LkFja1JlbGlhYmxlSAASHgoEY2FsbBgGIAEoCzIOLmZ3LkNhbGxFbnRpdHlIAEIGCgRib2R5QhRaEm1ldGVyL3NjaGVtYS9wYjtwYmIGcHJvdG8z", [file_common]);
var LoginSchema = /* @__PURE__ */ messageDesc3(file_gate, 0);
var ClientUplinkSchema = /* @__PURE__ */ messageDesc3(file_gate, 5);

// src/gen/client_pb.ts
import { fileDesc as fileDesc4, messageDesc as messageDesc4 } from "@bufbuild/protobuf/codegenv2";
var file_client = /* @__PURE__ */ fileDesc4("CgxjbGllbnQucHJvdG8SAmZ3In8KDE5vdGlmeUNvbm5JRBIPCgdjb25uX2lkGAEgASgJEhEKCXByb3RvX3ZlchgDIAEoDRIWCg5zZXJ2ZXJfdGltZV9tcxgEIAEoBBIUCgxoZWFydGJlYXRfbXMYBSABKA0SFwoPbWF4X2ZyYW1lX2J5dGVzGAYgASgNSgQIAhADIlwKC0xvZ2luUmVzdWx0Eg8KB3VzZXJfaWQYASABKAkSEQoJZW50aXR5X2lkGAIgASgJEhQKDHJlc3VtZV90b2tlbhgDIAEoDBITCgtmdWxsX3Jlc3luYxgEIAEoCCJNChJDcmVhdGVQbGF5ZXJFbnRpdHkSEQoJZW50aXR5X2lkGAEgASgJEhMKC2VudGl0eV90eXBlGAIgASgJEg8KB2NvbnRlbnQYAyABKAwiTQoSQ3JlYXRlUmVtb3RlRW50aXR5EhEKCWVudGl0eV9pZBgBIAEoCRITCgtlbnRpdHlfdHlwZRgCIAEoCRIPCgdjb250ZW50GAMgASgMIlgKDVJlZnJlc2hFbnRpdHkSEQoJZW50aXR5X2lkGAEgASgJEhMKC2VudGl0eV90eXBlGAIgASgJEg8KB2NvbnRlbnQYAyABKAwSDgoGcmVhc29uGAQgASgNIjEKDERlbGV0ZUVudGl0eRIRCgllbnRpdHlfaWQYASABKAkSDgoGcmVhc29uGAIgASgNIjwKB0tpY2tPZmYSHAoFZXJyb3IYASABKAsyDS5mdy5FcnJvckNvZGUSEwoLcHJvbXB0X2luZm8YAiABKAkiQQoPSGVhcnRCZWF0UmVzdWx0EhYKDmNsaWVudF90aW1lX21zGAEgASgEEhYKDnNlcnZlcl90aW1lX21zGAIgASgEIjcKD1JlY29ubmVjdFJlc3VsdBIPCgdjb25uX2lkGAEgASgJEhMKC2Z1bGxfcmVzeW5jGAIgASgIIjUKCkNhbGxHbG9iYWwSDwoHY29udGVudBgBIAEoDBIWCg5leGNsdWRlX3NvdXJjZRgCIAEoCCJDCgtOb3RpZnlFcnJvchIcCgVlcnJvchgBIAEoCzINLmZ3LkVycm9yQ29kZRIWCg5yZWxhdGVkX21ldGhvZBgCIAEoCSJCCgxTZXJ2ZXJOb3RpY2USDAoEY29kZRgBIAEoDRIMCgR0ZXh0GAIgASgJEhYKDnJldHJ5X2FmdGVyX21zGAMgASgNIogECg5DbGllbnREb3dubGluaxIjCgdjb25uX2lkGAEgASgLMhAuZncuTm90aWZ5Q29ubklESAASIAoFbG9naW4YAiABKAsyDy5mdy5Mb2dpblJlc3VsdEgAEigKCXJlY29ubmVjdBgDIAEoCzITLmZ3LlJlY29ubmVjdFJlc3VsdEgAEigKCWhlYXJ0YmVhdBgEIAEoCzITLmZ3LkhlYXJ0QmVhdFJlc3VsdEgAEi8KDWNyZWF0ZV9wbGF5ZXIYBSABKAsyFi5mdy5DcmVhdGVQbGF5ZXJFbnRpdHlIABIvCg1jcmVhdGVfcmVtb3RlGAYgASgLMhYuZncuQ3JlYXRlUmVtb3RlRW50aXR5SAASJAoHcmVmcmVzaBgHIAEoCzIRLmZ3LlJlZnJlc2hFbnRpdHlIABIiCgZkZWxldGUYCCABKAsyEC5mdy5EZWxldGVFbnRpdHlIABIfCghraWNrX29mZhgJIAEoCzILLmZ3LktpY2tPZmZIABIgCgVlcnJvchgKIAEoCzIPLmZ3Lk5vdGlmeUVycm9ySAASIgoGbm90aWNlGAsgASgLMhAuZncuU2VydmVyTm90aWNlSAASHgoEY2FsbBgMIAEoCzIOLmZ3LkNhbGxFbnRpdHlIABIgCgZnbG9iYWwYDSABKAsyDi5mdy5DYWxsR2xvYmFsSABCBgoEYm9keUIUWhJtZXRlci9zY2hlbWEvcGI7cGJiBnByb3RvMw", [file_common]);
var RefreshEntitySchema = /* @__PURE__ */ messageDesc4(file_client, 4);
var ClientDownlinkSchema = /* @__PURE__ */ messageDesc4(file_client, 12);

// src/frame.ts
var HEADER_SIZE = 8;
var MAX_PAYLOAD = 1 << 20;
var FLAG_ZSTD = 1;
var KNOWN_FLAGS = FLAG_ZSTD;
var FrameError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "FrameError";
  }
};
function encodeFrame(frame) {
  const { flags, ts, payload } = frame;
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new FrameError(`\u672A\u77E5 flags \u4F4D: 0b${flags.toString(2)}`, "BAD_FLAGS");
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError(`payload \u8D85\u8FC7 1 MB: ${payload.length}`, "PAYLOAD_TOO_LARGE");
  }
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out[0] = flags;
  const len = payload.length;
  out[1] = len & 255;
  out[2] = len >>> 8 & 255;
  out[3] = len >>> 16 & 255;
  out[4] = ts & 255;
  out[5] = ts >>> 8 & 255;
  out[6] = ts >>> 16 & 255;
  out[7] = ts >>> 24 & 255;
  out.set(payload, HEADER_SIZE);
  return out;
}
function decodeFrames(buf, onFrame) {
  let off = 0;
  while (buf.length - off >= HEADER_SIZE) {
    const flags = buf[off];
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new FrameError(`\u672A\u77E5 flags \u4F4D: 0b${flags.toString(2)}`, "BAD_FLAGS");
    }
    const len = buf[off + 1] | buf[off + 2] << 8 | buf[off + 3] << 16;
    if (len > MAX_PAYLOAD) {
      throw new FrameError(`len \u8D85\u8FC7 1 MB: ${len}`, "PAYLOAD_TOO_LARGE");
    }
    if (buf.length - off < HEADER_SIZE + len) break;
    const ts = (buf[off + 4] | buf[off + 5] << 8 | buf[off + 6] << 16 | buf[off + 7] << 24) >>> 0;
    onFrame({ flags, ts, payload: buf.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len) });
    off += HEADER_SIZE + len;
  }
  return off;
}

// src/gatelink.ts
import net from "node:net";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
function createLinkTransport(socket, opts) {
  let sink;
  let pending = new Uint8Array(0);
  const link = {
    send(bytes) {
      socket.write(encodeFrame({ flags: 0, ts: opts.now() & 4294967295, payload: bytes }));
    },
    onData(cb) {
      sink = cb;
    },
    feed(chunk) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      const consumed = decodeFrames(merged, (f) => sink?.(f.payload));
      pending = merged.slice(consumed);
    }
  };
  return link;
}
function connectGate(opts) {
  return new Promise((resolve, reject) => {
    const now = opts.now ?? (() => Date.now());
    let settled = false;
    let closed = false;
    const socket = net.createConnection({ host: opts.host, port: opts.port }, () => {
      const hello = toBinary(EnvelopeSchema, create(EnvelopeSchema, {
        msgType: 3 /* MSG_NOTIFY */,
        method: "logic.hello",
        body: new TextEncoder().encode(opts.nodeId)
      }));
      socket.write(encodeFrame({ flags: 0, ts: now() & 4294967295, payload: hello }));
      settled = true;
      resolve(transport);
    });
    const transport = createLinkTransport(socket, { now });
    socket.on("data", (chunk) => {
      transport.feed(chunk);
    });
    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`\u8FDE gate ${opts.host}:${opts.port} \u5728\u63E1\u624B\u524D\u88AB\u5173\u95ED`));
      }
      if (!closed) {
        closed = true;
        opts.onClose?.(void 0);
      }
    });
  });
}

// src/server.ts
import { create as create4, fromBinary as fromBinary3, toBinary as toBinary4 } from "@bufbuild/protobuf";

// src/gen/logic_gate_pb.ts
import { fileDesc as fileDesc5, messageDesc as messageDesc5 } from "@bufbuild/protobuf/codegenv2";
var file_logic_gate = /* @__PURE__ */ fileDesc5("ChBsb2dpY19nYXRlLnByb3RvEgJmdyJXChBDbGllbnRSZXF1ZXN0SHViEg8KB2Nvbm5faWQYASABKAkSEQoJZW50aXR5X2lkGAIgASgJEg8KB2NvbnRlbnQYAyABKAwSDgoGbWV0aG9kGAQgASgJImUKEUNsaWVudFJlc3BvbnNlSHViEhEKCWVudGl0eV9pZBgBIAEoCRIcCgVlcnJvchgCIAEoCzINLmZ3LkVycm9yQ29kZRIPCgdjb250ZW50GAMgASgMEg4KBm1ldGhvZBgEIAEoCSJWCg9DbGllbnROb3RpZnlIdWISDwoHY29ubl9pZBgBIAEoCRIRCgllbnRpdHlfaWQYAiABKAkSDwoHY29udGVudBgDIAEoDBIOCgZtZXRob2QYBCABKAkiZQoQQ2xpZW50RGlzY29ubmVjdBIPCgdjb25uX2lkGAEgASgJEg8KB3VzZXJfaWQYAiABKAkSEQoJZW50aXR5X2lkGAMgASgJEhwKBWVycm9yGAQgASgLMg0uZncuRXJyb3JDb2RlImkKIUdhdGVGb3J3YXJkQ2xpZW50UmVxdWVzdFJlY29ubmVjdBIRCglnYXRlX25hbWUYASABKAkSDwoHY29ubl9pZBgCIAEoCRIPCgd1c2VyX2lkGAMgASgJEg8KB2NvbnRlbnQYBCABKAwibAofR2F0ZUZvcndhcmRDbGllbnRSZXF1ZXN0U2VydmljZRIUCgxzZXJ2aWNlX25hbWUYASABKAkSEQoJZ2F0ZV9uYW1lGAIgASgJEg8KB2Nvbm5faWQYAyABKAkSDwoHY29udGVudBgEIAEoDEIUWhJtZXRlci9zY2hlbWEvcGI7cGJiBnByb3RvMw", [file_common]);
var ClientRequestHubSchema = /* @__PURE__ */ messageDesc5(file_logic_gate, 0);
var ClientResponseHubSchema = /* @__PURE__ */ messageDesc5(file_logic_gate, 1);
var ClientNotifyHubSchema = /* @__PURE__ */ messageDesc5(file_logic_gate, 2);
var ClientDisconnectSchema = /* @__PURE__ */ messageDesc5(file_logic_gate, 3);
var GateForwardClientRequestServiceSchema = /* @__PURE__ */ messageDesc5(file_logic_gate, 5);

// src/gen/gate_logic_pb.ts
import { fileDesc as fileDesc6, messageDesc as messageDesc6 } from "@bufbuild/protobuf/codegenv2";
var file_gate_logic = /* @__PURE__ */ fileDesc6("ChBnYXRlX2xvZ2ljLnByb3RvEgJmdyJyChVIdWJDcmVhdGVQbGF5ZXJFbnRpdHkSDwoHY29ubl9pZBgBIAEoCRIPCgd1c2VyX2lkGAIgASgJEhEKCWVudGl0eV9pZBgDIAEoCRITCgtlbnRpdHlfdHlwZRgEIAEoCRIPCgdjb250ZW50GAUgASgMImEKFUh1YkNyZWF0ZVJlbW90ZUVudGl0eRIPCgdjb25uX2lkGAEgASgJEhEKCWVudGl0eV9pZBgCIAEoCRITCgtlbnRpdHlfdHlwZRgDIAEoCRIPCgdjb250ZW50GAQgASgMIjsKFUh1YkRlbGV0ZVJlbW90ZUVudGl0eRIPCgdjb25uX2lkGAEgASgJEhEKCWVudGl0eV9pZBgCIAEoCSJcChBIdWJSZWZyZXNoRW50aXR5Eg8KB2Nvbm5faWQYASABKAkSEQoJZW50aXR5X2lkGAIgASgJEhMKC2VudGl0eV90eXBlGAMgASgJEg8KB2NvbnRlbnQYBCABKAwiVgoQSHViS2lja09mZkNsaWVudBIPCgdjb25uX2lkGAEgASgJEhwKBWVycm9yGAIgASgLMg0uZncuRXJyb3JDb2RlEhMKC3Byb21wdF9pbmZvGAMgASgJIl8KGEdhdGVGb3J3YXJkSHViQ2FsbENsaWVudBIPCgdjb25uX2lkGAEgASgJEhEKCWVudGl0eV9pZBgCIAEoCRIPCgdjb250ZW50GAMgASgMEg4KBm1ldGhvZBgEIAEoCSJeChdHYXRlRm9yd2FyZEh1YkNhbGxHcm91cBIPCgdjb25uX2lkGAEgAygJEhEKCWVudGl0eV9pZBgCIAEoCRIPCgdjb250ZW50GAMgASgMEg4KBm1ldGhvZBgEIAEoCSJOChhHYXRlRm9yd2FyZEh1YkNhbGxHbG9iYWwSEQoJZW50aXR5X2lkGAEgASgJEg8KB2NvbnRlbnQYAiABKAwSDgoGbWV0aG9kGAMgASgJIj4KCUdhdGVEcmFpbhIPCgdnYXRlX2lkGAEgASgJEhAKCGdyYWNlX21zGAIgASgNEg4KBnJlYXNvbhgDIAEoCUIUWhJtZXRlci9zY2hlbWEvcGI7cGJiBnByb3RvMw", [file_common]);
var HubCreatePlayerEntitySchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 0);
var HubCreateRemoteEntitySchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 1);
var HubDeleteRemoteEntitySchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 2);
var HubRefreshEntitySchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 3);
var HubKickOffClientSchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 4);
var GateForwardHubCallClientSchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 5);
var GateForwardHubCallGroupSchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 6);
var GateForwardHubCallGlobalSchema = /* @__PURE__ */ messageDesc6(file_gate_logic, 7);

// src/entity.ts
import {
  create as create2,
  fromBinary as fromBinary2,
  toBinary as toBinary2
} from "@bufbuild/protobuf";
var ERR = {
  OK: 0,
  UNKNOWN: 1,
  TIMEOUT: 2,
  NOT_FOUND: 7,
  BAD_FRAME: 10
};
var RpcError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
};
function envelopeBytes(msgType, method, callbackId, status, body) {
  return toBinary2(EnvelopeSchema, create2(EnvelopeSchema, { msgType, method, callbackId, status, body }));
}
function forwardCallClient(msgType, connId, entityId, method, callbackId, content) {
  return envelopeBytes(
    msgType,
    "gate.forwardHubCallClient",
    callbackId,
    0,
    toBinary2(GateForwardHubCallClientSchema, create2(GateForwardHubCallClientSchema, {
      connId,
      entityId,
      method,
      content
    }))
  );
}
var Entity = class {
  id;
  type;
  /** 玩家的连接；怪/NPC 为 undefined。 */
  connId;
  /** 服务端视角的玩家 id（登录时由业务给出）。 */
  userId;
  /** 实体销毁时 Server 调用；业务可以挂清理逻辑（离开场景、存档等）。 */
  onDestroy;
  down;
  handlers = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  nextCallbackId = 1;
  stats = { unknownMethod: 0, timeout: 0 };
  constructor(id, type, down, opts = {}) {
    this.id = id;
    this.type = type;
    this.down = down;
    this.connId = opts.connId;
    this.userId = opts.userId;
  }
  /** 是否玩家实体（有连接、能主动调客户端）。 */
  get isPlayer() {
    return this.connId !== void 0;
  }
  // ---------------- 客户端 → 实体（register） ----------------
  /**
   * 注册客户端可调用的方法。同一个方法同时服务 REQUEST（要回包）与 NOTIFY。
   * handler 返回值用 rspSchema 编码后经 RESPONSE 发回（只有 REQUEST 会发）。
   */
  register(method, reqSchema, rspSchema, handler) {
    this.handlers.set(method, async (reqBytes, ctx) => {
      const req = fromBinary2(reqSchema, reqBytes);
      const rsp = await handler(req, ctx);
      return toBinary2(rspSchema, rsp);
    });
  }
  /** 只收 NOTIFY（不回包）的轻量注册（心跳类、操作类上报）。 */
  registerNotify(method, reqSchema, handler) {
    this.handlers.set(method, async (reqBytes, ctx) => {
      const req = fromBinary2(reqSchema, reqBytes);
      await handler(req, ctx);
      return new Uint8Array(0);
    });
  }
  /**
   * 收到一条客户端调用（Server 分派进来）。
   * needsReply：REQUEST 时回包；callbackId 是客户端的配对号，回包原样带回。
   */
  async dispatch(method, reqBytes, ctx, needsReply, callbackId = 0) {
    const h = this.handlers.get(method);
    if (!h) {
      this.stats.unknownMethod++;
      if (needsReply) {
        this.replyError(ctx.connId, method, callbackId, ERR.NOT_FOUND, `unknown method: ${method}`);
      }
      return;
    }
    try {
      const rspBytes = await h(reqBytes, ctx);
      if (needsReply) {
        this.replyOk(ctx.connId, method, callbackId, rspBytes);
      }
    } catch (e) {
      if (needsReply) {
        const detail = e instanceof Error ? e.message : String(e);
        this.replyError(ctx.connId, method, callbackId, ERR.UNKNOWN, detail);
      }
    }
  }
  // ---------------- 实体 → 客户端（rpcRequest / rpcNotify） ----------------
  /**
   * 服务端调客户端，等回包。返回类型由 RspSchema 推出（同 rpc.ts 的 callEntity）。
   * 只有玩家实体可用（怪没有连接，调了直接拒绝）。
   */
  rpcRequest(method, req, rsp, options = {}) {
    if (this.connId === void 0) {
      return Promise.reject(
        new RpcError(`\u5B9E\u4F53 ${this.id}\uFF08${this.type}\uFF09\u4E0D\u662F\u73A9\u5BB6\uFF0C\u6CA1\u6709\u53EF\u8C03\u7528\u7684\u5BA2\u6237\u7AEF`, ERR.NOT_FOUND)
      );
    }
    const id = this.nextCallbackId++;
    if (this.nextCallbackId > 4294967295) this.nextCallbackId = 1;
    return this.sendRequest(method, req, id, options.timeoutMs ?? 1e4).then((bytes) => fromBinary2(rsp, bytes));
  }
  /** 服务端推客户端，不等回包。 */
  rpcNotify(method, ntf) {
    if (this.connId === void 0) {
      throw new RpcError(`\u5B9E\u4F53 ${this.id}\uFF08${this.type}\uFF09\u4E0D\u662F\u73A9\u5BB6\uFF0C\u6CA1\u6709\u53EF\u63A8\u9001\u7684\u5BA2\u6237\u7AEF`, ERR.NOT_FOUND);
    }
    this.down.send(forwardCallClient(3 /* MSG_NOTIFY */, this.connId, this.id, method, 0, ntf));
  }
  // ---------------- 实体视图同步（组视图的原语） ----------------
  /** 把自己的视图建到某个客户端（组内新成员要看见我）。 */
  createRemoteTo(player, content) {
    if (player.connId === void 0) return;
    this.down.send(envelopeBytes(
      3 /* MSG_NOTIFY */,
      "hub.createRemoteEntity",
      0,
      0,
      toBinary2(HubCreateRemoteEntitySchema, create2(HubCreateRemoteEntitySchema, {
        connId: player.connId,
        entityId: this.id,
        entityType: this.type,
        content
      }))
    ));
  }
  /** 从某个客户端的视图里删掉自己（组内成员离开）。 */
  deleteRemoteFrom(player) {
    if (player.connId === void 0) return;
    this.down.send(envelopeBytes(
      3 /* MSG_NOTIFY */,
      "hub.deleteRemoteEntity",
      0,
      0,
      toBinary2(HubDeleteRemoteEntitySchema, create2(HubDeleteRemoteEntitySchema, {
        connId: player.connId,
        entityId: this.id
      }))
    ));
  }
  /** 给某个客户端刷新自己的视图（属性变化，全量内容）。 */
  refreshTo(player, content) {
    if (player.connId === void 0) return;
    this.down.send(envelopeBytes(
      3 /* MSG_NOTIFY */,
      "hub.refreshEntity",
      0,
      0,
      toBinary2(HubRefreshEntitySchema, create2(HubRefreshEntitySchema, {
        connId: player.connId,
        entityId: this.id,
        entityType: this.type,
        content
      }))
    ));
  }
  // ---------------- 内部 ----------------
  sendRequest(method, body, id, timeout) {
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeout++;
        reject(new RpcError(`\u8C03\u7528\u8D85\u65F6: ${method}`, ERR.TIMEOUT));
      }, timeout) : void 0;
      this.pending.set(id, { resolve, reject, timer, method });
      this.down.send(forwardCallClient(1 /* MSG_REQUEST */, this.connId, this.id, method, id, body));
    });
  }
  /** gate.clientResponse 到达（Server 按 entity_id 配对到实体后调用）。 */
  onClientResponse(callbackId, status, body) {
    const p = this.pending.get(callbackId);
    if (!p) return;
    this.pending.delete(callbackId);
    if (p.timer) clearTimeout(p.timer);
    if (status !== ERR.OK) {
      let detail = "";
      try {
        detail = fromBinary2(ErrorCodeSchema, body).detail;
      } catch {
      }
      p.reject(new RpcError(detail || `status=${status}`, status));
    } else {
      p.resolve(body);
    }
  }
  /** 实体销毁（Server 调）：拒绝所有在途请求、清 handler、跑清理钩子。 */
  destroy() {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(`\u5B9E\u4F53\u9500\u6BC1: ${p.method}`, ERR.NOT_FOUND));
    }
    this.pending.clear();
    this.handlers.clear();
    this.onDestroy?.();
  }
  replyOk(connId, method, callbackId, rspBytes) {
    this.down.send(forwardCallClient(2 /* MSG_RESPONSE */, connId, this.id, method, callbackId, rspBytes));
  }
  replyError(connId, method, callbackId, code, detail) {
    const err = toBinary2(ErrorCodeSchema, create2(ErrorCodeSchema, { code, detail }));
    this.down.send(forwardCallClient(2 /* MSG_RESPONSE */, connId, this.id, method, callbackId, err));
  }
};

// src/group.ts
import { create as create3, toBinary as toBinary3 } from "@bufbuild/protobuf";
var Group = class {
  id;
  members = /* @__PURE__ */ new Set();
  view;
  down;
  stats = { broadcasts: 0 };
  constructor(id, down, view) {
    this.id = id;
    this.down = down;
    this.view = view;
  }
  /**
   * 加入：双向视图同步（仿 abelkhan Group.Join）——
   * 新成员看到所有老成员的实体；每个老成员也看到新成员的实体。
   */
  join(e) {
    if (this.members.has(e)) return;
    const others = [...this.members];
    this.members.add(e);
    if (e.isPlayer) {
      for (const o of others) {
        o.createRemoteTo(e, this.view(o));
      }
    }
    for (const o of others) {
      if (o.isPlayer) {
        e.createRemoteTo(o, this.view(e));
      }
    }
  }
  /** 离开：把自己的视图从所有老成员的客户端里删掉。 */
  leave(e) {
    if (!this.members.delete(e)) return;
    for (const o of this.members) {
      if (o.isPlayer) {
        e.deleteRemoteFrom(o);
      }
    }
  }
  /** 组内成员（快照）。 */
  list() {
    return [...this.members];
  }
  get size() {
    return this.members.size;
  }
  /**
   * 广播给组内所有玩家：gate.forwardHubCallGroup（gate 侧按连接去重）。
   * content 是业务消息的编码字节；entityId 填广播的"来源实体"（可为空）。
   */
  rpcNotify(method, content, opts = {}) {
    const connIds = [...this.members].filter((e) => e.isPlayer).map((e) => e.connId);
    this.stats.broadcasts++;
    this.down.send(envelopeBytes(
      3 /* MSG_NOTIFY */,
      "gate.forwardHubCallGroup",
      0,
      0,
      toBinary3(GateForwardHubCallGroupSchema, create3(GateForwardHubCallGroupSchema, {
        connId: connIds,
        entityId: opts.from ?? "",
        method,
        content
      }))
    ));
  }
  /** 清空（服务器停机/组销毁时）：所有成员互相删除视图。 */
  clear() {
    const all = [...this.members];
    for (const leaver of all) {
      this.leave(leaver);
    }
  }
};

// src/server.ts
function createLogicServer(opts) {
  const { transport, nodeId } = opts;
  const view = opts.view ?? (() => new Uint8Array(0));
  const entities = /* @__PURE__ */ new Map();
  const groups = /* @__PURE__ */ new Map();
  const stats = {
    logins: 0,
    loginRejected: 0,
    unknownEntity: 0,
    badEnvelope: 0,
    disconnects: 0
  };
  const down = { send: (bytes) => transport.send(bytes) };
  function createEntity(id, type) {
    const e = new Entity(id, type, down);
    entities.set(id, e);
    return e;
  }
  function entityOf(id) {
    return entities.get(id);
  }
  function destroyEntity(id) {
    const e = entities.get(id);
    if (!e) return false;
    for (const g of groups.values()) {
      g.leave(e);
    }
    opts.onPlayerDestroy?.(e);
    e.destroy();
    entities.delete(id);
    return true;
  }
  function createGroup(id) {
    const existing = groups.get(id);
    if (existing) return existing;
    const g = new Group(id, down, view);
    groups.set(id, g);
    return g;
  }
  function groupOf(id) {
    return groups.get(id);
  }
  function destroyGroup(id) {
    groups.get(id)?.clear();
    groups.delete(id);
  }
  const global_ = {
    /**
     * 广播给整个游戏服所有玩家：gate.forwardHubCallGlobal。
     * 注意语义边界：gate 会把这条消息发给**它自己**的全部客户端连接；多 gate 部署时
     * 要对每台 gate 各发一条（P0 单 gate，先不建 gate 路由表）。
     */
    rpcNotify(method, content, from = "") {
      down.send(envelopeBytes(
        3 /* MSG_NOTIFY */,
        "gate.forwardHubCallGlobal",
        0,
        0,
        toBinary4(GateForwardHubCallGlobalSchema, create4(GateForwardHubCallGlobalSchema, {
          entityId: from,
          method,
          content
        }))
      ));
    }
  };
  function kick(connId, code, detail) {
    down.send(envelopeBytes(
      3 /* MSG_NOTIFY */,
      "hub.kickOffClient",
      0,
      0,
      toBinary4(HubKickOffClientSchema, create4(HubKickOffClientSchema, {
        connId,
        error: create4(ErrorCodeSchema, { code, detail }),
        promptInfo: detail
      }))
    ));
  }
  async function dispatch(bytes) {
    let env;
    try {
      env = fromBinary3(EnvelopeSchema, bytes);
    } catch {
      stats.badEnvelope++;
      return;
    }
    switch (env.method) {
      case "gate.clientLogin": {
        const fwd = fromBinary3(GateForwardClientRequestServiceSchema, env.body);
        let login;
        try {
          login = fromBinary3(LoginSchema, fwd.content);
        } catch {
          stats.badEnvelope++;
          kick(fwd.connId, ERR.BAD_FRAME, "login body \u89E3\u4E0D\u5F00");
          return;
        }
        const decision = opts.onLogin(login, fwd.connId);
        if (!decision.ok) {
          stats.loginRejected++;
          kick(fwd.connId, decision.code, decision.detail);
          return;
        }
        const player = new Entity(decision.entityId, decision.entityType, down, {
          connId: fwd.connId,
          userId: decision.userId
        });
        entities.set(decision.entityId, player);
        opts.onPlayerCreate?.(player);
        down.send(envelopeBytes(
          3 /* MSG_NOTIFY */,
          "hub.createPlayerEntity",
          0,
          0,
          toBinary4(HubCreatePlayerEntitySchema, create4(HubCreatePlayerEntitySchema, {
            connId: fwd.connId,
            userId: decision.userId,
            entityId: decision.entityId,
            entityType: decision.entityType,
            content: decision.content
          }))
        ));
        stats.logins++;
        return;
      }
      case "gate.clientRequest": {
        const needsReply = env.msgType === 1 /* MSG_REQUEST */;
        const body = needsReply ? fromBinary3(ClientRequestHubSchema, env.body) : fromBinary3(ClientNotifyHubSchema, env.body);
        const e = entities.get(body.entityId);
        if (!e) {
          stats.unknownEntity++;
          if (needsReply) {
            const err = toBinary4(ErrorCodeSchema, create4(ErrorCodeSchema, {
              code: ERR.NOT_FOUND,
              detail: `unknown entity: ${body.entityId}`
            }));
            down.send(forwardCallClient(2 /* MSG_RESPONSE */, body.connId, body.entityId, body.method, env.callbackId, err));
          }
          return;
        }
        const ctx = { connId: body.connId };
        await e.dispatch(body.method, body.content, ctx, needsReply, env.callbackId);
        return;
      }
      case "gate.clientResponse": {
        const body = fromBinary3(ClientResponseHubSchema, env.body);
        const e = entities.get(body.entityId);
        if (!e) {
          stats.unknownEntity++;
          return;
        }
        const status = body.error ? body.error.code : ERR.OK;
        e.onClientResponse(env.callbackId, status, body.content);
        return;
      }
      case "gate.clientDisconnect": {
        const body = fromBinary3(ClientDisconnectSchema, env.body);
        stats.disconnects++;
        if (body.entityId) {
          destroyEntity(body.entityId);
        }
        return;
      }
      case "gate.clientUplink": {
        try {
          const up = fromBinary3(ClientUplinkSchema, env.body);
          if (up.body?.case === "logout") {
            opts.onLogout?.(up.body.value.reason);
          }
        } catch {
          stats.badEnvelope++;
        }
        return;
      }
      case "gate.clientReconnect":
        return;
      default:
        stats.badEnvelope++;
        return;
    }
  }
  transport.onData((bytes) => {
    void dispatch(bytes);
  });
  return {
    nodeId,
    stats,
    createEntity,
    entityOf,
    destroyEntity,
    createGroup,
    groupOf,
    destroyGroup,
    global: global_,
    kick
  };
}

// scripts/e2e.ts
var LOGIC_PORT = 19501;
var CLIENT_PORT = 19502;
var ENTITY_ID = "e-e2e-player";
var GATE_BIN = process.env.GATE_BIN ?? join(fileURLToPath(new URL(".", import.meta.url)), "gate-e2e.exe");
var log = (...a) => console.log("[e2e]", ...a);
var fail = (msg) => {
  console.error("[e2e] \u2717 " + msg);
  process.exitCode = 1;
  throw new Error(msg);
};
async function waitPort(port, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      await new Promise((resolve, reject) => {
        const s = net2.createConnection({ host: "127.0.0.1", port }, () => {
          s.destroy();
          resolve();
        });
        s.on("error", reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) fail(`\u7AEF\u53E3 ${port} \u7B49\u4E0D\u5230 gate \u8D77\u6765`);
      await sleep(150);
    }
  }
}
function uplinkCall(entityId, content) {
  return toBinary5(ClientUplinkSchema, create5(ClientUplinkSchema, {
    body: { case: "call", value: create5(CallEntitySchema, { entityId, content }) }
  }));
}
var WsClient = class {
  ws;
  buf = new Uint8Array(0);
  inbox = [];
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${CLIENT_PORT}/ws`);
    this.ws.binaryType = "arraybuffer";
    this.ws.on("message", (data) => {
      const chunk = new Uint8Array(data);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      const consumed = decodeFrames(merged, (f) => {
        const env = fromBinary4(EnvelopeSchema, f.payload);
        this.inbox.push({ env, down: fromBinary4(ClientDownlinkSchema, env.body) });
      });
      this.buf = merged.slice(consumed);
    });
  }
  get opened() {
    return new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }
  send(msgType, method, callbackId, body) {
    this.ws.send(encodeFrame({
      flags: 0,
      ts: Date.now() & 4294967295,
      payload: toBinary5(EnvelopeSchema, create5(EnvelopeSchema, { msgType, method, callbackId, body }))
    }));
  }
  /** 等一条满足条件的下行（method 匹配 + msgType 匹配）。 */
  async recv(method, msgType, timeoutMs = 5e3) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const i = this.inbox.findIndex(({ env }) => env.method === method && env.msgType === msgType);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) fail(`\u7B49 ${method}(${msgType}) \u8D85\u65F6`);
      await sleep(20);
    }
  }
};
async function main() {
  const dir = mkdtempSync(join(tmpdir(), "gate-e2e-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ listen: { logic_port: LOGIC_PORT, client_port: CLIENT_PORT } }));
  const gate = spawn(GATE_BIN, ["-config", cfg], { stdio: ["ignore", "pipe", "pipe"] });
  gate.on("error", (e) => fail(`\u8D77\u4E0D\u4E86 gate\uFF08${GATE_BIN}\uFF09: ${e.message}`));
  try {
    await waitPort(LOGIC_PORT);
    await waitPort(CLIENT_PORT);
    log(`gate \u8D77\u6765\u4E86\uFF08logic :${LOGIC_PORT} / client :${CLIENT_PORT}\uFF09`);
    const transport = await connectGate({ host: "127.0.0.1", port: LOGIC_PORT, nodeId: "n-e2e-logic" });
    let player;
    let serverRsp;
    const server = createLogicServer({
      transport,
      nodeId: "n-e2e-logic",
      onLogin: (login) => {
        if (!login.token) return { ok: false, code: 4, detail: "no token" };
        return { ok: true, userId: "u-e2e", entityId: ENTITY_ID, entityType: "player", content: new Uint8Array([9]) };
      },
      onPlayerCreate: (p) => {
        player = p;
        p.register("entity.attack", RefreshEntitySchema, RefreshEntitySchema, (req) => create5(RefreshEntitySchema, { entityId: `hit-${req.entityId}`, entityType: "player", reason: 1 }));
      }
    });
    const client = new WsClient();
    await client.opened;
    log("\u5BA2\u6237\u7AEF WS \u5DF2\u8FDE");
    const loginBody = toBinary5(ClientUplinkSchema, create5(ClientUplinkSchema, {
      body: { case: "login", value: create5(LoginSchema, { token: "e2e-token", serverId: "s1" }) }
    }));
    client.send(1 /* MSG_REQUEST */, "client.login", 1, loginBody);
    const created = await client.recv("", 3 /* MSG_NOTIFY */);
    const cp = created.down.body?.case === "createPlayer" ? created.down.body.value : void 0;
    if (cp?.entityId !== ENTITY_ID) fail(`create_player \u7684\u5B9E\u4F53\u4E0D\u5BF9: ${cp?.entityId}`);
    if (server.entityOf(ENTITY_ID) !== player) fail("\u903B\u8F91\u670D\u6CA1\u5EFA\u73A9\u5BB6\u5B9E\u4F53");
    log(`\u2460 \u767B\u5F55\u95ED\u73AF \u2705  entity=${ENTITY_ID}`);
    const atkReq = create5(RefreshEntitySchema, { entityId: "m1", entityType: "monster", reason: 2 });
    client.send(1 /* MSG_REQUEST */, "entity.attack", 7, uplinkCall(ENTITY_ID, toBinary5(RefreshEntitySchema, atkReq)));
    const rsp = await client.recv("entity.attack", 2 /* MSG_RESPONSE */);
    if (rsp.env.callbackId !== 7) fail(`\u56DE\u5305 callback \u4E0D\u5BF9: ${rsp.env.callbackId}`);
    const rspCall = rsp.down.body?.case === "call" ? rsp.down.body.value : void 0;
    const rspBody = fromBinary4(RefreshEntitySchema, rspCall?.content ?? new Uint8Array());
    if (rspBody.entityId !== "hit-m1") fail(`\u56DE\u5305\u5185\u5BB9\u4E0D\u5BF9: ${rspBody.entityId}`);
    log(`\u2461 callEntity \u95ED\u73AF \u2705  attack(m1) \u2192 hit-m1\uFF08callback ${rsp.env.callbackId}\uFF09`);
    void (async () => {
      const q = await client.recv("entity.query", 1 /* MSG_REQUEST */);
      const answer = create5(RefreshEntitySchema, { entityId: "client-side", entityType: "player" });
      client.send(
        2 /* MSG_RESPONSE */,
        "entity.query",
        q.env.callbackId,
        uplinkCall(ENTITY_ID, toBinary5(RefreshEntitySchema, answer))
      );
    })();
    const queried = await player.rpcRequest("entity.query", new Uint8Array(0), RefreshEntitySchema);
    serverRsp = { entityId: queried.entityId };
    if (queried.entityId !== "client-side") fail(`rpcRequest \u56DE\u5305\u4E0D\u5BF9: ${queried.entityId}`);
    log(`\u2462 entity.rpcRequest \u95ED\u73AF \u2705  query \u2192 ${queried.entityId}`);
    const group = server.createGroup("scene-e2e");
    group.join(player);
    group.rpcNotify("scene.chat", toBinary5(RefreshEntitySchema, create5(RefreshEntitySchema, { entityId: "scene" })), { from: ENTITY_ID });
    const g = await client.recv("scene.chat", 3 /* MSG_NOTIFY */);
    if (g.down.body?.case !== "call") fail("\u7EC4\u5E7F\u64AD\u5E94\u8D70 ClientDownlink.call");
    log("\u2463 group.rpcNotify \u2705");
    server.global.rpcNotify("server.notice", new Uint8Array([1, 2]), ENTITY_ID);
    await client.recv("server.notice", 3 /* MSG_NOTIFY */);
    log("\u2464 global.rpcNotify \u2705");
    console.log("\ne2e \u5168\u94FE\u8DEF\u901A\u8FC7 \u2705");
  } finally {
    gate.kill();
    await sleep(100);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
main().catch((e) => {
  console.error("[e2e] \u5931\u8D25:", e);
  process.exit(1);
});
