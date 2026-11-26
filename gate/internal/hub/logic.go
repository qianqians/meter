// 逻辑层 → 客户端（**下行**）：按 Envelope.method 分派，组装 ClientDownlink 投递给客户端连接。
//
// 入口是 OnLogic（logiclink 把 TCP 字节读成帧、过完 logic.hello 握手后调它）。
// 下行的三段式：OnLogic（分派）→ sendCallEntity / deliverDown（组装+投递）→ wsPeer.Send。
package hub

import (
	"log"

	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

// OnLogic 处理一条来自逻辑层的 Envelope。
func (h *Hub) OnLogic(nodeID string, env *pb.Envelope) {
	h.mu.Lock()
	h.stats.LogicFrames++
	h.mu.Unlock()

	switch env.GetMethod() {
	case "hub.createPlayerEntity":
		// 建会话 + 给客户端下发 client.proto 的 CreatePlayerEntity。
		// **方法名是 gate 定的**（"client.createPlayerEntity"）：它属于框架面，不是业务方法。
		var m pb.HubCreatePlayerEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		if evicted := h.sess.Bind(session.Session{
			ConnID: m.GetConnId(), UserID: m.GetUserId(), EntityID: m.GetEntityId(), NodeID: nodeID,
		}); evicted != nil {
			log.Printf("实体 %s 被新连接重新绑定，踢掉旧连接 %s", m.GetEntityId(), evicted.ConnID)
			h.kick(evicted.ConnID, 4, "该账号已在别处登录")
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_CreatePlayer{CreatePlayer: &pb.CreatePlayerEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

	case "hub.createRemoteEntity":
		var m pb.HubCreateRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_CreateRemote{CreateRemote: &pb.CreateRemoteEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

	case "hub.deleteRemoteEntity":
		var m pb.HubDeleteRemoteEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_Delete{Delete: &pb.DeleteEntity{EntityId: m.GetEntityId()}},
		})

	case "hub.refreshEntity":
		var m pb.HubRefreshEntity
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.deliverDown(m.GetConnId(), "", &pb.ClientDownlink{
			Body: &pb.ClientDownlink_Refresh{Refresh: &pb.RefreshEntity{
				EntityId: m.GetEntityId(), EntityType: m.GetEntityType(), Content: m.GetContent(),
			}},
		})

	case "hub.kickOffClient":
		var m pb.HubKickOffClient
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.kick(m.GetConnId(), int(m.GetError().GetCode()), m.GetError().GetDetail())

	// 下面三条：外层 `Envelope.method` 是**路由方法**（gate 靠它知道 body 是什么），
	// 真正的业务方法名在 body 的 `method` 字段里，gate 原样放进下发的 Envelope.method。
	case "gate.forwardHubCallClient":
		var m pb.GateForwardHubCallClient
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.sendCallEntity(m.GetConnId(), m.GetEntityId(), m.GetMethod(), env.GetCallbackId(), m.GetContent())

	case "gate.forwardHubCallGroup":
		var m pb.GateForwardHubCallGroup
		if !h.unmarshalBody(env, &m) {
			return
		}
		// 名单是**连接**（由逻辑层解析好），这里只保证去重
		for _, cid := range dedupe(m.GetConnId()) {
			h.sendCallEntity(cid, m.GetEntityId(), m.GetMethod(), 0, m.GetContent())
		}

	case "gate.drain":
		// ⑧ 逻辑层通知 gate：我要停机了（gate 会停止向它投递新的上行）。
		// gate 侧的配合动作：把这个节点从"可投递"集合里摘掉（连接本身保留，在途消息能跑完）。
		var m pb.GateDrain
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.mu.Lock()
		delete(h.logics, m.GetGateId()) // 摘掉之后 sendToLogic 的 fallback 不会再选它
		h.mu.Unlock()
		log.Printf("逻辑节点 %s 请求排空（grace=%dms，原因=%s）", m.GetGateId(), m.GetGraceMs(), m.GetReason())

	case "gate.forwardHubCallGlobal":
		var m pb.GateForwardHubCallGlobal
		if !h.unmarshalBody(env, &m) {
			return
		}
		h.mu.RLock()
		peers := make([]Peer, 0, len(h.clients))
		for _, p := range h.clients {
			peers = append(peers, p)
		}
		h.mu.RUnlock()
		out := &pb.Envelope{
			MsgType: pb.MsgType_MSG_NOTIFY,
			Method:  m.GetMethod(),
			Body: mustMarshal(&pb.ClientDownlink{
				Body: &pb.ClientDownlink_Global{Global: &pb.CallGlobal{Content: m.GetContent()}},
			}),
		}
		for _, p := range peers {
			_ = p.Send(out)
		}
		h.mu.Lock()
		h.stats.ForwardedDown++
		h.mu.Unlock()

	default:
		h.mu.Lock()
		h.stats.BadEnvelope++
		h.mu.Unlock()
	}
}

// sendCallEntity 把一次调用投给某条连接（客户端收到的 body 是 CallEntity）。
func (h *Hub) sendCallEntity(connID, entityID, method string, callbackID uint32, content []byte) {
	msgType := pb.MsgType_MSG_NOTIFY
	if callbackID != 0 {
		msgType = pb.MsgType_MSG_REQUEST
	}
	h.deliverDown(connID, method, &pb.ClientDownlink{
		Body: &pb.ClientDownlink_Call{Call: &pb.CallEntity{EntityId: entityID, Content: content}},
	}, withMsgType(msgType), withCallback(callbackID))
}

// deliverDown 把一条 ClientDownlink 发给某条客户端连接。
// method 只在 call / global 两种成员上有意义（业务方法名），其余传空。
func (h *Hub) deliverDown(connID, method string, down *pb.ClientDownlink, opts ...deliverOpt) {
	o := deliverOptions{msgType: pb.MsgType_MSG_NOTIFY}
	for _, f := range opts {
		f(&o)
	}
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		h.mu.Lock()
		h.stats.UnknownClient++
		h.mu.Unlock()
		return
	}
	_ = p.Send(&pb.Envelope{MsgType: o.msgType, Method: method, CallbackId: o.callbackID, Body: mustMarshal(down)})
	h.mu.Lock()
	h.stats.ForwardedDown++
	h.mu.Unlock()
}

type deliverOptions struct {
	msgType    pb.MsgType
	callbackID uint32
}
type deliverOpt func(*deliverOptions)

func withMsgType(t pb.MsgType) deliverOpt { return func(o *deliverOptions) { o.msgType = t } }
func withCallback(id uint32) deliverOpt   { return func(o *deliverOptions) { o.callbackID = id } }

// ShutdownClient 关掉某条客户端连接（Peer 实现了 Close 时调用）。踢人路径使用。
func (h *Hub) ShutdownClient(connID string) {
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		return
	}
	if c, ok := p.(interface{ Close() error }); ok {
		_ = c.Close()
	}
}

// kick 断开某条客户端连接（先发 KickOff，再关）。
func (h *Hub) kick(connID string, code int, prompt string) {
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	env := &pb.Envelope{
		MsgType: pb.MsgType_MSG_NOTIFY,
		Body: mustMarshal(&pb.ClientDownlink{
			Body: &pb.ClientDownlink_KickOff{KickOff: &pb.KickOff{
				Error: &pb.ErrorCode{Code: int32(code), Detail: prompt}, PromptInfo: prompt,
			}},
		}),
	}
	if sc, ok := p.(interface{ SendAndClose(*pb.Envelope) error }); ok && p != nil {
		_ = sc.SendAndClose(env)
	} else if p != nil {
		_ = p.Send(env)
		h.ShutdownClient(connID)
	}
	h.mu.Lock()
	h.stats.Kicks++
	h.mu.Unlock()
}

// ---------------- 小工具 ----------------

func dedupe(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
