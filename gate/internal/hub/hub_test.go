package hub

import (
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

type fakePeer struct {
	mu  sync.Mutex
	raw [][]byte // 已 marshal 的 Envelope 字节（与真 Peer 的 SendBytes 路径同构）
}

func (f *fakePeer) Send(env *pb.Envelope) error {
	b, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.raw = append(f.raw, b)
	return nil
}

func (f *fakePeer) SendBytes(b []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.raw = append(f.raw, b)
	return nil
}

func (f *fakePeer) last() *pb.Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.raw) == 0 {
		return nil
	}
	var env pb.Envelope
	if err := proto.Unmarshal(f.raw[len(f.raw)-1], &env); err != nil {
		return nil
	}
	return &env
}
func (f *fakePeer) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.raw) }

func newHub() (*Hub, *session.Table) {
	sess := session.New()
	return New(sess, func() uint32 { return 42 }, "gate-test", nil, Options{}), sess
}

func mustBody(t *testing.T, m proto.Message) []byte {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// 客户端请求 → 包成 ClientRequestHub 转给逻辑层，content 原样
func TestClientRequestForwardedUp(t *testing.T) {
	h, sess := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)
	sess.Bind(session.Session{ConnID: "c1", UserID: "u1", EntityID: "e1", NodeID: "n1"})

	content := []byte{1, 2, 3}
	mkUp := func(entityID string) *pb.ClientUplink {
		return &pb.ClientUplink{Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: entityID, Content: content}}}
	}
	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "entity.attack", CallbackId: 7}, mkUp("e1"))

	got := logic.last()
	if got == nil {
		t.Fatal("逻辑层没收到转发")
	}
	if got.GetMethod() != "gate.clientRequest" || got.GetCallbackId() != 7 || got.GetMsgType() != pb.MsgType_MSG_REQUEST {
		t.Fatalf("外层应是路由方法 + 原 callback_id: %+v", got)
	}
	var up pb.ClientRequestHub
	if err := proto.Unmarshal(got.GetBody(), &up); err != nil {
		t.Fatal(err)
	}
	if up.GetConnId() != "c1" || up.GetEntityId() != "e1" || up.GetMethod() != "entity.attack" {
		t.Fatalf("寻址/业务方法字段不对: %+v", &up)
	}
	if string(up.GetContent()) != string(content) {
		t.Fatalf("content 不应被改写: %v", up.GetContent())
	}
}

// 未登录连接的上行：丢弃 + 计数，不转发
func TestUnauthedClientDropped(t *testing.T) {
	h, _ := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)

	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "entity.attack", CallbackId: 1},
		&pb.ClientUplink{Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: "e1"}}})
	if logic.count() != 0 {
		t.Fatal("未登录不应转发")
	}
	if h.Stats().UnknownClient != 1 {
		t.Fatalf("应计数 UnknownClient，实际 %+v", h.Stats())
	}
}

// 逻辑层 CallClient → 客户端收到 CallEntity{RESPONSE/REQUEST 由 callback 决定}
func TestLogicCallClientDelivered(t *testing.T) {
	h, sess := newHub()
	client := &fakePeer{}
	h.AddClient("c1", client)
	sess.Bind(session.Session{ConnID: "c1", EntityID: "e1", NodeID: "n1"})

	body := mustBody(t, &pb.GateForwardHubCallClient{ConnId: "c1", EntityId: "e1", Content: []byte{9, 9}, Method: "entity.attack"})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "gate.forwardHubCallClient", CallbackId: 5, Body: body})

	got := client.last()
	if got == nil {
		t.Fatal("客户端没收到")
	}
	if got.GetMsgType() != pb.MsgType_MSG_REQUEST || got.GetCallbackId() != 5 {
		t.Fatalf("应是 REQUEST + 同一个 callback_id: %+v", got)
	}
	if got.GetMethod() != "entity.attack" {
		t.Fatalf("客户端应收到业务方法名，而不是路由方法名: %q", got.GetMethod())
	}
	var down pb.ClientDownlink
	if err := proto.Unmarshal(got.GetBody(), &down); err != nil {
		t.Fatal(err)
	}
	ce := down.GetCall()
	if ce == nil || ce.GetEntityId() != "e1" || string(ce.GetContent()) != string([]byte{9, 9}) {
		t.Fatalf("ClientDownlink.call 不对: %+v", &down)
	}
}

