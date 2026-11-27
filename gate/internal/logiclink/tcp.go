// 逻辑层链路：裸 TCP（对内）。
//
// 方向：**logic 主动连 gate**（gate 是接入层，通常比逻辑层更靠外；这样逻辑层不需要知道
// gate 的地址，扩容 gate 也不用改逻辑层配置）。一条 TCP 连接 = 一个逻辑节点。
//
// 握手：
//
//	logic → gate   Envelope{method:"logic.hello", body = utf8 的 node_id}
//	gate → logic   Envelope{method:"logic.hello.ack", body = GateHello{gate_name, proto_ver}}
//
// 回包不是客套：逻辑节点可以同时连多台 gate，它必须知道**每条链路对面是哪台**——
// 实体记住自己在哪台 gate 上，cross-gate 顶号时才能把踢人消息发回旧连接那台。
package logiclink

import (
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	"meter/gate/internal/hub"
	pb "meter/gate/internal/pb"
)

const helloMethod = "logic.hello"

// Server 接受逻辑节点连入。
type Server struct {
	hub *hub.Hub
	now func() uint32
}

func New(h *hub.Hub, now func() uint32) *Server { return &Server{hub: h, now: now} }

// Serve 接受连接直到 listener 关闭。
func (s *Server) Serve(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err // 上层判断是不是 ctx 取消
		}
		go s.serveConn(conn)
	}
}

func (s *Server) serveConn(conn net.Conn) {
	defer conn.Close()

	peer := &tcpPeer{conn: conn, now: s.now}
	buf := make([]byte, 0, 64<<10)
	tmp := make([]byte, 32<<10)
	nodeID := ""

	for {
		_ = conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		n, err := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			consumed, ferr := frame.Decode(buf, func(f frame.Frame) {
				var env pb.Envelope
				if uerr := proto.Unmarshal(f.Payload, &env); uerr != nil {
					log.Printf("逻辑链路: Envelope 解不开，丢弃")
					return
				}
				if nodeID == "" {
					if env.GetMethod() != helloMethod {
						log.Printf("逻辑链路: 首帧必须是 %s，实际 %q，断开", helloMethod, env.GetMethod())
						_ = conn.Close()
						return
					}
					nodeID = string(env.GetBody())
					s.hub.AddLogic(nodeID, peer)
					// 告诉它这条链路是哪台 gate（见文件头）。发不出去就断开，别留一条"半认识"的链路。
					ack, aerr := proto.Marshal(&pb.GateHello{
						GateName: s.hub.GateName(),
						ProtoVer: hub.ProtoVersion,
					})
					if aerr != nil || peer.Send(&pb.Envelope{
						MsgType: pb.MsgType_MSG_NOTIFY, Method: "logic.hello.ack", Body: ack,
					}) != nil {
						log.Printf("逻辑链路: 回 hello.ack 失败，断开")
						_ = conn.Close()
						return
					}
					return
				}
				s.hub.OnLogic(nodeID, &env)
			})
			if ferr != nil {
				log.Printf("逻辑链路 %s: 帧错误，断开: %v", nodeID, ferr)
				if nodeID != "" {
					s.hub.RemoveLogic(nodeID)
				}
				return
			}
			buf = append(buf[:0], buf[consumed:]...)
		}
		if err != nil {
			if nodeID != "" {
				s.hub.RemoveLogic(nodeID)
			}
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				log.Printf("逻辑链路 %s: 读错误: %v", nodeID, err)
			}
			return
		}
	}
}

// tcpPeer 把一条逻辑连接包成 hub.Peer。
type tcpPeer struct {
	conn net.Conn
	now  func() uint32
	mu   sync.Mutex
}

func (p *tcpPeer) Send(env *pb.Envelope) error {
	b, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	return p.SendBytes(b)
}

// SendBytes 发已 marshal 的 Envelope 字节（广播路径：marshal 一次发 N 次，见 hub.Peer）。
func (p *tcpPeer) SendBytes(envBytes []byte) error {
	out, err := frame.Encode(frame.Frame{TS: p.now(), Payload: envBytes})
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	_, err = p.conn.Write(out)
	return err
}
