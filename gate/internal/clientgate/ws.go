// 客户端接入：WebSocket（对外）。
//
// 为什么用 WebSocket 而不是裸 TCP：小游戏 / H5 渠道只能 `new WebSocket`，目标客户端矩阵里
// 大部分入口都走 WSS。协议本身不依赖它——**帧头与 Envelope 与内部 TCP 完全一样**，
// 只是"字节怎么到对端"不同。我们仍然保留自己的帧头，因为一条 WS 消息里可以塞多帧，
// 将来换回裸 TCP / QUIC 时上层代码不用改。
package clientgate

import (
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	"meter/gate/internal/hub"
	pb "meter/gate/internal/pb"
)

// Server 是面向客户端的 WebSocket 接入。
type Server struct {
	hub      *hub.Hub
	upgrader websocket.Upgrader
	connSeq  atomic.Uint64
	path     string
	now      func() uint32 // 单调毫秒（低 32 位），用于帧头 ts
}

func New(h *hub.Hub, path string, now func() uint32) *Server {
	if path == "" {
		path = "/"
	}
	return &Server{
		hub:  h,
		path: path,
		now:  now,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  32 << 10,
			WriteBufferSize: 32 << 10,
			// 小游戏 / H5 场景下 Origin 不可靠；真正的准入在 Login（token）里做
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

// Handler 返回 HTTP handler（挂到 http.Server 上即可）。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(s.path, s.handle)
	return mux
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	c, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer c.Close()

	connID := "c-" + strconv.FormatUint(s.connSeq.Add(1), 10)
	peer := &wsPeer{c: c, now: s.now}
	s.hub.AddClient(connID, peer)
	defer s.hub.RemoveClient(connID)
	log.Printf("[%s] WS 接入 %s", connID, r.RemoteAddr)

	buf := make([]byte, 0, 64<<10)
	for {
		_ = c.SetReadDeadline(time.Now().Add(90 * time.Second)) // 略大于心跳间隔
		_, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		buf = append(buf, data...)
		consumed, ferr := frame.Decode(buf, func(f frame.Frame) { s.hub.OnClientFrame(connID, f) })
		if ferr != nil {
			log.Printf("[%s] 帧错误，断开: %v", connID, ferr)
			return
		}
		buf = append(buf[:0], buf[consumed:]...)
	}
}

// wsPeer 把一条 WS 连接包成 hub.Peer。gorilla 的连接不是并发安全的，所以写侧加锁。
type wsPeer struct {
	c   *websocket.Conn
	now func() uint32
	mu  sync.Mutex
}

func (p *wsPeer) Send(env *pb.Envelope) error {
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
	return p.c.WriteMessage(websocket.BinaryMessage, out)
}

// SendAndClose 先发最后一帧，再发 WebSocket close 帧，最后关连接。
// 踢人消息必须比 close 先到——否则客户端只会看到"连接被重置"，看不到原因。
func (p *wsPeer) SendAndClose(env *pb.Envelope) error {
	if err := p.Send(env); err != nil {
		_ = p.c.Close()
		return err
	}
	p.mu.Lock()
	_ = p.c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	p.mu.Unlock()
	time.Sleep(10 * time.Millisecond) // 给内核一个把 FIN 排在数据后面的机会
	return p.c.Close()
}

// Close 让 hub 能在别的地方关掉连接。
func (p *wsPeer) Close() error { return p.c.Close() }