// 组播：名单里重复的连接只发一次
func TestGroupDedupes(t *testing.T) {
	h, _ := newHub()
	c1, c2 := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", c1)
	h.AddClient("c2", c2)

	body := mustBody(t, &pb.GateForwardHubCallGroup{ConnId: []string{"c1", "c1", "c2", "missing"}, EntityId: "e1", Content: []byte{7}})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "gate.forwardHubCallGroup", Body: body})

	if c1.count() != 1 || c2.count() != 1 {
		t.Fatalf("去重失败: c1=%d c2=%d", c1.count(), c2.count())
	}
}

// 广播：发给所有在线连接，且是 NOTIFY
func TestGlobalBroadcast(t *testing.T) {
	h, _ := newHub()
	c1, c2 := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", c1)
	h.AddClient("c2", c2)

	body := mustBody(t, &pb.GateForwardHubCallGlobal{EntityId: "e1", Content: []byte{1}})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "gate.forwardHubCallGlobal", Body: body})

	for _, c := range []*fakePeer{c1, c2} {
		if c.count() != 1 || c.last().GetMsgType() != pb.MsgType_MSG_NOTIFY {
			t.Fatalf("广播应各发一条 NOTIFY: %d", c.count())
		}
		var down pb.ClientDownlink
		if err := proto.Unmarshal(c.last().GetBody(), &down); err != nil {
			t.Fatal(err)
		}
		if cg := down.GetGlobal(); cg == nil || len(cg.GetContent()) != 1 {
			t.Fatalf("ClientDownlink.global 不对: %+v", &down)
		}
	}
}

// 同实体被新连接接管：旧连接收到 KickOff
func TestCreatePlayerEntityEvictsOldConn(t *testing.T) {
	h, _ := newHub()
	oldConn, newConn := &fakePeer{}, &fakePeer{}
	h.AddClient("old", oldConn)
	h.AddClient("new", newConn)

	mk := func(connID string) []byte {
		return mustBody(t, &pb.HubCreatePlayerEntity{ConnId: connID, UserId: "u1", EntityId: "e1"})
	}
	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mk("old")})
	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mk("new")})

	if oldConn.count() == 0 {
		t.Fatal("旧连接应收到 KickOff")
	}
	var down pb.ClientDownlink
	if err := proto.Unmarshal(oldConn.last().GetBody(), &down); err != nil || down.GetKickOff() == nil {
		t.Fatalf("旧连接应收到 ClientDownlink.kick_off: %v %+v", err, &down)
	}
}

// 帧入口：坏 Envelope 计数，不炸
func TestOnClientFrameBadEnvelope(t *testing.T) {
	h, _ := newHub()
	h.AddClient("c1", &fakePeer{})
	h.OnClientFrame("c1", frame.Frame{TS: 42, Payload: []byte{0xff, 0xff, 0xff}})
	if h.Stats().BadEnvelope != 1 {
		t.Fatalf("坏信封应计数: %+v", h.Stats())
	}
}

// ② 客户端 RESPONSE：应转成 ClientResponseHub 发给逻辑层
func TestClientResponseForwarded(t *testing.T) {
	h, sess := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)
	sess.Bind(session.Session{ConnID: "c1", EntityID: "e1", NodeID: "n1"})

	h.OnClient("c1",
		&pb.Envelope{MsgType: pb.MsgType_MSG_RESPONSE, Method: "entity.query", CallbackId: 9},
		&pb.ClientUplink{Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: "e1", Content: []byte{7}}}})

	got := logic.last()
	if got == nil || got.GetMsgType() != pb.MsgType_MSG_RESPONSE || got.GetCallbackId() != 9 {
		t.Fatalf("RESPONSE 未正确转发: %+v", got)
	}
	var r pb.ClientResponseHub
	if err := proto.Unmarshal(got.GetBody(), &r); err != nil {
		t.Fatal(err)
	}
	if r.GetEntityId() != "e1" || r.GetMethod() != "entity.query" {
		t.Fatalf("ClientResponseHub 字段不对: %+v", &r)
	}
}

