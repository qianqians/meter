package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "gate.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDefaultIsUsable(t *testing.T) {
	c := Default()
	if err := c.Validate(); err != nil {
		t.Fatalf("默认配置应通过校验: %v", err)
	}
	if c.Listen.LogicPort == c.Listen.ClientPort {
		t.Fatal("默认对内/对外端口不应相同")
	}
	if c.Consul.Enabled {
		t.Fatal("默认不应启用 consul（本地开发）")
	}
}

func TestLoadEmptyPathGivesDefaults(t *testing.T) {
	c, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen.ClientPort != 9001 || c.Listen.LogicPort != 9002 {
		t.Fatalf("默认端口不对: %+v", c.Listen)
	}
}

func TestLoadOverlaysAndKeepsDefaults(t *testing.T) {
	p := write(t, `{
		"listen": { "client_port": 8080, "logic_port": 8081, "tls_cert_file": "" },
		"consul": { "enabled": false, "url": "http://10.0.0.5:8500" },
		"log": { "dir": "/var/log/gate" }
	}`)
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen.ClientPort != 8080 || c.Listen.LogicPort != 8081 {
		t.Fatalf("覆盖失败: %+v", c.Listen)
	}
	// 没写的字段保持默认
	if c.Listen.WSPath != "/ws" || c.Listen.MaxFrameBytes != 1<<20 {
		t.Fatalf("未写字段应保持默认: %+v", c.Listen)
	}
	if c.Consul.TTLS != 30 || c.Consul.ReportIntervalS != 10 {
		t.Fatalf("consul 默认值丢了: %+v", c.Consul)
	}
	if c.Log.Dir != "/var/log/gate" || c.Log.FileName != "gate-%Y%m%d.log" {
		t.Fatalf("日志配置不对: %+v", c.Log)
	}
}

func TestCommentKeysAreStripped(t *testing.T) {
	p := write(t, `{
		"//": "这是整段注释",
		"listen": {
			"//client": "对外端口",
			"client_port": 7001,
			"logic_port": 7002
		}
	}`)
	c, err := Load(p)
	if err != nil {
		t.Fatalf("带注释的配置应能解析: %v", err)
	}
	if c.Listen.ClientPort != 7001 {
		t.Fatalf("解析结果不对: %+v", c.Listen)
	}
}

func TestRejectsSamePort(t *testing.T) {
	p := write(t, `{"listen": {"client_host": "0.0.0.0", "client_port": 9000,
	                          "logic_host": "127.0.0.1", "logic_port": 9000}}`)
	// 不同 host 同端口是合法的
	if _, err := Load(p); err != nil {
		t.Fatalf("不同地址同端口应允许: %v", err)
	}
	p2 := write(t, `{"listen": {"client_host": "0.0.0.0", "client_port": 9000,
	                          "logic_host": "0.0.0.0", "logic_port": 9000}}`)
	if _, err := Load(p2); err == nil {
		t.Fatal("同地址同端口应被拒绝")
	}
}

func TestRejectsHalfTLS(t *testing.T) {
	p := write(t, `{"listen": {"tls_cert_file": "/tmp/a.pem"}}`)
	if _, err := Load(p); err == nil {
		t.Fatal("只给证书不给私钥应被拒绝")
	}
}

func TestRejectsReportIntervalNotLessThanTTL(t *testing.T) {
	p := write(t, `{"consul": {"enabled": true, "url": "http://x", "ttl_s": 10, "report_interval_s": 10}}`)
	_, err := Load(p)
	if err == nil || !strings.Contains(err.Error(), "必须小于") {
		t.Fatalf("应拒绝 report_interval >= ttl，实际: %v", err)
	}
}

func TestZeroPortFallsBackToDefault(t *testing.T) {
	p := write(t, `{"listen": {"client_port": 0, "logic_port": 0}}`)
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen.ClientPort != 9001 || c.Listen.LogicPort != 9002 {
		t.Fatalf("端口 0 应回落到默认: %+v", c.Listen)
	}
}

func TestHelpers(t *testing.T) {
	c := Default()
	c.Listen.ClientHost, c.Listen.ClientPort = "127.0.0.1", 7001
	c.Listen.LogicHost, c.Listen.LogicPort = "0.0.0.0", 7002
	if got := c.ClientAddr(); got != "127.0.0.1:7001" {
		t.Fatalf("ClientAddr=%s", got)
	}
	if got := c.LogicAddr(); got != "0.0.0.0:7002" {
		t.Fatalf("LogicAddr=%s", got)
	}
	if c.ConsulTTL() != 30*time.Second || c.ReportInterval() != 10*time.Second || c.ReadTimeout() != 90*time.Second {
		t.Fatal("时长换算不对")
	}
}

func TestBadJSONIsReported(t *testing.T) {
	p := write(t, `{oops}`)
	if _, err := Load(p); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
}

func TestDumpRoundTrips(t *testing.T) {
	c := Default()
	c.Listen.ClientPort = 7001
	c.Listen.LogicPort = 7002
	c.Consul.Enabled = true
	c.Consul.TTLS = 60
	c.Consul.ReportIntervalS = 15
	c.Redis.MQURL = "redis://10.0.0.9:6379/3"
	c.Log.Dir = "/var/log/gate"

	out, err := c.Dump()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `\u003e`) {
		t.Fatal("Dump 不应做 HTML 转义（配置要能直接读）")
	}
	p := write(t, string(out))
	back, err := Load(p)
	if err != nil {
		t.Fatalf("Dump 出来的配置应能被自己读回: %v", err)
	}
	if back.Listen.ClientPort != 7001 || back.Listen.LogicPort != 7002 ||
		!back.Consul.Enabled || back.Consul.TTLS != 60 || back.Consul.ReportIntervalS != 15 ||
		back.Redis.MQURL != "redis://10.0.0.9:6379/3" || back.Log.Dir != "/var/log/gate" {
		t.Fatalf("往返后配置变了: %+v", back)
	}
}

func TestDumpHasComments(t *testing.T) {
	out, err := Default().Dump()
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"//tls"`) || !strings.Contains(s, `"//ttl_s"`) {
		t.Fatal("关键字段的说明应出现在 Dump 输出里（配置自带文档）")
	}
}
