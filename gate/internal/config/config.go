// 配置：JSON 文件。**本文件的结构体就是配置的唯一文档**——
// 不再维护一份 example 文件：想看当前生效的配置跑 `gate -dump-config`，
// 想看某个字段的含义看下面结构体的字段注释。
//
// 三条原则：
//  1. **每个字段都有可用默认值**，缺省时不报错（除了明显矛盾的组合，见 Validate）。
//  2. **允许注释**：标准 JSON 不支持注释，所以约定"键名以 `//` 开头即视为注释"，
//     解析时直接跳过——Dump 输出的 JSON 就带这种键，配置自带说明。
//  3. **默认值只写在这里一份**（Default()），没有第二份会漂移的样例。
package config

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

type Config struct {
	Node   Node   `json:"node"`
	Listen Listen `json:"listen"`
	Consul Consul `json:"consul"`
	Redis  Redis  `json:"redis"`
	NATS   NATS   `json:"nats"`
	Log    Log    `json:"log"`
}

type Node struct {
	ID       string `json:"id"`       // 空 = 由探测到的本机 IP + 对内端口推导
	Hostname string `json:"hostname"` // 仅日志展示
}

type Listen struct {
	LogicHost string `json:"logic_host"`
	LogicPort int    `json:"logic_port"`

	ClientHost string `json:"client_host"`
	ClientPort int    `json:"client_port"`
	WSPath     string `json:"ws_path"`

	TLSCertFile string `json:"tls_cert_file"`
	TLSKeyFile  string `json:"tls_key_file"`

	MaxFrameBytes int `json:"max_frame_bytes"`
	ReadTimeoutS  int `json:"read_timeout_s"`
}

type Consul struct {
	Enabled         bool     `json:"enabled"`
	URL             string   `json:"url"`
	TTLS            int      `json:"ttl_s"`
	ReportIntervalS int      `json:"report_interval_s"`
	Tags            []string `json:"tags"`
}

type Redis struct {
	CacheURL      string `json:"cache_url"` // 只做缓存；消息队列已改用 NATS（见 NATS 段）
	PoolSize      int    `json:"pool_size"`
	DialTimeoutMs int    `json:"dial_timeout_ms"`
}

type NATS struct {
	Enabled bool   `json:"enabled"` // 消息队列层（旁路）：核心 NATS，无持久化；false 时 url 忽略
	URL     string `json:"url"`     // 服务器→服务器 entity_{id}_logic_mq；服务器→gate entity_{id}_gate_mq
}

type Log struct {
	Dir       string `json:"dir"`
	FileName  string `json:"file_name"` // 支持 %Y%m%d%H；空 = 只打 stderr
	Level     string `json:"level"`
	MaxSizeMB int    `json:"max_size_mb"`
	KeepDays  int    `json:"keep_days"`
}

// Default 返回所有默认值。**这里是默认值的唯一来源。**
func Default() Config {
	return Config{
		Node: Node{},
		Listen: Listen{
			LogicHost:     "0.0.0.0",
			LogicPort:     9002,
			ClientHost:    "0.0.0.0",
			ClientPort:    9001,
			WSPath:        "/ws",
			MaxFrameBytes: 1 << 20,
			ReadTimeoutS:  90,
		},
		Consul: Consul{
			Enabled:         false, // 本地开发默认不注册
			URL:             "http://127.0.0.1:8500",
			TTLS:            30,
			ReportIntervalS: 10,
			Tags:            []string{"gate", "internal"},
		},
		Redis: Redis{
			CacheURL:      "redis://127.0.0.1:6379/0",
			PoolSize:      16,
			DialTimeoutMs: 3000,
		},
		NATS: NATS{
			Enabled: false, // 本地默认不开：TCP 直连层已够用，MQ 是旁路
			URL:     "nats://127.0.0.1:4222",
		},
		Log: Log{
			Dir:       "./logs",
			FileName:  "gate-%Y%m%d.log",
			Level:     "info",
			MaxSizeMB: 256,
			KeepDays:  7,
		},
	}
}

// Load 读 JSON 并叠加到默认值上：文件里没写的字段保持默认。
func Load(path string) (Config, error) {
	cfg := Default()
	if path == "" {
		return cfg, cfg.Validate()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("读配置 %s: %w", path, err)
	}
	clean, err := stripComments(raw)
	if err != nil {
		return cfg, fmt.Errorf("配置 %s 不是合法 JSON: %w", path, err)
	}
	if err := json.Unmarshal(clean, &cfg); err != nil {
		return cfg, fmt.Errorf("解析配置 %s: %w", path, err)
	}
	// JSON 里写 0 会覆盖默认值，对"0 表示用默认"的字段要在 Validate/应用时回填
	cfg.applyZeroDefaults()
	return cfg, cfg.Validate()
}