// ① 客户端断开：应发 ClientDisconnect 给逻辑层
func TestDisconnectNotifiesLogic(t *testing.T) {
	h, _ := newHub()
	logic := &fakePeer{}
	h.AddLogic("n1", logic)
	h.AddClient("c1", &fakePeer{})

	h.RemoveClient("c1") // 无会话也发（user_id/entity_id 为空）

	got := logic.last()
	if got == nil || got.GetMethod() != "gate.clientDisconnect" {
		t.Fatalf("断开未通知逻辑层: %+v", got)
	}
	var d pb.ClientDisconnect
	if err := proto.Unmarshal(got.GetBody(), &d); err != nil {
		t.Fatal(err)
	}
	if d.GetConnId() != "c1" {
		t.Fatalf("conn_id 不对: %+v", &d)
	}
}

// ⑥ 按会话的 NodeID 选逻辑节点
func TestSendToLogicUsesSessionNode(t *testing.T) {
	h, sess := newHub()
	right, wrong := &fakePeer{}, &fakePeer{}
	h.AddLogic("n-right", right)
	h.AddLogic("n-wrong", wrong)
	sess.Bind(session.Session{ConnID: "c1", EntityID: "e1", NodeID: "n-right"})

	h.OnClient("c1",
		&pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "entity.move"},
		&pb.ClientUplink{Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: "e1"}}})

	if wrong.count() != 0 {
		t.Fatal("不应发给 wrong 节点")
	}
	if right.count() == 0 {
		t.Fatal("应发给 right 节点")
	}
}

// ⑧ GateDrain：摘掉节点
func TestDrainRemovesLogicNode(t *testing.T) {
	h, _ := newHub()
	p := &fakePeer{}
	h.AddLogic("n1", p)

	body := mustBody(t, &pb.GateDrain{GateId: "n1", GraceMs: 5000, Reason: "upgrade"})
	h.OnLogic("other", &pb.Envelope{Method: "gate.drain", Body: body})

	// 再发一条给 n1 的消息：sendToLogic 应 fallback（节点已摘）或到别的节点，不应崩
	h.OnClient("c-none",
		&pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "entity.move"},
		&pb.ClientUplink{Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: "e1"}}})
}

// ---------------- NATS 旁路 ----------------

// fakeMQ 模拟 *natsmq.Client 的 Consume 语义：订阅拿 channel，cancel 后 channel close。
type fakeMQ struct {
	mu     sync.Mutex
	subs   map[string][]chan []byte // subject → 订阅者们（顶号窗口内可能 >1）
	canon  map[string]chan []byte   // subject → 当前活跃订阅
	closed map[chan []byte]bool     // 订阅 channel → 是否已退（按 channel 记：顶号重订阅不算旧账）
}

func newFakeMQ() *fakeMQ {
	return &fakeMQ{subs: map[string][]chan []byte{}, canon: map[string]chan []byte{}, closed: map[chan []byte]bool{}}
}

func (f *fakeMQ) Consume(subject string) (<-chan []byte, func()) {
	ch := make(chan []byte, 16)
	f.mu.Lock()
	f.subs[subject] = append(f.subs[subject], ch)
	f.canon[subject] = ch
	f.mu.Unlock()
	return ch, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if !f.closed[ch] {
			f.closed[ch] = true
			close(ch)
		}
	}
}

// push 向 subject 的活跃订阅塞一条消息（测试里模拟逻辑服务器 Publish）。
func (f *fakeMQ) push(t *testing.T, subject string, data []byte) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	ch, ok := f.canon[subject]
	if !ok {
		t.Fatalf("%s 没有订阅", subject)
	}
	select {
	case ch <- data:
	default:
		t.Fatal("假 MQ channel 满")
	}
}

func (f *fakeMQ) subscribed(subject string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch, ok := f.canon[subject]
	return ok && !f.closed[ch]
}

