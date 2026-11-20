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
	"meter/gate/internal/hub"
	"meter/gate/internal/logiclink"
	"meter/gate/internal/registry"
	"meter/gate/internal/session"
)

func main() {
	clientAddr := flag.String("client", ":9001", "对外 WebSocket 监听地址（客户端）")
	logicAddr := flag.String("logic", ":9002", "对内 TCP 监听地址（逻辑节点连入）")
	wsPath := flag.String("ws-path", "/ws", "WebSocket 路径")

	// consul：留空 = 不注册（本地开发）。注册后由 consul 负责服务发现与健康检查，
	// gate 每次上报状态同时充当 TTL 心跳。
	consulURL := flag.String("consul", "", "consul HTTP 地址，例如 http://127.0.0.1:8500；留空不注册")
	nodeID := flag.String("node-id", "", "本节点 id（consul 里的唯一名），空则用主机名+端口")
	advertise := flag.String("advertise", "", "对客户端可达的地址（注册到 consul）；空则用 -client 的 host")
	ttl := flag.Duration("consul-ttl", 30*time.Second, "consul TTL 健康检查的过期时间")
	reportEvery := flag.Duration("report-every", 10*time.Second, "状态上报/心跳间隔（必须小于 ttl）")
	flag.Parse()

	startedAt := time.Now()
	nowMs := func() uint32 { return uint32(time.Since(startedAt).Milliseconds()) }

	sess := session.New()
	h := hub.New(sess, nowMs)

	// ---------- consul 注册与状态上报 ----------
	var reg registry.Registry = registry.Nop{}
	if *consulURL != "" {
		addr := advertiseAddr(*advertise, *clientAddr)
		logicPort := portOf(*logicAddr)
		clientPort := portOf(*clientAddr)

		id := *nodeID
		if id == "" {
			// 默认 `gate-<ip>-<对内端口>`：多机部署时 hostname 往往是随机串，IP 才认得出是哪个节点
			id = registry.DefaultServiceID(addr, logicPort)
		}
		reg = registry.NewConsul(*consulURL, id, *ttl)
		log.Printf("注册信息：id=%s addr=%s logic_port=%d client_port=%d", id, addr, logicPort, clientPort)

		regCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := reg.Register(regCtx, registry.Info{
			Name: "gate",
			// **注册的是对内端口**：consul 的消费方是逻辑层，它要连的是 gate 的 internal TCP；
			// 客户端用的 WebSocket 端口放在 Meta 里（client_port），由网关侧配置或运营下发。
			Address: addr,
			Port:    logicPort,
			Tags:    []string{"gate", "internal"},
			Meta: map[string]string{
				"version":     "0.1.0",
				"client_port": strconv.Itoa(clientPort),
				"ws_path":     *wsPath,
			},
		})
		cancel()
		if err != nil {
			log.Printf("consul 注册失败（继续运行，只是发现不到）: %v", err)
			reg = registry.Nop{}
		} else {
			log.Printf("已注册到 consul：%s（TTL %s）", id, *ttl)
		}
	}

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
	go func() { // 状态上报：既打日志，也作为 consul TTL 心跳
		t := time.NewTicker(*reportEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				note := statusLine(h)
				log.Print(note)
				upCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				if err := reg.UpdateStatus(upCtx, note); err != nil {
					log.Printf("consul 状态上报失败: %v", err)
				}
				cancel()
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

// statusLine 是上报给 consul（以及日志）的一行状态。刻意保持人能读：
//   clients=42 logic=1 up=12000 down=8000 miss=3 kicks=1
func statusLine(h *hub.Hub) string {
	s := h.Stats()
	return fmt.Sprintf("clients=%d logic=%d up=%d down=%d miss=%d kicks=%d bad=%d",
		h.ClientCount(), h.LogicCount(), s.ClientFrames, s.ForwardedDown, s.UnknownClient, s.Kicks, s.BadEnvelope)
}

// advertiseAddr 决定注册到 consul 的地址，优先级：
//   ① -advertise 显式给的值
//   ② -client 里写的是具体 IP（如 10.0.0.11:9001）
//   ③ -client 里写的是主机名 → 解析成 IP
//   ④ 都没法用（:9001 / 0.0.0.0:9001）→ 本机第一个非回环 IPv4
//   ⑤ 连网卡都查不到（极端情况）→ 主机名
//
// 为什么不直接用 hostname：多台服务器部署时 hostname 常常是随机串（容器），
// 客户端和运维都需要一个"能连、能看懂"的地址。
func advertiseAddr(explicit, listen string) string {
	if explicit != "" {
		return explicit
	}
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

// portOf 取监听地址的端口（"0.0.0.0:9001" → 9001）。
func portOf(listen string) int {
	_, p, err := net.SplitHostPort(listen)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(p)
	return n
}
