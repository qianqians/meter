// hub 是 gate 的中央：连接与会话的唯一真相。
//
//	客户端（WebSocket，对外）  ⇄  hub  ⇄  逻辑层（TCP，对内）
//
// 本文件只放**公共核心**：Hub 结构、计数器、连接注册/注销、握手与登录回包。两个方向的消息处理
// 各成一个文件：
//
//	client.go —— 客户端 → 逻辑层（上行）
//	logic.go  —— 逻辑层 → 客户端（下行）
//
// 它**不认识任何业务消息**：客户端的 `content`、逻辑层的 `content` 一律当不透明字节搬。
// 唯一读的字段是寻址用的 `entity_id` / `conn_id`（见 docs/protocol-map.md §4.6）。
package hub

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
	"meter/gate/internal/sessiondir"
)

// ProtoVersion 是 NotifyConnID.proto_ver 的值：只有**不兼容**的协议改动才 +1（加字段不算）。
// 客户端拿它判断能否直接与本 gate 通信；协议自身的版本记录在 schema/SPEC.md。
const ProtoVersion uint32 = 1

// Directory 是跨 gate 会话目录的能力面（*sessiondir.Dir 实现它）。
// 抽成接口是为了 hub 能在没有 Redis 的情况下被单测。
type Directory interface {
	Claim(ctx context.Context, userID string, e sessiondir.Entry) (*sessiondir.Entry, uint64, error)
	Refresh(ctx context.Context, userID, gate, conn string) (bool, error)
	Release(ctx context.Context, userID, gate, conn string) (bool, error)
}

// Options 是本 gate 向客户端宣告的参数（与路由无关，所以不进 session 表）。
type Options struct {
	// HeartbeatMS 是建议心跳间隔（NotifyConnID.heartbeat_ms）；0 = 不下发建议。
	HeartbeatMS uint32

	// Dir 是跨 gate 会话目录；nil = 未启用（只跑单 gate 时）。
	// 它只影响**跨 gate** 顶号：同 gate 内的顶号靠会话表就够。
	Dir Directory
}

// Peer 是一个能收 Envelope 的对端（客户端连接或逻辑层连接）。
type Peer interface {
	Send(env *pb.Envelope) error
	// SendBytes 发一段**已 marshal 的 Envelope 字节**。广播路径用它：消息只 marshal 一次，
	// 逐连接只做帧编码与写出（若逐连接调 Send，同一消息会被 proto.Marshal N 遍）。
	SendBytes(envBytes []byte) error
}

// pendingLogin 是一条等逻辑层裁决的登录请求：回包要原样带回这两个值。
type pendingLogin struct {
	callbackID uint32
	method     string
}

// Hub 负责：客户端 ⇄ 逻辑层的转发、会话表维护、广播扇出。
type Hub struct {
	sess     *session.Table
	now      func() uint32 // 单调毫秒，用于帧头 ts
	gateName string        // 本 gate 的标识（转发给逻辑层时它需要知道回哪里）
	opts     Options

	mq     MQ                // NATS 旁路（nil = 未启用，订阅/退订全部跳过）
	mqSubs map[string]func() // entity_id → 退订函数（订阅生命周期跟随会话，见 mq.go）

	mu      sync.RWMutex
	clients map[string]Peer // conn_id → 客户端连接
	logics  map[string]Peer // node_id → 逻辑层连接

	// evictedSessions：conn_id → 被新连接挤掉的旧会话。
	// Bind 会把它从会话表里删掉，但**连接还没关**：等它真正关闭时（RemoveClient）要用这份记录
	// 发一条带 user/entity 的 ClientDisconnect，否则逻辑层不知道旧实体该退役。
	evictedSessions map[string]session.Session

	// loginPending：conn_id → 正在等裁决的登录请求。
	// 登录要等逻辑层回 hub.createPlayerEntity / hub.kickOffClient 才有结果，
	// 那两条消息里没有客户端的 callback_id，所以只能在这里记。
	loginPending map[string]pendingLogin

	// dir 是跨 gate 会话目录（nil = 未启用）。
	dir Directory

	// stats 是纯原子计数，**不走 h.mu**：每条消息要加 2~3 次计数，跟连接表共用一把锁
	// 会让多核并发完全串行（bench 实测 16 并发零加速）。快照用 Stats()。
	stats statsCounters
}

// Stats 是 hub 的计数器快照（上 metrics 时直接读这个）。真值存在 statsCounters 里，原子加。
type Stats struct {
	ClientFrames  uint64
	LogicFrames   uint64
	UnknownClient uint64 // 目标 conn 不存在
	BadEnvelope   uint64
	ForwardedUp   uint64
	ForwardedDown uint64
	Kicks         uint64
}