// ⑨ NATS 旁路：建会话时订阅 entity_{id}_gate_mq，收到 Envelope 后走 OnLogic 同一套分派下发
func TestMqBypassDeliversDown(t *testing.T) {
	mq := newFakeMQ()
	sess := session.New()
	h := New(sess, func() uint32 { return 42 }, "gate-test", mq, Options{})
	client := &fakePeer{}
	h.AddClient("c1", client)

	// 建会话（走 TCP 路径的 createPlayerEntity 也应触发 MQ 订阅）
	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mustBody(t,
		&pb.HubCreatePlayerEntity{ConnId: "c1", UserId: "u1", EntityId: "e1"})})

	if !mq.subscribed("entity_e1_gate_mq") {
		t.Fatal("建会话后应已订阅 entity_e1_gate_mq")
	}

	// 逻辑服务器把一条与 TCP 同构的 Envelope 投到 MQ（无帧头）
	body := mustBody(t, &pb.GateForwardHubCallClient{ConnId: "c1", EntityId: "e1", Content: []byte{7}, Method: "entity.attack"})
	mq.push(t, "entity_e1_gate_mq", mustBody(t,
		&pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "gate.forwardHubCallClient", CallbackId: 5, Body: body}))

	waitFor(t, func() bool { return client.last() != nil && client.last().GetMethod() == "entity.attack" })
	got := client.last()
	if got.GetCallbackId() != 5 {
		t.Fatalf("NATS 旁路下发字段不对: %+v", got)
	}

	// 断开：订阅退掉
	h.RemoveClient("c1")
	if mq.subscribed("entity_e1_gate_mq") {
		t.Fatal("断开后应已退订 entity_e1_gate_mq")
	}
}

// ⑩ 顶号：旧订阅退掉、新订阅生效，不重复消费
func TestMqEvictionResubscribes(t *testing.T) {
	mq := newFakeMQ()
	sess := session.New()
	h := New(sess, func() uint32 { return 42 }, "gate-test", mq, Options{})
	old, fresh := &fakePeer{}, &fakePeer{}
	h.AddClient("old", old)
	h.AddClient("new", fresh)

	mk := func(conn string) *pb.Envelope {
		return &pb.Envelope{Method: "hub.createPlayerEntity", Body: mustBody(t,
			&pb.HubCreatePlayerEntity{ConnId: conn, UserId: "u1", EntityId: "e1"})}
	}
	h.OnLogic("n1", mk("old"))
	// 同实体新连接绑走旧连接：旧订阅应被退（canon 换成新的活跃订阅）
	h.OnLogic("n1", mk("new"))

	if !mq.subscribed("entity_e1_gate_mq") {
		t.Fatal("新会话应持有订阅")
	}
	// 顶号会把建会话推送 + KickOff 发给旧连接，先记下它的基线，只验证 MQ 下发不重复达
	baseOld := old.count()

	// 活跃订阅应是第二个（顶号后旧 channel 已 close，push 只会进新的）
	body := mustBody(t, &pb.GateForwardHubCallClient{ConnId: "new", EntityId: "e1", Content: []byte{1}, Method: "m"})
	mq.push(t, "entity_e1_gate_mq", mustBody(t, &pb.Envelope{Method: "gate.forwardHubCallClient", Body: body}))

	waitFor(t, func() bool { return fresh.last() != nil && fresh.last().GetMethod() == "m" })
	if old.count() != baseOld {
		t.Fatalf("旧连接不应再收到 MQ 下发: 基线 %d，实际 %d", baseOld, old.count())
	}
}

// 坏信封（解不开的 Envelope）走 BadEnvelope 计数，不崩
func TestMqBadEnvelopeCounted(t *testing.T) {
	mq := newFakeMQ()
	sess := session.New()
	h := New(sess, func() uint32 { return 42 }, "gate-test", mq, Options{})
	h.AddClient("c1", &fakePeer{})
	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mustBody(t,
		&pb.HubCreatePlayerEntity{ConnId: "c1", UserId: "u1", EntityId: "e1"})})

	mq.push(t, "entity_e1_gate_mq", []byte{0xff, 0xff, 0xff, 0xff})
	waitFor(t, func() bool { return h.Stats().BadEnvelope == 1 })
}

