package logiclink

import (
	"net"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	"meter/gate/internal/hub"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

// 握手回包：gate 必须告诉逻辑节点"这条链路是哪台 gate"——多 gate 寻址全靠它。
func TestHelloAckCarriesGateName(t *testing.T) {
	h := hub.New(session.New(), func() uint32 { return 1 }, "gate-x", nil, hub.Options{})
	srv := New(h, func() uint32 { return 1 })

	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	go srv.serveConn(serverConn)

	// 逻辑节点：首帧 logic.hello，body = node_id
	hello, err := proto.Marshal(&pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: helloMethod, Body: []byte("n-1")})
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := frame.Encode(frame.Frame{TS: 1, Payload: hello})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := clientConn.Write(pkt); err != nil {
		t.Fatal(err)
	}

	// 读回包
	_ = clientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 512)
	for {
		n, rerr := clientConn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			var got *pb.Envelope
			consumed, ferr := frame.Decode(buf, func(f frame.Frame) {
				var env pb.Envelope
				if err := proto.Unmarshal(f.Payload, &env); err == nil {
					got = &env
				}
			})
			if ferr != nil {
				t.Fatal(ferr)
			}
			if got != nil {
				buf = buf[consumed:]
				if got.GetMethod() != "logic.hello.ack" {
					t.Fatalf("回包方法不对: %q", got.GetMethod())
				}
				var hello pb.GateHello
				if err := proto.Unmarshal(got.GetBody(), &hello); err != nil {
					t.Fatal(err)
				}
				if hello.GetGateName() != "gate-x" || hello.GetProtoVer() != hub.ProtoVersion {
					t.Fatalf("hello.ack 字段不对: %+v", &hello)
				}
				return
			}
		}
		if rerr != nil {
			t.Fatalf("没等到 hello.ack: %v", rerr)
		}
	}
}
