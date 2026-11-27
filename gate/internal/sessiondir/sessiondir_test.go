package sessiondir

import (
	"context"
	"os"
	"testing"
	"time"
)

// 需要一台真 Redis：不设 REDIS_URL 时跳过（本机 CI/开发环境默认没有）。
//
//	REDIS_URL=redis://127.0.0.1:6379/0 go test ./internal/sessiondir/
func TestClaimRefreshRelease(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("未设置 REDIS_URL：跳过需要真 Redis 的目录测试")
	}
	d, err := Open(url, 4, 1000, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	ctx := context.Background()
	user := "u-test-" + time.Now().Format("150405.000000")

	// 首次占位：没有旧主人，seq 从 1 开始
	prev, seq, err := d.Claim(ctx, user, Entry{Node: "n1", Gate: "g1", Conn: "c1", Entity: "e1"})
	if err != nil || prev != nil || seq != 1 {
		t.Fatalf("首次占位: prev=%+v seq=%d err=%v", prev, seq, err)
	}

	// 第二个 gate 占位：拿到旧主人，seq+1
	prev, seq, err = d.Claim(ctx, user, Entry{Node: "n2", Gate: "g2", Conn: "c2", Entity: "e1"})
	if err != nil || prev == nil || seq != 2 {
		t.Fatalf("第二次占位: prev=%+v seq=%d err=%v", prev, seq, err)
	}
	if prev.Node != "n1" || prev.Gate != "g1" || prev.Conn != "c1" {
		t.Fatalf("旧主人不对: %+v", prev)
	}

	// 旧会话既不能续期也不能删掉新会话
	if ok, _ := d.Refresh(ctx, user, "g1", "c1"); ok {
		t.Fatal("旧会话不该续期成功")
	}
	if ok, _ := d.Release(ctx, user, "g1", "c1"); ok {
		t.Fatal("旧会话不该删掉新会话的记录")
	}
	if ok, err := d.Refresh(ctx, user, "g2", "c2"); err != nil || !ok {
		t.Fatalf("新会话应能续期: ok=%v err=%v", ok, err)
	}

	// 新会话自己释放
	if ok, _ := d.Release(ctx, user, "g2", "c2"); !ok {
		t.Fatal("新会话应能释放")
	}
	if prev, seq, _ := d.Claim(ctx, user, Entry{Node: "n3", Gate: "g3", Conn: "c3", Entity: "e1"}); prev != nil || seq != 1 {
		t.Fatalf("释放后应没有旧主人: prev=%+v seq=%d", prev, seq)
	}
}
