package hub

import (
	"sync"
	"testing"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

type fakePeer struct {
	mu   sync.Mutex
	sent []*pb.Envelope
}

func (f *fakePeer) Send(env *pb.Envelope) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, env)
	return nil
}
func (f *fakePeer) last() *pb.Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		return nil
	}
	return f.sent[len(f.sent)-1]
}
func (f *fakePeer) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.sent) }

func newHub() (*Hub, *session.Table) {
	sess := session.New()
	return New(sess, func() uint32 { return 42 }, "gate-test"), sess
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
