// 客户端 → 逻辑层（**上行**）：解 ClientUplink oneof，按成员分派转发给逻辑节点。
//
// 入口是 OnClientFrame（接入层 clientgate 把 WS 字节读成帧后调它）；
// 分派规则见 OnClient 的 switch；选节点见 sendToLogic。
package hub

import (
	"log"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
)

// OnClientFrame 处理一条来自客户端的原始帧：解 Envelope → 解 **ClientUplink oneof** → 分派。
// 接入层（WebSocket）只负责"把字节读成帧"，不做信封层的事。
func (h *Hub) OnClientFrame(connID string, f frame.Frame) {
	if len(f.Payload) == 0 {
		return // len==0 的帧是 ping，接入层直接回空帧
	}
	if ms, suspect := frame.OneWayDelayMs(h.now(), f.TS); suspect {
		log.Printf("[%s] 异常时钟：延迟 %d ms（已 clamp，不参与判定）", connID, ms)
	}

	var env pb.Envelope
	if err := proto.Unmarshal(f.Payload, &env); err != nil {
		h.badEnvelope()
		return
	}
	var up pb.ClientUplink
	if err := proto.Unmarshal(env.GetBody(), &up); err != nil {
		h.badEnvelope()
		return
	}
	h.OnClient(connID, &env, &up)
}

// OnClient 按 oneof 的成员分派。形状由 protobuf 表达，这里不再靠方法名前缀猜。
func (h *Hub) OnClient(connID string, env *pb.Envelope, up *pb.ClientUplink) {
	h.mu.Lock()
	h.stats.ClientFrames++
	h.mu.Unlock()

	switch body := up.GetBody().(type) {
	case *pb.ClientUplink_Call:
		if env.GetMsgType() == pb.MsgType_MSG_RESPONSE {
			// ② 客户端对服务端 CallEntity{REQUEST} 的回包：
			// 配对靠 callback_id，逻辑层只关心"哪个实体回的什么"，不关心在哪条连接上。
			s, ok := h.sess.ByConn(connID)
			if !ok {
				h.unknownClient()
				return
			}
			b, err := protoMarshal(&pb.ClientResponseHub{
				EntityId: s.EntityID,
				// 客户端回包的载荷在 ClientUplink.call.content 里（不是外层 body：
				// body 是 ClientUplink 包装；错误时客户端把 ErrorCode 放在 content 里）
				Error:   errorOf(env.GetStatus(), body.Call.GetContent()),
				Content: body.Call.GetContent(),
				Method:  env.GetMethod(),
			})
			if err != nil {
				return
			}
			h.sendToLogic(connID, "gate.clientResponse", pb.MsgType_MSG_RESPONSE, env.GetCallbackId(), b)
			h.mu.Lock()
			h.stats.ForwardedUp++
			h.mu.Unlock()
			return
		}
		h.forwardCall(connID, env, body.Call)

	case *pb.ClientUplink_Login:
		// ④ 登录不是透传：逻辑层需要知道"谁在哪台 gate 的哪条连接上登录"，
		// 否则回包（HubCreatePlayerEntity）找不到目标连接。
		b, err := protoMarshal(&pb.GateForwardClientRequestService{
			ServiceName: "auth",
			GateName:    h.gateName,
			ConnId:      connID,
			Content:     marshalUplinkMember(up, env),
		})
		if err != nil {
			return
		}
		h.sendToLogic(connID, "gate.clientLogin", pb.MsgType_MSG_REQUEST, env.GetCallbackId(), b)
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()

	case *pb.ClientUplink_Reconnect:
		// ③ 重连：逻辑层需要旧 conn 的会话信息 + 新连接 id，才能判断"恢复还是全量重建"。
		s, _ := h.sess.ByConn(connID) // 新连接通常还没绑会话
		b, err := protoMarshal(&pb.GateForwardClientRequestReconnect{
			GateName: h.gateName,
			ConnId:   connID,
			UserId:   s.UserID, // 可能为空（旧连接的会话已摘），由逻辑层凭 resume_token 判定
			Content:  marshalUplinkMember(up, env),
		})
		if err != nil {
			return
		}
		h.sendToLogic(connID, "gate.clientReconnect", pb.MsgType_MSG_REQUEST, env.GetCallbackId(), b)
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()

	case *pb.ClientUplink_Logout, *pb.ClientUplink_Heartbeat, *pb.ClientUplink_Ack:
		// 其余框架消息：原样交给逻辑层（gate 不解释）
		h.sendToLogic(connID, "gate.clientUplink", env.GetMsgType(), env.GetCallbackId(), env.GetBody())
		h.mu.Lock()
		h.stats.ForwardedUp++
		h.mu.Unlock()

	default:
		h.badEnvelope()
	}
}

// forwardCall 处理 CallEntity：要回包的走 ClientRequestHub，否则走 ClientNotifyHub。
func (h *Hub) forwardCall(connID string, env *pb.Envelope, call *pb.CallEntity) {
	s, ok := h.sess.ByConn(connID)
	if !ok {
		h.mu.Lock()
		h.stats.UnknownClient++
		h.mu.Unlock()
		return
	}
	_ = s // 会话存在即可；目标实体来自 call.entity_id（可能是别的怪/NPC）

	var body []byte
	var err error
	if env.GetMsgType() == pb.MsgType_MSG_REQUEST {
		body, err = protoMarshal(&pb.ClientRequestHub{
			ConnId: connID, EntityId: call.GetEntityId(), Content: call.GetContent(), Method: env.GetMethod(),
		})
	} else {
		body, err = protoMarshal(&pb.ClientNotifyHub{
			ConnId: connID, EntityId: call.GetEntityId(), Content: call.GetContent(), Method: env.GetMethod(),
		})
	}
	if err != nil {
		return
	}
	h.sendToLogic(connID, "gate.clientRequest", env.GetMsgType(), env.GetCallbackId(), body)
	h.mu.Lock()
	h.stats.ForwardedUp++
	h.mu.Unlock()
}

// sendToLogic 把消息发给逻辑节点。
//
// 寻址规则：**connID 有会话时用会话绑定的 NodeID**（实体在哪个节点就发哪里）；
// 未登录（无会话）则任选一个（登录请求任何节点都能处理，处理完由逻辑层下发
// HubCreatePlayerEntity 把会话绑到那个节点）。
func (h *Hub) sendToLogic(connID, method string, msgType pb.MsgType, callbackID uint32, body []byte) {
	h.mu.RLock()
	var peer Peer
	if connID != "" {
		if s, ok := h.sess.ByConn(connID); ok && s.NodeID != "" {
			peer = h.logics[s.NodeID]
		}
	}
	if peer == nil {
		for _, p := range h.logics { // 未登录或节点不在了：任取一个
			peer = p
			break
		}
	}
	h.mu.RUnlock()
	if peer == nil {
		return // 没有逻辑节点：丢弃（调用方超时）
	}
	_ = peer.Send(&pb.Envelope{MsgType: msgType, Method: method, CallbackId: callbackID, Body: body})
}
