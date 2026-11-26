// natsmq 是 gate 的消息队列层（**旁路**，不是主通道）。
//
// 两层 IPC 的分工（见 docs/protocol-map.md §2）：
//
//	· TCP 直连（logiclink）：gate ⇄ 逻辑层的主通道，低延迟、帧头 + Envelope；
//	· NATS（本包）：跨进程的异步投递，subject 约定——
//	    entity_{id}_logic_mq —— 服务器 → 服务器，entity 所在服务器监听
//	    entity_{id}_gate_mq  —— 服务器 → gate，玩家所在 gate 监听并转发给客户端
//	  消息体与 TCP 链路完全同构：marshal 后的 pb.Envelope（收端送进 hub.OnLogic 即可复用分派）。
//
// 只用**核心 NATS**（无 JetStream）：at-most-once、断线期间消息不补——旁路丢了不致命，
// 要可靠性时再开 JetStream，接口不用变。
package natsmq

import (
	"log"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// GateSubject 是投递给"玩家所在 gate"的 subject。
func GateSubject(entityID string) string { return "entity_" + entityID + "_gate_mq" }

// LogicSubject 是投递给"entity 所在服务器"的 subject。
func LogicSubject(entityID string) string { return "entity_" + entityID + "_logic_mq" }

// Client 是一个 NATS 连接的薄包装。零值不可用，用 Connect。
type Client struct {
	conn *nats.Conn
}

// Connect 建连（name 用节点 id，方便在 NATS 侧做连接观测）。
// 断线重连是 nats.go 内建的（默认无限重试），订阅在重连后自动恢复，这里只挂日志。
func Connect(url, name string) (*Client, error) {
	conn, err := nats.Connect(url,
		nats.Name(name),
		nats.MaxReconnects(-1), // 旁路永不放弃重连；期间 Publish 会进本地缓冲（见 nats.go MaxPending 的默认行为）
		nats.ReconnectWait(2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				log.Printf("nats: 断开: %v", err)
			}
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			log.Printf("nats: 已重连 %s", c.ConnectedUrl())
		}),
		nats.ErrorHandler(func(_ *nats.Conn, sub *nats.Subscription, err error) {
			log.Printf("nats: 订阅 %s 出错: %v", sub.Subject, err)
		}),
	)
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn}, nil
}

// Publish 发布一条消息（body 建议 = marshal 后的 Envelope）。
func (c *Client) Publish(subject string, body []byte) error {
	return c.conn.Publish(subject, body)
}

// Consume 订阅一个 subject，返回消息 channel 与取消函数（channel 拉取式消费）。
// 取消后 channel 会 close，`for range` 自然退出。
//
// 队列满时的策略是**丢弃并计数日志**（旁路 at-most-once，慢消费者不该反压 NATS 的分发线程）。
func (c *Client) Consume(subject string) (<-chan []byte, func()) {
	f := newFeed(128)
	sub, err := c.conn.Subscribe(subject, f.deliver)
	if err != nil {
		close(f.ch) // 订阅失败：给调用方一个"立刻结束"的 channel，而不是 nil
		return f.ch, func() {}
	}
	return f.ch, func() {
		_ = sub.Unsubscribe()
		f.close()
	}
}

// Close 关闭连接（停机路径）。
func (c *Client) Close() { c.conn.Close() }

// ---------------- channel 适配 ----------------

// feed 把 nats 的回调推送适配成 channel。它与 nats 连接解耦，
// 是为了能离线测试"关竞争"：cancel 返回后 deliver 不可能再碰 channel。
const feedBufferSize = 128

func newFeed(buf int) *feed {
	return &feed{ch: make(chan []byte, buf)}
}

type feed struct {
	ch      chan []byte
	mu      sync.Mutex
	closed  bool
	dropped int
}

func (f *feed) deliver(m *nats.Msg) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return // cancel 已返回：这条在途消息直接丢弃
	}
	select {
	case f.ch <- m.Data:
	default:
		f.dropped++
		if f.dropped == 1 || f.dropped%100 == 0 {
			log.Printf("natsmq: 消费过慢，已丢弃 %d 条消息（at-most-once，慢消费者不反压 NATS）", f.dropped)
		}
	}
}

func (f *feed) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	close(f.ch)
}
