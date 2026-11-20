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
	return New(sess, func() uint32 { return 42 }), sess
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
	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "entity.attack", CallbackId: 7, Body: content})

	got := logic.last()
	if got == nil {
		t.Fatal("逻辑层没收到转发")
	}
	if got.GetMethod() != "entity.attack" || got.GetCallbackId() != 7 || got.GetMsgType() != pb.MsgType_MSG_REQUEST {
		t.Fatalf("信封字段不对: %+v", got)
	}
	var up pb.ClientRequestHub
	if err := proto.Unmarshal(got.GetBody(), &up); err != nil {
		t.Fatal(err)
	}
	if up.GetConnId() != "c1" || up.GetEntityId() != "e1" {
		t.Fatalf("寻址字段不对: %+v", &up)
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

	h.OnClient("c1", &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "entity.attack", CallbackId: 1})
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
	var ce pb.CallEntity
	if err := proto.Unmarshal(got.GetBody(), &ce); err != nil {
		t.Fatal(err)
	}
	if ce.GetEntityId() != "e1" || string(ce.GetContent()) != string([]byte{9, 9}) {
		t.Fatalf("CallEntity 不对: %+v", &ce)
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
		var cg pb.CallGlobal
		if err := proto.Unmarshal(c.last().GetBody(), &cg); err != nil {
			t.Fatal(err)
		}
		if len(cg.GetContent()) != 1 {
			t.Fatalf("CallGlobal.content 不对: %+v", &cg)
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

	if oldConn.count() == 0 || oldConn.last().GetMethod() != "client.kickOff" {
		t.Fatal("旧连接应收到 KickOff")
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
