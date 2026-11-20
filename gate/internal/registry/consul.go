// 服务注册与状态上报：**直接说 consul 的 HTTP API**，不引 SDK。
//
// 只做三件事（对应服务生命周期的三个时刻）：
//   ① 启动   PUT /v1/agent/service/register      —— 注册服务 + 一个 TTL 健康检查
//   ② 运行中 PUT /v1/agent/check/pass/service:{id}?note=...  —— 心跳 + 把状态写进 note
//   ③ 退出   PUT /v1/agent/service/deregister/{id}          —— 摘掉自己
//
// 为什么状态上报走 TTL check 的 `note`：consul UI 和 `/v1/health/service/gate` 都能直接读到，
// 不需要再引一套 metrics 存储；真正的时序指标应该交给 Prometheus（见 gate/README）。
package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Info 是注册时告诉 consul 的"我是谁"。
type Info struct {
	ID      string            // 唯一名，例如 "gate-1"
	Name    string            // 服务名，例如 "gate"
	Address string            // 对客户端可达的地址
	Port    int               // 对外 WebSocket 端口
	Tags    []string          // ["gtag", "ws"]
	Meta    map[string]string // 版本、区服、对内端口等
}

// Registry 抽象出来，方便单测替换成假的。
type Registry interface {
	Register(ctx context.Context, info Info) error
	// UpdateStatus 每次调用都同时充当"我还活着"的心跳。
	UpdateStatus(ctx context.Context, note string) error
	Deregister(ctx context.Context) error
}

// Nop 是未配置 consul 时用的空实现（本地开发）。
type Nop struct{}

func (Nop) Register(context.Context, Info) error   { return nil }
func (Nop) UpdateStatus(context.Context, string) error { return nil }
func (Nop) Deregister(context.Context) error       { return nil }

// Consul 是 HTTP 实现。baseURL 形如 "http://127.0.0.1:8500"。
type Consul struct {
	baseURL string
	http    *http.Client
	serviceID string
	ttl     time.Duration
}

func NewConsul(baseURL, serviceID string, ttl time.Duration) *Consul {
	return &Consul{
		baseURL:   strings.TrimRight(baseURL, "/"),
		http:      &http.Client{Timeout: 3 * time.Second},
		serviceID: serviceID,
		ttl:       ttl,
	}
}

// checkID 是 consul 里这条 TTL 检查的 id（"service:<serviceID>" 是社区惯用写法）。
func (c *Consul) checkID() string { return "service:" + c.serviceID }

func (c *Consul) Register(ctx context.Context, info Info) error {
	body := map[string]any{
		"ID":      c.serviceID,
		"Name":    info.Name,
		"Address": info.Address,
		"Port":    info.Port,
		"Tags":    info.Tags,
		"Meta":    info.Meta,
		"Check": map[string]any{
			"CheckID":                         c.checkID(),
			"Name":                            "gate ttl",
			"TTL":                             c.ttl.String(),
			"DeregisterCriticalServiceAfter": "1m",
		},
	}
	return c.putJSON(ctx, "/v1/agent/service/register", body)
}

func (c *Consul) UpdateStatus(ctx context.Context, note string) error {
	// note 会显示在 consul UI 与 /v1/health 输出里；截断一下，避免超长
	if len(note) > 200 {
		note = note[:200]
	}
	path := fmt.Sprintf("/v1/agent/check/pass/%s?note=%s", url.PathEscape(c.checkID()), url.QueryEscape(note))
	return c.put(ctx, path, nil)
}

func (c *Consul) Deregister(ctx context.Context) error {
	return c.put(ctx, "/v1/agent/service/deregister/"+url.PathEscape(c.serviceID), nil)
}

func (c *Consul) putJSON(ctx context.Context, path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.put(ctx, path, b)
}

func (c *Consul) put(ctx context.Context, path string, body []byte) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+path, r)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("consul %s: %s %s", path, resp.Status, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// DefaultServiceID 生成默认服务 id：`gate-<地址>-<端口>`，例如 `gate-10.0.0.11-9001`。
//
// 为什么带地址而不是主机名：gate 会部署在多台机器上，容器/云主机的 hostname 往往是随机串
// （滚动发布会每次换一个），而 IP 至少在同一网段内唯一、且运维一眼能看懂是哪个节点。
// 显式传 `-node-id` 时以它为准。
func DefaultServiceID(addr string, port int) string {
	return "gate-" + SanitizeID(addr) + "-" + strconv.Itoa(port)
}

// SanitizeID 把地址里不适合放进 consul id / URL 路径的字符换掉：
// IPv6 的冒号、方括号，以及空白。
func SanitizeID(addr string) string {
	r := strings.NewReplacer(":", "-", "[", "", "]", "", " ", "")
	return r.Replace(addr)
}
