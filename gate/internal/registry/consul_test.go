package registry

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeConsul 记录收到的请求，用来断言"gate 到底跟 consul 说了什么"。
type fakeConsul struct {
	mu      sync.Mutex
	paths   []string
	queries []string
	bodies  []string
}

func (f *fakeConsul) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.queries = append(f.queries, r.URL.RawQuery)
		f.bodies = append(f.bodies, string(b))
		f.mu.Unlock()
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
}

func (f *fakeConsul) last() (path, query, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.paths)
	if n == 0 {
		return "", "", ""
	}
	return f.paths[n-1], f.queries[n-1], f.bodies[n-1]
}

func (f *fakeConsul) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.paths)
}

func newFake(t *testing.T) (*fakeConsul, *Consul, func()) {
	t.Helper()
	fc := &fakeConsul{}
	srv := httptest.NewServer(fc.handler())
	c := NewConsul(srv.URL, "gate-1", 30*time.Second)
	return fc, c, srv.Close
}

func TestRegisterSendsServiceAndTTLCheck(t *testing.T) {
	fc, c, done := newFake(t)
	defer done()

	err := c.Register(context.Background(), Info{
		Name: "gate", Address: "10.0.0.1", Port: 9001,
		Tags: []string{"ws"},
		Meta: map[string]string{"version": "0.1.0", "logic_port": "9002"},
	})
	if err != nil {
		t.Fatal(err)
	}

	path, _, body := fc.last()
	if path != "/v1/agent/service/register" {
		t.Fatalf("路径不对: %s", path)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("注册体不是 JSON: %s", body)
	}
	if got["ID"] != "gate-1" || got["Name"] != "gate" || got["Port"].(float64) != 9001 {
		t.Fatalf("注册字段不对: %+v", got)
	}
	check, _ := got["Check"].(map[string]any)
	if check["CheckID"] != "service:gate-1" || check["TTL"] != "30s" {
		t.Fatalf("TTL 检查不对: %+v", check)
	}
	if _, hasHTTP := check["HTTP"]; hasHTTP {
		t.Fatal("注册体里不应出现 HTTP check（gate 主动 push，不靠 consul 反向拨入）")
	}
	meta, _ := got["Meta"].(map[string]any)
	if meta["logic_port"] != "9002" {
		t.Fatalf("Meta 未带上: %+v", meta)
	}
}

func TestUpdateStatusGoesToPassEndpointWithNote(t *testing.T) {
	fc, c, done := newFake(t)
	defer done()

	if err := c.UpdateStatus(context.Background(), "clients=42 up=100 down=90"); err != nil {
		t.Fatal(err)
	}
	path, query, _ := fc.last()
	if path != "/v1/agent/check/pass/service:gate-1" {
		t.Fatalf("路径不对: %s", path)
	}
	if !strings.Contains(query, "clients%3D42") && !strings.Contains(query, "clients=42") {
		t.Fatalf("note 没有带上状态: %s", query)
	}
}

func TestUpdateStatusTruncatesLongNote(t *testing.T) {
	fc, c, done := newFake(t)
	defer done()

	if err := c.UpdateStatus(context.Background(), strings.Repeat("x", 500)); err != nil {
		t.Fatal(err)
	}
	_, query, _ := fc.last()
	// 截断到 200 字符（url 编码后长度会翻倍，这里只验证没有原样 500 个 x）
	if strings.Count(query, "x") > 260 {
		t.Fatalf("note 未截断: 长度 %d", len(query))
	}
}

func TestDeregister(t *testing.T) {
	fc, c, done := newFake(t)
	defer done()

	if err := c.Deregister(context.Background()); err != nil {
		t.Fatal(err)
	}
	path, _, _ := fc.last()
	if path != "/v1/agent/service/deregister/gate-1" {
		t.Fatalf("路径不对: %s", path)
	}
}

func TestNon2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()

	c := NewConsul(srv.URL, "gate-1", 30*time.Second)
	if err := c.Register(context.Background(), Info{Name: "gate"}); err == nil {
		t.Fatal("500 应返回错误")
	}
}

func TestNopIsInert(t *testing.T) {
	var r Registry = Nop{}
	if err := r.Register(context.Background(), Info{}); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateStatus(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	if err := r.Deregister(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestDefaultServiceID(t *testing.T) {
	cases := []struct {
		addr string
		port int
		want string
	}{
		{"10.0.0.11", 9001, "gate-10.0.0.11-9001"},
		{"127.0.0.1", 19211, "gate-127.0.0.1-19211"},
		{"fe80::1", 9001, "gate-fe80--1-9001"}, // IPv6 的冒号被换掉
		{"[::1]", 9001, "gate---1-9001"},       // 方括号去掉，冒号换 -
	}
	for _, c := range cases {
		if got := DefaultServiceID(c.addr, c.port); got != c.want {
			t.Fatalf("DefaultServiceID(%q,%d)=%q，期望 %q", c.addr, c.port, got, c.want)
		}
	}
	// 生成的 id 不应该含冒号（否则 consul 路径与 grep 都难受）
	if strings.ContainsAny(DefaultServiceID("fe80::1", 9001), ":") {
		t.Fatal("id 里不应残留冒号")
	}
}