// waitFor 轮询等异步泵 goroutine 完成（上限 1s）。
func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("等待异步条件超时")
}

// ⑪ 逻辑层对客户端 REQUEST 的回包：forwardHubCallClient + MSG_RESPONSE 原样透传
// （客户端 callEntity 的闭环腿：请求 cb=N 上来，回包 cb=N 下去）
func TestLogicResponsePassthrough(t *testing.T) {
	h, _ := newHub()
	client := &fakePeer{}
	h.AddClient("c1", client)

	body := mustBody(t, &pb.GateForwardHubCallClient{ConnId: "c1", EntityId: "e1", Content: []byte{9}, Method: "entity.attack"})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_RESPONSE, Method: "gate.forwardHubCallClient", CallbackId: 7, Body: body})

	got := client.last()
	if got == nil {
		t.Fatal("客户端没收到回包")
	}
	if got.GetMsgType() != pb.MsgType_MSG_RESPONSE || got.GetCallbackId() != 7 {
		t.Fatalf("RESPONSE 应原样透传（msgType + callbackId），实际 %+v", got)
	}
}

// 回包透传不影响既有语义：callback≠0 且非 RESPONSE 仍是服务端调客户端的 REQUEST
func TestLogicRequestStillRequest(t *testing.T) {
	h, _ := newHub()
	client := &fakePeer{}
	h.AddClient("c1", client)

	body := mustBody(t, &pb.GateForwardHubCallClient{ConnId: "c1", EntityId: "e1", Content: []byte{9}, Method: "entity.attack"})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "gate.forwardHubCallClient", CallbackId: 11, Body: body})

	got := client.last()
	if got.GetMsgType() != pb.MsgType_MSG_REQUEST || got.GetCallbackId() != 11 {
		t.Fatalf("服务端调客户端仍是 REQUEST，实际 %+v", got)
	}
}

// ---------------- 登录闭环 / 心跳 / ping ----------------

func newHubWithOpts(opts Options) *Hub {
	sess := session.New()
	return New(sess, func() uint32 { return 42 }, "gate-test", nil, opts)
}

// at 取第 i 条下行 Envelope（按发送顺序；空的 pong 帧解出来是空 Envelope）。
func (f *fakePeer) at(i int) *pb.Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i < 0 || i >= len(f.raw) {
		return nil
	}
	var env pb.Envelope
	if err := proto.Unmarshal(f.raw[i], &env); err != nil {
		return nil
	}
	return &env
}

func downlinkOf(t *testing.T, env *pb.Envelope) *pb.ClientDownlink {
	t.Helper()
	if env == nil {
		t.Fatal("没有下行")
	}
	var down pb.ClientDownlink
	if err := proto.Unmarshal(env.GetBody(), &down); err != nil {
		t.Fatalf("下行 body 不是 ClientDownlink: %v", err)
	}
	return &down
}

// 连上就发 NotifyConnID：conn_id / proto_ver / 服务端时间 / 心跳间隔 / 单帧上限
func TestOnConnectedSendsNotifyConnID(t *testing.T) {
	h := newHubWithOpts(Options{HeartbeatMS: 30_000})
	client := &fakePeer{}
	h.AddClient("c1", client)
	h.OnConnected("c1")

	env := client.last()
	if env.GetMsgType() != pb.MsgType_MSG_NOTIFY || env.GetMethod() != "" {
		t.Fatalf("NotifyConnID 应是 NOTIFY 且无业务方法名: %+v", env)
	}
	hello := downlinkOf(t, env).GetConnId()
	if hello == nil {
		t.Fatal("下行不是 ClientDownlink.conn_id")
	}
	if hello.GetConnId() != "c1" {
		t.Fatalf("conn_id 不对: %q", hello.GetConnId())
	}
	if hello.GetProtoVer() != ProtoVersion {
		t.Fatalf("proto_ver 不对: %d", hello.GetProtoVer())
	}
	if hello.GetServerTimeMs() != 42 {
		t.Fatalf("server_time_ms 应取 now(): %d", hello.GetServerTimeMs())
	}
	if hello.GetHeartbeatMs() != 30_000 {
		t.Fatalf("heartbeat_ms 应来自 Options: %d", hello.GetHeartbeatMs())
	}
	if hello.GetMaxFrameBytes() != frame.MaxPayload {
		t.Fatalf("max_frame_bytes 应是解码器强制的上限: %d", hello.GetMaxFrameBytes())
	}
}