// stripComments 去掉键名以 "//" 开头的字段（我们用这种写法在 JSON 里放注释）。
// 做法是解成 map 递归删，而不是正则——正则处理嵌套/字符串里的 "//" 会出错。
func stripComments(raw []byte) ([]byte, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return json.Marshal(dropCommentKeys(v))
}

func dropCommentKeys(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if strings.HasPrefix(k, "//") {
				continue
			}
			out[k] = dropCommentKeys(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = dropCommentKeys(val)
		}
		return out
	default:
		return v
	}
}

// applyZeroDefaults 把"0 表示用默认"的字段回填。
func (c *Config) applyZeroDefaults() {
	d := Default()
	if c.Listen.LogicPort == 0 {
		c.Listen.LogicPort = d.Listen.LogicPort
	}
	if c.Listen.ClientPort == 0 {
		c.Listen.ClientPort = d.Listen.ClientPort
	}
	if c.Listen.WSPath == "" {
		c.Listen.WSPath = d.Listen.WSPath
	}
	if c.Listen.MaxFrameBytes == 0 {
		c.Listen.MaxFrameBytes = d.Listen.MaxFrameBytes
	}
	if c.Listen.ReadTimeoutS == 0 {
		c.Listen.ReadTimeoutS = d.Listen.ReadTimeoutS
	}
	if c.Consul.URL == "" {
		c.Consul.URL = d.Consul.URL
	}
	if c.Consul.TTLS == 0 {
		c.Consul.TTLS = d.Consul.TTLS
	}
	if c.Consul.ReportIntervalS == 0 {
		c.Consul.ReportIntervalS = d.Consul.ReportIntervalS
	}
	if len(c.Consul.Tags) == 0 {
		c.Consul.Tags = d.Consul.Tags
	}
	if c.Redis.CacheURL == "" {
		c.Redis.CacheURL = d.Redis.CacheURL
	}
	if c.Redis.PoolSize == 0 {
		c.Redis.PoolSize = d.Redis.PoolSize
	}
	if c.Redis.DialTimeoutMs == 0 {
		c.Redis.DialTimeoutMs = d.Redis.DialTimeoutMs
	}
	if c.NATS.URL == "" {
		c.NATS.URL = d.NATS.URL
	}
	if c.Log.Dir == "" {
		c.Log.Dir = d.Log.Dir
	}
	if c.Log.Level == "" {
		c.Log.Level = d.Log.Level
	}
}

// Validate 只拦"明显矛盾/不可用"的配置，不做风格检查。
func (c Config) Validate() error {
	if c.Listen.LogicPort == c.Listen.ClientPort && sameHost(c.Listen.LogicHost, c.Listen.ClientHost) {
		return fmt.Errorf("对内与对外端口相同（%d）且绑定同一地址，会互相抢占", c.Listen.LogicPort)
	}
	if c.Listen.LogicPort < 0 || c.Listen.LogicPort > 65535 || c.Listen.ClientPort < 0 || c.Listen.ClientPort > 65535 {
		return fmt.Errorf("端口越界: logic=%d client=%d", c.Listen.LogicPort, c.Listen.ClientPort)
	}
	if (c.Listen.TLSCertFile == "") != (c.Listen.TLSKeyFile == "") {
		return fmt.Errorf("tls_cert_file 与 tls_key_file 必须同时给或同时留空")
	}
	if _, err := os.Stat(c.Listen.TLSCertFile); err != nil && c.Listen.TLSCertFile != "" {
		return fmt.Errorf("证书文件读不到: %s", c.Listen.TLSCertFile)
	}
	if c.Consul.Enabled {
		if c.Consul.URL == "" {
			return fmt.Errorf("consul.enabled=true 但 consul.url 为空")
		}
		if c.Consul.ReportIntervalS >= c.Consul.TTLS {
			return fmt.Errorf("consul.report_interval_s(%ds) 必须小于 ttl_s(%ds)，否则节点会一直 critical",
				c.Consul.ReportIntervalS, c.Consul.TTLS)
		}
	}
	if c.Listen.MaxFrameBytes > 1<<24 {
		return fmt.Errorf("max_frame_bytes 超过帧头 u24 能表达的 16 MB")
	}
	return nil
}

