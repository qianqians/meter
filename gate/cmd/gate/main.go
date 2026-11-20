// gate 进程骨架：接入层（Go）。
//
// 现在的样子（P0 阶段，刻意保持小）：
//   · 监听 TCP，每条连接一个读写循环；
//   · 用 8 字节帧头切帧（internal/frame，与 TS 侧逐字节一致）；
//   · 解外层 Envelope，按 method 分派：
//       - "client.login"   → 建会话、回 LoginResult（现为占位实现）
//       - 其它 REQUEST     → 回 NOT_FOUND（还没接逻辑层）
//       - NOTIFY           → 丢弃并计数
//   · 会话表维护 conn ⇄ entity 双向路由（internal/session）。
//
// 还没做：WebSocket、TLS、真转发到逻辑层（consul 发现 + 连接池）、限流、压缩。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"google.golang.org/protobuf/proto"

	"meter/gate/internal/frame"
	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
)

type gate struct {
	sess      *session.Table
	connSeq   atomic.Uint64
	startedAt time.Time

	mu    sync.Mutex
	conns map[string]net.Conn
}

func newGate() *gate {
	return &gate{sess: session.New(), startedAt: time.Now(), conns: make(map[string]net.Conn)}
}

// nowMs 单调毫秒（低 32 位）。**不要用墙钟**——NTP 跳变会让延迟统计出现负数。
func (g *gate) nowMs() uint32 { return uint32(time.Since(g.startedAt).Milliseconds()) }

func (g *gate) serveConn(conn net.Conn) {
	defer conn.Close()
	g.connSeq.Add(1)
	connID := fmt.Sprintf("c-%d", g.connSeq.Load())

	g.mu.Lock()
	g.conns[connID] = conn
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.conns, connID)
		g.mu.Unlock()
		if s := g.sess.Unbind(connID); s != nil {
			log.Printf("[%s] 会话断开 user=%s entity=%s", connID, s.UserID, s.EntityID)
		}
	}()

	log.Printf("[%s] 接入 %s", connID, conn.RemoteAddr())

	buf := make([]byte, 0, 64<<10)
	tmp := make([]byte, 32<<10)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second)) // 略大于心跳间隔
		n, err := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			consumed, ferr := frame.Decode(buf, func(f frame.Frame) { g.onFrame(conn, connID, f) })
			if ferr != nil {
				log.Printf("[%s] 帧错误，断开: %v", connID, ferr)
				return
			}
			buf = append(buf[:0], buf[consumed:]...)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("[%s] 读错误: %v", connID, err)
			}
			return
		}
	}
}

// onFrame 解 Envelope 并按 method 分派。
func (g *gate) onFrame(conn net.Conn, connID string, f frame.Frame) {
	// 延迟统计（只做指标，不参与任何判定）
	if ms, suspect := frame.OneWayDelayMs(g.nowMs(), f.TS); suspect {
		log.Printf("[%s] 异常时钟：延迟 %d ms（已 clamp）", connID, ms)
	}

	if len(f.Payload) == 0 {
		// len == 0 的帧约定为 ping：原样回一个空帧
		if out, err := frame.Encode(frame.Frame{TS: g.nowMs()}); err == nil {
			_, _ = conn.Write(out)
		}
		return
	}

	var env pb.Envelope
	if err := proto.Unmarshal(f.Payload, &env); err != nil {
		log.Printf("[%s] Envelope 解不开，丢弃", connID)
		return
	}

	switch env.GetMethod() {
	case "client.login":
		g.handleLogin(conn, connID, &env)
	default:
		// 还没接逻辑层：REQUEST 回 NOT_FOUND，NOTIFY 直接丢（都计数）
		if env.GetMsgType() == pb.MsgType_MSG_REQUEST {
			g.replyError(conn, &env, 7, "gate: 逻辑层尚未接入")
		}
	}
}

// handleLogin 是占位实现：真实实现要把 token 转给逻辑层校验、由逻辑层决定 user/entity。
func (g *gate) handleLogin(conn net.Conn, connID string, env *pb.Envelope) {
	var req pb.Login
	if err := proto.Unmarshal(env.GetBody(), &req); err != nil {
		g.replyError(conn, env, 10, "login 包体解不开")
		return
	}
	// 占位：直接把 token 当 user_id，实体 id 由 gate 临时生成
	userID := "u-" + req.GetToken()
	entityID := "e-" + userID

	if ev := g.sess.Bind(session.Session{ConnID: connID, UserID: userID, EntityID: entityID, NodeID: "logic-local"}); ev != nil {
		log.Printf("[%s] 同实体被新连接接管，踢掉旧连接 %s", connID, ev.ConnID)
		g.kick(ev.ConnID, 4, "该账号已在别处登录")
	}

	rsp, err := proto.Marshal(&pb.LoginResult{UserId: userID, EntityId: entityID})
	if err != nil {
		return
	}
	g.reply(conn, env, 0, rsp)
	log.Printf("[%s] 登录 user=%s entity=%s", connID, userID, entityID)
}

// reply 回一条 RESPONSE（callback_id 原样带回）。
func (g *gate) reply(conn net.Conn, req *pb.Envelope, status uint32, body []byte) {
	env := &pb.Envelope{
		MsgType:    pb.MsgType_MSG_RESPONSE,
		Method:     req.GetMethod(),
		CallbackId: req.GetCallbackId(),
		Status:     status,
		Body:       body,
	}
	b, err := proto.Marshal(env)
	if err != nil {
		return
	}
	out, err := frame.Encode(frame.Frame{TS: g.nowMs(), Payload: b})
	if err != nil {
		return
	}
	_, _ = conn.Write(out)
}

func (g *gate) replyError(conn net.Conn, req *pb.Envelope, code int32, detail string) {
	body, _ := proto.Marshal(&pb.ErrorCode{Code: code, Detail: detail})
	g.reply(conn, req, uint32(code), body)
}

// kick 关掉某条连接（同账号重登 / 逻辑层要求踢人时用）。
func (g *gate) kick(connID string, code int32, prompt string) {
	g.mu.Lock()
	conn := g.conns[connID]
	g.mu.Unlock()
	if conn == nil {
		return
	}
	if body, err := proto.Marshal(&pb.KickOff{Error: &pb.ErrorCode{Code: code, Detail: prompt}, PromptInfo: prompt}); err == nil {
		if env, err := proto.Marshal(&pb.Envelope{MsgType: pb.MsgType_MSG_NOTIFY, Method: "client.kickOff", Body: body}); err == nil {
			if out, err := frame.Encode(frame.Frame{TS: g.nowMs(), Payload: env}); err == nil {
				_, _ = conn.Write(out)
			}
		}
	}
	_ = conn.Close()
}

func main() {
	listen := flag.String("listen", ":9001", "TCP 监听地址")
	flag.Parse()

	g := newGate()
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("监听失败: %v", err)
	}
	log.Printf("gate 监听 %s（TCP，8 字节帧头，P0 骨架）", *listen)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				log.Printf("在线会话 %d", g.sess.Len())
			}
		}
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				log.Println("退出")
				os.Exit(0)
			}
			log.Printf("accept 错误: %v", err)
			continue
		}
		go g.serveConn(conn)
	}
}
