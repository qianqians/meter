// gate 进程：**两个监听端口**。
//
//	对外 WebSocket（客户端）       -client :9001
//	对内 TCP      （逻辑节点连入）   -logic  :9002
//
// 两个端口跑同一套东西：8 字节帧头（internal/frame）+ Envelope + hub 路由。
// 差别只在"字节怎么到对端"：客户端走 WebSocket（小游戏/H5 只能 new WebSocket），
// 逻辑层走裸 TCP（内网、长连接、无浏览器限制）。
//
// 为什么逻辑层是**它连进来**而不是 gate 去连：gate 是对外的一层，扩容/滚动发布时
// 不该要求逻辑层改配置；consul 里注册的是 gate，逻辑层按需连过来即可。
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"meter/gate/internal/clientgate"
	"meter/gate/internal/hub"
	"meter/gate/internal/logiclink"
	"meter/gate/internal/session"
)

func main() {
	clientAddr := flag.String("client", ":9001", "对外 WebSocket 监听地址（客户端）")
	logicAddr := flag.String("logic", ":9002", "对内 TCP 监听地址（逻辑节点连入）")
	wsPath := flag.String("ws-path", "/ws", "WebSocket 路径")
	flag.Parse()

	startedAt := time.Now()
	nowMs := func() uint32 { return uint32(time.Since(startedAt).Milliseconds()) }

	sess := session.New()
	h := hub.New(sess, nowMs)

	// ---------- 对外：WebSocket ----------
	ws := clientgate.New(h, *wsPath, nowMs)
	httpSrv := &http.Server{Addr: *clientAddr, Handler: ws.Handler()}

	// ---------- 对内：TCP ----------
	logicLn, err := net.Listen("tcp", *logicAddr)
	if err != nil {
		log.Fatalf("逻辑端口监听失败: %v", err)
	}
	ll := logiclink.New(h, nowMs)

	log.Printf("gate 启动：客户端 WS %s%s ｜ 逻辑层 TCP %s", *clientAddr, *wsPath, *logicAddr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("WS 监听退出: %v", err)
		}
	}()
	go func() {
		if err := ll.Serve(logicLn); err != nil {
			if ctx.Err() == nil {
				log.Printf("逻辑监听退出: %v", err)
			}
		}
	}()
	go func() { // 每 30 秒打一次规模，压测时用
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s := h.Stats()
				log.Printf("在线 %d ｜ 上行帧 %d 下行帧 %d ｜ 未命中连接 %d ｜ 踢人 %d",
					h.ClientCount(), s.ClientFrames, s.LogicFrames, s.UnknownClient, s.Kicks)
			}
		}
	}()

	<-ctx.Done()
	log.Println("收到退出信号，停止监听…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	_ = logicLn.Close()
	log.Println("退出")
	os.Exit(0)
}