// LogicAddr / ClientAddr 拼出监听地址（用于 net.Listen）。
func (c Config) LogicAddr() string {
	return net.JoinHostPort(c.Listen.LogicHost, itoa(c.Listen.LogicPort))
}
func (c Config) ClientAddr() string {
	return net.JoinHostPort(c.Listen.ClientHost, itoa(c.Listen.ClientPort))
}

func (c Config) ConsulTTL() time.Duration {
	return time.Duration(c.Consul.TTLS) * time.Second
}
func (c Config) ReportInterval() time.Duration {
	return time.Duration(c.Consul.ReportIntervalS) * time.Second
}
func (c Config) ReadTimeout() time.Duration {
	return time.Duration(c.Listen.ReadTimeoutS) * time.Second
}

func sameHost(a, b string) bool { return a == b || (isAny(a) && isAny(b)) }
func isAny(h string) bool       { return h == "" || h == "0.0.0.0" || h == "::" }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// Dump 把配置序列化成带注释的 JSON（键名以 `//` 开头），用于 `-dump-config` 与首次生成。
// 注释不是手写常量，而是和结构体定义放在一起维护的少量说明，避免两份文档漂移。
func (c Config) Dump() ([]byte, error) {
	// 用 map 而不是 Config 直出，是为了插入注释键（encoding/json 不会序列化没有 tag 的注释）。
	out := map[string]any{
		"//": "由 gate -dump-config 生成；键名以 // 开头的字段解析时会被忽略。每项都有默认值，只需要改要动的。",
		"node": map[string]any{
			"id":       c.Node.ID,
			"hostname": c.Node.Hostname,
			"//id":     "留空则由探测到的本机 IP + listen.logic_port 推导成 gate-<ip>-<对内端口>",
		},
		"listen": map[string]any{
			"logic_host":      c.Listen.LogicHost,
			"logic_port":      c.Listen.LogicPort,
			"client_host":     c.Listen.ClientHost,
			"client_port":     c.Listen.ClientPort,
			"ws_path":         c.Listen.WSPath,
			"tls_cert_file":   c.Listen.TLSCertFile,
			"tls_key_file":    c.Listen.TLSKeyFile,
			"max_frame_bytes": c.Listen.MaxFrameBytes,
			"read_timeout_s":  c.Listen.ReadTimeoutS,
			"//tls":           "证书与私钥必须同时给或同时留空；留空 = 明文 WS",
			"//logic":         "对内 TCP：逻辑节点连入",
			"//client":        "对外 WebSocket：客户端连入",
		},
		"consul": map[string]any{
			"enabled":             c.Consul.Enabled,
			"url":                 c.Consul.URL,
			"ttl_s":               c.Consul.TTLS,
			"report_interval_s":   c.Consul.ReportIntervalS,
			"tags":                c.Consul.Tags,
			"//ttl_s":             "必须大于 report_interval_s，否则启动即报错（TTL 由 gate 主动 push）",
			"//report_interval_s": "每多少秒向 consul 上报一次状态（同时充当 TTL 心跳）",
		},
		"redis": map[string]any{
			"cache_url":       c.Redis.CacheURL,
			"pool_size":       c.Redis.PoolSize,
			"dial_timeout_ms": c.Redis.DialTimeoutMs,
			"//cache_url":     "缓存：会话热点数据、限流计数（消息队列已改用 nats 段）",
		},
		"nats": map[string]any{
			"enabled":   c.NATS.Enabled,
			"url":       c.NATS.URL,
			"//url":     "核心 NATS（无持久化）：server↔server 走 entity_{id}_logic_mq，server→gate 走 entity_{id}_gate_mq",
			"//enabled": "旁路开关：false 时 gate 不连 NATS，TCP 直连层不受影响",
		},
		"log": map[string]any{
			"dir":         c.Log.Dir,
			"file_name":   c.Log.FileName,
			"level":       c.Log.Level,
			"max_size_mb": c.Log.MaxSizeMB,
			"keep_days":   c.Log.KeepDays,
			"//file_name": "支持 %Y%m%d%H；留空则只输出到 stderr",
		},
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // 否则配置里的 < > & 会被转成 \u003c 这类形式，人读不了
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return nil, err
	}
	return []byte(buf.String()), nil
}