// 登录成功：hub.createPlayerEntity → 先给实体、再回 LoginResult（原 callback_id）
func TestLoginAnsweredOnCreatePlayerEntity(t *testing.T) {
	h, _ := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)

	login := &pb.ClientUplink{Body: &pb.ClientUplink_Login{Login: &pb.Login{Token: "tk"}}}
	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "client.login", CallbackId: 7}, login)

	fwd := logic.last()
	if fwd.GetMethod() != "gate.clientLogin" || fwd.GetCallbackId() != 7 {
		t.Fatalf("登录应原样转给逻辑层（含 callback_id）: %+v", fwd)
	}

	body := mustBody(t, &pb.HubCreatePlayerEntity{ConnId: "c1", UserId: "u1", EntityId: "e1", EntityType: "player"})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "hub.createPlayerEntity", Body: body})

	if client.count() != 2 {
		t.Fatalf("应收到 create_player + login 回包两条，实际 %d", client.count())
	}
	if cp := downlinkOf(t, client.at(0)).GetCreatePlayer(); cp.GetEntityId() != "e1" {
		t.Fatalf("第一条应是 CreatePlayerEntity: %+v", cp)
	}

	env := client.at(1)
	if env.GetMsgType() != pb.MsgType_MSG_RESPONSE || env.GetCallbackId() != 7 || env.GetStatus() != 0 {
		t.Fatalf("第二条应是登录的 RESPONSE（原 callback_id、status=0）: %+v", env)
	}
	if env.GetMethod() != "client.login" {
		t.Fatalf("回包的 method 应回显登录请求: %q", env.GetMethod())
	}
	lr := downlinkOf(t, env).GetLogin()
	if lr.GetUserId() != "u1" || lr.GetEntityId() != "e1" {
		t.Fatalf("LoginResult 字段不对: %+v", lr)
	}
	if len(lr.GetResumeToken()) != 0 || lr.GetFullResync() {
		t.Fatalf("本次 resume_token 留空、full_resync=false: %+v", lr)
	}
}

// 登录失败：先回 status（body 为空），再 KickOff
func TestLoginRejectedAnswersStatusThenKick(t *testing.T) {
	h, _ := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)

	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "client.login", CallbackId: 9},
		&pb.ClientUplink{Body: &pb.ClientUplink_Login{Login: &pb.Login{Token: "bad"}}})

	body := mustBody(t, &pb.HubKickOffClient{
		ConnId: "c1",
		Error:  &pb.ErrorCode{Code: 4, Detail: "该账号已在别处登录"},
	})
	h.OnLogic("n1", &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "hub.kickOffClient", Body: body})

	if client.count() != 2 {
		t.Fatalf("应收到登录失败回包 + KickOff 两条，实际 %d", client.count())
	}
	env := client.at(0)
	if env.GetMsgType() != pb.MsgType_MSG_RESPONSE || env.GetCallbackId() != 9 || env.GetStatus() != 4 {
		t.Fatalf("第一条应是 status=4 的 RESPONSE: %+v", env)
	}
	if len(env.GetBody()) != 0 {
		t.Fatalf("失败时 body 应为空: %v", env.GetBody())
	}
	if ko := downlinkOf(t, client.at(1)).GetKickOff(); ko.GetError().GetCode() != 4 {
		t.Fatalf("第二条应是 KickOff 且带错误码: %+v", ko)
	}
}