// statsCounters 是 Stats 的原子实现（字段与 Stats 一一对应）。
type statsCounters struct {
	clientFrames  atomic.Uint64
	logicFrames   atomic.Uint64
	unknownClient atomic.Uint64
	badEnvelope   atomic.Uint64
	forwardedUp   atomic.Uint64
	forwardedDown atomic.Uint64
	kicks         atomic.Uint64
}

func New(sess *session.Table, now func() uint32, gateName string, mq MQ, opts Options) *Hub {
	return &Hub{
		sess:            sess,
		now:             now,
		gateName:        gateName,
		opts:            opts,
		dir:             opts.Dir,
		mq:              mq,
		clients:         make(map[string]Peer),
		logics:          make(map[string]Peer),
		evictedSessions: make(map[string]session.Session),
		loginPending:    make(map[string]pendingLogin),
	}
}

// Stats 返回计数器的快照。
func (h *Hub) Stats() Stats {
	return Stats{
		ClientFrames:  h.stats.clientFrames.Load(),
		LogicFrames:   h.stats.logicFrames.Load(),
		UnknownClient: h.stats.unknownClient.Load(),
		BadEnvelope:   h.stats.badEnvelope.Load(),
		ForwardedUp:   h.stats.forwardedUp.Load(),
		ForwardedDown: h.stats.forwardedDown.Load(),
		Kicks:         h.stats.kicks.Load(),
	}
}

// ---------------- 连接注册 ----------------

// AddClient 登记一条已握手的客户端连接。
func (h *Hub) AddClient(connID string, p Peer) {
	h.mu.Lock()
	h.clients[connID] = p
	h.mu.Unlock()
}

// OnConnected 在一条客户端连接登记后调用：下发 NotifyConnID。
//
// 它是 client.proto 写明的"连接建立后第一条消息"：客户端靠它拿到 conn_id（重连时要带回）、
// 生效的协议版本、建议心跳间隔与单帧上限。与 AddClient 分开是为了让顺序显式可见——
// AddClient 只做登记，不发包。
func (h *Hub) OnConnected(connID string) {
	hello := &pb.NotifyConnID{
		ConnId:       connID,
		ProtoVer:     ProtoVersion,
		ServerTimeMs: uint64(h.now()),
		HeartbeatMs:  h.opts.HeartbeatMS,
		// 下发**解码器真正强制的**上限，而不是配置里那个名字相同、实际未接入的旋钮。
		MaxFrameBytes: frame.MaxPayload,
	}
	h.deliverDown(connID, "", &pb.ClientDownlink{
		Body: &pb.ClientDownlink_ConnId{ConnId: hello},
	})
}

// sendPong 回一个**空帧**：协议里 `len == 0` 就是保活帧，帧头的 ts 已能算 RTT，
// 不必再包一个 protobuf 心跳消息（那是最贵的那种保活）。
func (h *Hub) sendPong(connID string) {
	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		return
	}
	// SendBytes 会在 payload 前编上 8 字节帧头；payload 为 nil 就是 len=0 的帧。
	if err := p.SendBytes(nil); err == nil {
		h.stats.forwardedDown.Add(1)
	}
}

// ---------------- 登录回包 ----------------

// noteLogin 记下一条登录请求的配对号（转发给逻辑层前调，因为裁决可能先到）。
func (h *Hub) noteLogin(connID string, callbackID uint32, method string) {
	if callbackID == 0 {
		return // 客户端把登录当 NOTIFY 发：没有回包可言
	}
	if method == "" {
		method = "client.login"
	}
	h.mu.Lock()
	h.loginPending[connID] = pendingLogin{callbackID: callbackID, method: method}
	h.mu.Unlock()
}

// takeLogin 取走并清除（裁决来了、或连接断了）。
func (h *Hub) takeLogin(connID string) (pendingLogin, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	p, ok := h.loginPending[connID]
	delete(h.loginPending, connID)
	return p, ok
}

// answerLogin 回应客户端的登录请求。
//
// 成功（status == 0）带 ClientDownlink{login: LoginResult}；失败只给 status，body 为空——
// 这是 client.proto 定下的形状："成功时才解析本消息；失败时信封 status ≠ 0、包体为空"。
func (h *Hub) answerLogin(connID string, req pendingLogin, status uint32, result *pb.LoginResult) {
	var body []byte
	if status == 0 {
		if result == nil {
			result = &pb.LoginResult{}
		}
		body = mustMarshal(&pb.ClientDownlink{Body: &pb.ClientDownlink_Login{Login: result}})
	}
	env := &pb.Envelope{
		MsgType:    pb.MsgType_MSG_RESPONSE,
		Method:     req.method,
		CallbackId: req.callbackID,
		Status:     status,
		Body:       body,
	}

	h.mu.RLock()
	p := h.clients[connID]
	h.mu.RUnlock()
	if p == nil {
		h.stats.unknownClient.Add(1)
		return
	}
	if err := p.SendBytes(mustMarshal(env)); err == nil {
		h.stats.forwardedDown.Add(1)
	}
}

