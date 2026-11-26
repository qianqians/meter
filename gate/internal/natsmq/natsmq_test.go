package natsmq

import (
	"testing"

	"github.com/nats-io/nats.go"
)

func TestSubjects(t *testing.T) {
	if got := GateSubject("e-42"); got != "entity_e-42_gate_mq" {
		t.Fatalf("GateSubject = %q", got)
	}
	if got := LogicSubject("e-42"); got != "entity_e-42_logic_mq" {
		t.Fatalf("LogicSubject = %q", got)
	}
}

func TestFeedDeliverAndRead(t *testing.T) {
	f := newFeed(8)
	f.deliver(&nats.Msg{Data: []byte("ping")})
	f.deliver(&nats.Msg{Data: []byte("pong")})

	if got := <-f.ch; string(got) != "ping" {
		t.Fatalf("第一条 = %q", got)
	}
	if got := <-f.ch; string(got) != "pong" {
		t.Fatalf("第二条 = %q", got)
	}
}

func TestFeedDropWhenFull(t *testing.T) {
	f := newFeed(2)
	f.deliver(&nats.Msg{Data: []byte("1")})
	f.deliver(&nats.Msg{Data: []byte("2")})
	f.deliver(&nats.Msg{Data: []byte("3")}) // 应被丢弃，不阻塞

	if got := <-f.ch; string(got) != "1" {
		t.Fatalf("第一条 = %q", got)
	}
	if got := <-f.ch; string(got) != "2" {
		t.Fatalf("第二条 = %q", got)
	}
	select {
	case got := <-f.ch:
		t.Fatalf("第三条应被丢弃，实际收到 %q", got)
	default:
	}
	if f.dropped != 1 {
		t.Fatalf("丢弃计数 = %d", f.dropped)
	}
}

// 关键用例：cancel（close）返回之后，在途的 deliver 不能再写 channel（否则 close panic）。
func TestFeedNoDeliverAfterClose(t *testing.T) {
	f := newFeed(8)
	f.deliver(&nats.Msg{Data: []byte("before")})
	f.close()

	// close 后再来一条：必须被丢弃，而不是 panic
	f.deliver(&nats.Msg{Data: []byte("after")})

	if got := <-f.ch; string(got) != "before" {
		t.Fatalf("close 前的消息 = %q", got)
	}
	// channel 已 close：读出 drained 值之后应该是零值 + closed
	if got, ok := <-f.ch; ok {
		t.Fatalf("close 后应读不到值，实际 %q", got)
	}
}

// 消费方标准姿势：for range + cancel 退出。
func TestFeedRangeExitsOnClose(t *testing.T) {
	f := newFeed(8)
	go func() {
		for i := 0; i < 3; i++ {
			f.deliver(&nats.Msg{Data: []byte{byte(i)}})
		}
		f.close()
	}()
	var n int
	for range f.ch {
		n++
	}
	if n != 3 {
		t.Fatalf("收到 %d 条，应为 3", n)
	}
}