// 心跳：gate 直接答（原 callback_id），不再转给逻辑层
func TestHeartbeatAnsweredByGate(t *testing.T) {
	h, _ := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)

	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "client.heartbeat", CallbackId: 3},
		&pb.ClientUplink{Body: &pb.ClientUplink_Heartbeat{Heartbeat: &pb.HeartBeat{ClientTimeMs: 111}}})

	if logic.count() != 0 {
		t.Fatal("心跳不该转给逻辑层")
	}
	env := client.last()
	if env.GetMsgType() != pb.MsgType_MSG_RESPONSE || env.GetCallbackId() != 3 {
		t.Fatalf("心跳应是 RESPONSE + 原 callback_id: %+v", env)
	}
	hb := downlinkOf(t, env).GetHeartbeat()
	if hb.GetClientTimeMs() != 111 || hb.GetServerTimeMs() != 42 {
		t.Fatalf("HeartBeatResult 字段不对: %+v", hb)
	}
}

// len == 0 的帧是保活帧：原样回一个空帧
func TestEmptyFramePong(t *testing.T) {
	h, _ := newHub()
	client := &fakePeer{}
	h.AddClient("c1", client)

	h.OnClientFrame("c1", frame.Frame{TS: 1})

	if client.count() != 1 {
		t.Fatalf("应回一个 pong，实际 %d 条下行", client.count())
	}
	if len(client.raw[0]) != 0 {
		t.Fatalf("pong 应是空 payload（len=0），实际 %d 字节", len(client.raw[0]))
	}
}

// 顶号收尾：旧连接真正关闭时，断开通知要带 user/entity 且投给**旧会话所属的节点**
func TestEvictedConnDisconnectReachesOldNode(t *testing.T) {
	h, _ := newHub()
	oldConn, newConn := &fakePeer{}, &fakePeer{}
	oldNode, newNode := &fakePeer{}, &fakePeer{}
	h.AddClient("old", oldConn)
	h.AddClient("new", newConn)
	h.AddLogic("n-old", oldNode)
	h.AddLogic("n-new", newNode)

	mk := func(connID string) []byte {
		return mustBody(t, &pb.HubCreatePlayerEntity{ConnId: connID, UserId: "u1", EntityId: "e1"})
	}
	h.OnLogic("n-old", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mk("old")})
	h.OnLogic("n-new", &pb.Envelope{Method: "hub.createPlayerEntity", Body: mk("new")})

	// 旧连接此刻才关闭（会话已在 Bind 时被挤走）
	h.RemoveClient("old")

	got := oldNode.last()
	if got == nil {
		t.Fatal("旧节点没收到 ClientDisconnect")
	}
	if got.GetMethod() != "gate.clientDisconnect" {
		t.Fatalf("路由方法不对: %q", got.GetMethod())
	}
	var d pb.ClientDisconnect
	if err := proto.Unmarshal(got.GetBody(), &d); err != nil {
		t.Fatal(err)
	}
	if d.GetUserId() != "u1" || d.GetEntityId() != "e1" {
		t.Fatalf("顶号的断开必须带 user/entity（否则旧实体不退役）: %+v", &d)
	}
	if d.GetError().GetCode() != 4 {
		t.Fatalf("顶号应带错误码 4（DUPLICATE_LOGIN）: %+v", d.GetError())
	}

	// 新节点不该收到这条（它根本不知道旧连接）
	for _, raw := range newNode.raw {
		var env pb.Envelope
		if err := proto.Unmarshal(raw, &env); err != nil {
			continue
		}
		if env.GetMethod() == "gate.clientDisconnect" {
			t.Fatal("断开通知投给了错的节点")
		}
	}
}

// 普通断开：错误码为空（0），行为不变
func TestNormalDisconnectHasNoErrorCode(t *testing.T) {
	h, _ := newHub()
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)

	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity",
		Body: mustBody(t, &pb.HubCreatePlayerEntity{ConnId: "c1", UserId: "u1", EntityId: "e1"})})
	h.RemoveClient("c1")

	var d pb.ClientDisconnect
	if err := proto.Unmarshal(logic.last().GetBody(), &d); err != nil {
		t.Fatal(err)
	}
	if d.GetError().GetCode() != 0 {
		t.Fatalf("普通断开不该带错误码: %+v", d.GetError())
	}
	if d.GetEntityId() != "e1" {
		t.Fatalf("普通断开也要带 entity: %+v", &d)
	}
}
