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
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"meter/gate/internal/clientgate"
	"meter/gate/internal/config"
	"meter/gate/internal/hub"
	"meter/gate/internal/logiclink"
	"meter/gate/internal/registry"
	"meter/gate/internal/session"
)

func main() {
	cfgPath := flag.String("config", "", "配置文件（JSON）；留空则全用默认值")
	dumpConfig := flag.Bool("dump-config", false, "把当前生效的配置（含注释与默认值）打印到 stdout 后退出；可配合 -config 打开已有配置")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	if *dumpConfig {
		out, err := cfg.Dump()
		if err != nil {
			log.Fatalf("生成配置失败: %v", err)
		}
		fmt.Println(string(out))
		return
	}
	log.Printf("配置：%s（对内 %s ｜ 对外 %s%s ｜ consul %v）",
		orDefault(*cfgPath, "<默认>"), cfg.LogicAddr(), cfg.ClientAddr(), cfg.Listen.WSPath, cfg.Consul.Enabled)

	startedAt := time.Now()
	nowMs := func() uint32 { return uint32(time.Since(startedAt).Milliseconds()) }

	sess := session.New()
	h := hub.New(sess, nowMs)

	// ---------- consul 注册与状态上报 ----------
	var reg registry.Registry = registry.Nop{}
	if cfg.Consul.Enabled {
		addr := advertiseAddr(cfg.ClientAddr())
		logicPort := cfg.Listen.LogicPort
		clientPort := cfg.Listen.ClientPort

		id := cfg.Node.ID
		if id == "" {
			// 默认 `gate-<ip>-<对内端口>`：多机部署时 hostname 往往是随机串，IP 才认得出是哪个节点
			id = registry.DefaultServiceID(addr, logicPort)
		}
		reg = registry.NewConsul(cfg.Consul.URL, id, cfg.ConsulTTL())

		// consul 用 TTL check：gate 自己 push 心跳 + 状态（见 registry.Register 的注释）
		log.Printf("注册信息：id=%s addr=%s logic_port=%d client_port=%d", id, addr, logicPort, clientPort)

		regCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = reg.Register(regCtx, registry.Info{
			Name: "gate",
			// **注册的是对内端口**：consul 的消费方是逻辑层，它要连的是 gate 的 internal TCP；
			// 客户端用的 WebSocket 端口放在 Meta 里（client_port），由网关侧配置或运营下发。
			Address: addr,
			Port:    logicPort,
			Tags:    cfg.Consul.Tags,
			Meta: map[string]string{
				"version":     "0.1.0",
				"client_port": strconv.Itoa(clientPort),
				"ws_path":     cfg.Listen.WSPath,
			},
		})
		cancel()
		if err != nil {
			log.Printf("consul 注册失败（继续运行，只是发现不到）: %v", err)
			reg = registry.Nop{}
		} else {
			log.Printf("已注册到 consul：%s（TTL %s）", id, cfg.ConsulTTL())
		}
	}

	// ---------- 对外：WebSocket ----------
	ws := clientgate.New(h, cfg.Listen.WSPath, nowMs)
	httpSrv := &http.Server{Addr: cfg.ClientAddr(), Handler: ws.Handler()}

	// ---------- 对内：TCP ----------
	logicLn, err := net.Listen("tcp", cfg.LogicAddr())
	if err != nil {
		log.Fatalf("逻辑端口监听失败: %v", err)
	}
	ll := logiclink.New(h, nowMs)

	log.Printf("gate 启动：客户端 WS %s%s ｜ 逻辑层 TCP %s", cfg.ClientAddr(), cfg.Listen.WSPath, cfg.LogicAddr())

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
	// ---------- 状态上报：每 N 秒 push 一次（同时是 consul 的 TTL 心跳） ----------
	//
	// 两条纪律：
	//   ① **注册完立刻报一次**——TTL 从注册那刻开始计时，等一个周期再报会让节点短暂 critical；
	//   ② 上报间隔必须小于 TTL（config.Validate 已强制），且单次上报带 3s 超时，
	//      避免 consul 慢拖住上报线程。
	go func() {
		t := time.NewTicker(cfg.ReportInterval())
		defer t.Stop()

		prev := h.Stats()
		prevAt := time.Now()
		report := func() {
			s := h.Stats()
			now := time.Now()
			secs := now.Sub(prevAt).Seconds()
			if secs <= 0 {
				secs = 1
			}
			upRate := float64(s.ClientFrames-prev.ClientFrames) / secs
			downRate := float64(s.ForwardedDown-prev.ForwardedDown) / secs
			prev, prevAt = s, now

			note := statusLine(h, upRate, downRate)
			log.Print(note)
			ctx2, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if err := reg.UpdateStatus(ctx2, note); err != nil {
				log.Printf("consul 状态上报失败: %v", err)
			}
			cancel()
		}

		report() // ① 立即报一次
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				report()
			}
		}
	}()

	<-ctx.Done()
	log.Println("收到退出信号，停止监听…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	_ = logicLn.Close()
	// 主动摘掉自己：否则 consul 要等 TTL 过期才把节点标记为 critical
	if err := reg.Deregister(shutdownCtx); err != nil {
		log.Printf("consul 注销失败: %v", err)
	}
	log.Println("退出")
	os.Exit(0)
}

// statusLine 是上报给 consul（以及日志）的一行状态，刻意保持人能读：
//
//	clients=42 logic=1 up=812/s down=640/s miss=3 kicks=1 bad=0
//
// 给的是**速率**而不是累计计数：consul UI 上看到 "up=812/s" 才知道现在忙不忙，
// 累计值只能看出"跑了多久"。
func statusLine(h *hub.Hub, upRate, downRate float64) string {
	s := h.Stats()
	return fmt.Sprintf("clients=%d logic=%d up=%.0f/s down=%.0f/s miss=%d kicks=%d bad=%d",
		h.ClientCount(), h.LogicCount(), upRate, downRate, s.UnknownClient, s.Kicks, s.BadEnvelope)
}

// advertiseAddr 决定注册到 consul 的地址，优先级：
//
//	① listen.client_host 写的是具体 IP（如 10.0.0.11:9001）
//	② 写的是主机名 → 解析成 IP
//	③ 没法用（:9001 / 0.0.0.0:9001）→ 本机第一个非回环 IPv4（私网优先）
//	④ 连网卡都查不到（极端情况）→ 主机名
//
// 为什么不直接用 hostname：多台服务器部署时 hostname 常常是随机串（容器），
// 逻辑层与运维都需要一个"能连、能看懂"的地址。
func advertiseAddr(listen string) string {
	if host, _, err := net.SplitHostPort(listen); err == nil && host != "" {
		switch {
		case host == "0.0.0.0" || host == "::":
			// 退到本机 IP
		case net.ParseIP(host) != nil:
			return host
		default:
			if ips, err := net.LookupHost(host); err == nil && len(ips) > 0 {
				return ips[0]
			}
		}
	}
	if ip := localIPv4(); ip != "" {
		return ip
	}
	host, _ := os.Hostname()
	return host
}

// localIPv4 返回本机第一个非回环 IPv4（优先私网地址）。
func localIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() {
				continue
			}
			if ip4.IsPrivate() {
				return ip4.String() // 私网优先：内网部署最常见
			}
			if fallback == "" {
				fallback = ip4.String()
			}
		}
	}
	return fallback
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
