// 逻辑层链路：裸 TCP（对内）。
//
// 方向：**logic 主动连 gate**（gate 是接入层，通常比逻辑层更靠外；这样逻辑层不需要知道
// gate 的地址，扩容 gate 也不用改逻辑层配置）。一条 TCP 连接 = 一个逻辑节点。
//
// 握手（P0 占位）：连接建立后逻辑节点发第一条 `Envelope{method:"logic.hello", body=NodeDesc}
// 不需要——我们把"节点 id"放在第一帧的 method 前缀里，见 hello 处理；真实现应该用
// consul 的 service metadata 或一条 `LogicHello{node_id}` 消息。这里为了不新增 proto，
// 先约定：第一帧必须是 `Envelope{method:"logic.hello", body = 不透明字节（utf8 的 node_id）}`。
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
	out, err := frame.Encode(frame.Frame{TS: p.now(), Payload: b})
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	_, err = p.conn.Write(out)
	return err
}