// RemoveClient 注销客户端连接：摘会话表 + **通知逻辑层**。
//
// 必须发 ClientDisconnect：否则逻辑层不知道玩家离线——实体不会下线、好友收不到下线事件、
// 离线消息也不会转存。这是"连接断开"成为一条协议消息的全部理由。
func (h *Hub) RemoveClient(connID string) {
	h.mu.Lock()
	delete(h.clients, connID)
	delete(h.loginPending, connID) // 没等到裁决就断了：别把配对号留在表里
	evicted, wasEvicted := h.evictedSessions[connID]
	delete(h.evictedSessions, connID)
	h.mu.Unlock()

	s := h.sess.Unbind(connID)
	if s == nil && wasEvicted {
		// 顶号：会话已经被新连接挤走，但这条连接此刻才真正关闭。
		// 用记下来的旧会话发断开通知——否则 user/entity 是空的，逻辑层的旧实体永远不退役。
		s = &evicted
	}
	var userID, entityID, nodeID string
	if s != nil {
		userID, entityID, nodeID = s.UserID, s.EntityID, s.NodeID
		log.Printf("[%s] 断开 user=%s entity=%s（顶号: %v）", connID, userID, entityID, wasEvicted)
		h.unsubscribeEntity(entityID) // 会话没了：gate_mq 订阅同步退掉
	}

	// 释放目录里的归属。带 gate+conn 比对：这条连接如果已经被新会话顶掉，记录已归别人，
	// Release 是空操作，不会删掉新会话。
	if h.dir != nil && userID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if _, rerr := h.dir.Release(ctx, userID, h.gateName, connID); rerr != nil {
			log.Printf("[%s] 会话目录释放失败: %v", connID, rerr)
		}
		cancel()
	}

	body, err := protoMarshal(&pb.ClientDisconnect{
		ConnId:   connID,
		UserId:   userID,   // 未登录为空
		EntityId: entityID, // 同上
		Error:    disconnectReason(wasEvicted),
	})
	if err != nil {
		return
	}
	// 投给**旧会话所属的节点**：会话已经不在了，按 conn 查节点会退化到"任选一个"。
	h.sendToNode(nodeID, "gate.clientDisconnect", pb.MsgType_MSG_NOTIFY, 0, body)
}

// disconnectReason 把"断开原因"变成协议里的错误码：顶号 = 4（DUPLICATE_LOGIN），普通断开 = 0。
func disconnectReason(evicted bool) *pb.ErrorCode {
	if !evicted {
		return nil
	}
	return &pb.ErrorCode{Code: 4, Detail: "该账号已在别处登录"}
}

// noteEvicted 记下被挤掉的旧会话，等它的连接真正关闭时使用。
func (h *Hub) noteEvicted(s session.Session) {
	h.mu.Lock()
	h.evictedSessions[s.ConnID] = s
	h.mu.Unlock()
}

// AddLogic 登记一个逻辑节点（TCP 对内）。
func (h *Hub) AddLogic(nodeID string, p Peer) {
	h.mu.Lock()
	h.logics[nodeID] = p
	h.mu.Unlock()
	log.Printf("逻辑节点接入: %s（共 %d 个）", nodeID, h.logicCount())
}

// RemoveLogic 注销逻辑节点。
func (h *Hub) RemoveLogic(nodeID string) {
	h.mu.Lock()
	delete(h.logics, nodeID)
	h.mu.Unlock()
	log.Printf("逻辑节点断开: %s（剩 %d 个）", nodeID, h.logicCount())
}

// LogicCount 已接入的逻辑节点数。
func (h *Hub) LogicCount() int { return h.logicCount() }

func (h *Hub) logicCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.logics)
}

// RefreshSessions 给本 gate 在线会话的目录记录续期（main 按 TTL/3 调）。
//
// 续期同样带 gate+conn 比对：本 gate 上的旧会话即使还没删，也不会给别人的新会话续命。
func (h *Hub) RefreshSessions() {
	if h.dir == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, s := range h.sess.Snapshot() {
		if s.UserID == "" {
			continue
		}
		if _, err := h.dir.Refresh(ctx, s.UserID, h.gateName, s.ConnID); err != nil {
			log.Printf("[%s] 会话目录续期失败: %v", s.ConnID, err)
		}
	}
}

// GateName 本 gate 的标识：转发给逻辑层、以及握手回包（GateHello）里告诉它"这条链路是哪台"。
func (h *Hub) GateName() string { return h.gateName }

// ClientCount 在线连接数（压测/指标用）。
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
