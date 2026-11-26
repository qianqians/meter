package hub

// 热路径基准：上行转发 / 下行投递 / 全服广播 / 组播。
// fakePeer 的 Send 是空操作，测的是 hub + proto + 锁的成本（不含 socket）。
// 用 -benchmem 看 allocs/op，用 RunParallel 看锁竞争。

import (
	"testing"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

var content64 = make([]byte, 64) // 典型上行消息体

func benchHub(b *testing.B) (*Hub, *fakePeer, *fakePeer) {
	sess := session.New()
	h := New(sess, func() uint32 { return 42 }, "gate-bench", nil)
	client, logic := &fakePeer{}, &fakePeer{}
	h.AddClient("c1", client)
	h.AddLogic("n1", logic)
	sess.Bind(session.Session{ConnID: "c1", UserID: "u1", EntityID: "e1", NodeID: "n1"})
	return h, client, logic
}

// 上行：客户端 REQUEST（CallEntity）→ ClientRequestHub → 逻辑节点
func benchUplinkBytes(b *testing.B) (frame.Frame, *Hub) {
	h, _, _ := benchHub(b)
	upBytes, _ := proto.Marshal(&pb.ClientUplink{
		Body: &pb.ClientUplink_Call{Call: &pb.CallEntity{EntityId: "e1", Content: content64}},
	})
	envBytes, _ := proto.Marshal(&pb.Envelope{
		MsgType: pb.MsgType_MSG_REQUEST, Method: "entity.attack", CallbackId: 7, Body: upBytes,
	})
	return frame.Frame{TS: 1, Payload: envBytes}, h
}

func BenchmarkUplinkForward(b *testing.B) {
	f, h := benchUplinkBytes(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.OnClientFrame("c1", f)
	}
}

func BenchmarkUplinkForwardParallel(b *testing.B) {
	f, h := benchUplinkBytes(b)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb2 *testing.PB) {
		for pb2.Next() {
			h.OnClientFrame("c1", f)
		}
	})
}

// 下行：逻辑层 CallClient → 客户端
func BenchmarkDownlinkCallClient(b *testing.B) {
	h, _, _ := benchHub(b)
	body, _ := protoMarshal(&pb.GateForwardHubCallClient{
		ConnId: "c1", EntityId: "e1", Content: content64, Method: "entity.attack",
	})
	env := &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "gate.forwardHubCallClient", CallbackId: 5, Body: body}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.OnLogic("n1", env)
	}
}

// 全服广播：100 客户端
func BenchmarkGlobalBroadcast100(b *testing.B) {
	h, _, _ := benchHub(b)
	for i := 0; i < 100; i++ {
		h.AddClient("c"+itoaBench(i), &fakePeer{})
	}
	body, _ := protoMarshal(&pb.GateForwardHubCallGlobal{Method: "server.notice", Content: content64})
	env := &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "gate.forwardHubCallGlobal", Body: body}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.OnLogic("n1", env)
	}
}

// 组播：50 连接
func BenchmarkGroupBroadcast50(b *testing.B) {
	h, _, _ := benchHub(b)
	ids := make([]string, 50)
	for i := range ids {
		ids[i] = "c" + itoaBench(i)
		h.AddClient(ids[i], &fakePeer{})
	}
	body, _ := protoMarshal(&pb.GateForwardHubCallGroup{ConnId: ids, EntityId: "e1", Method: "scene.sync", Content: content64})
	env := &pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "gate.forwardHubCallGroup", Body: body}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.OnLogic("n1", env)
	}
}

func itoaBench(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
